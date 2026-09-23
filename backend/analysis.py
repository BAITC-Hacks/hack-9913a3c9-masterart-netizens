"""Сборка единой модели фактов: метрики → роли → приоритет → кластеры → analysis.json.

CSV-файлы и просмотрщик читают один и тот же результат этой функции, поэтому
карточка счёта и выгрузки не расходятся.
"""

from __future__ import annotations

from . import policy
from .clusters import assign_clusters, summarize
from .fmt import clip_text, kzt_value
from .io import Dataset
from .metrics import compute_metrics
from .priority import compute_priority, rank, why_text
from .roles import evaluate, evidence_text, next_request, select, warnings_for

SCHEMA_VERSION = "finance-workbench/v1"

TEMPORAL_KEYS = (
    "static_seed_count",
    "strict_seed_count",
    "same_day_seed_count",
    "strict_seed_ids",
    "same_day_seed_ids",
    "strict_witness",
    "same_day_witness",
)


class TemporalIntegrationError(RuntimeError):
    """Временной модуль отсутствует или вернул результат не по контракту."""


def json_rows(data: Dataset) -> tuple:
    """Строки узлов, рёбер и транзакций в форме analysis.json (идентификаторы — строки)."""
    nodes = [{"gid": str(n["gid"]), "depth": n["depth"], "is_seed": n["is_seed"]} for n in data.nodes]
    edges = [
        {"src": str(e["src"]), "dst": str(e["dst"]), "sum_kzt": kzt_value(e["tiyn"]), "n_tx": e["n_tx"], "depth": e["depth"]}
        for e in data.edges
    ]
    transactions = [
        {"src": str(t["src"]), "dst": str(t["dst"]), "date": t["date"].isoformat(), "sum_kzt": kzt_value(t["tiyn"])}
        for t in data.transactions
    ]
    return nodes, edges, transactions


def _load_temporal():
    try:
        from .temporal import compute_temporal
    except ImportError as exc:
        raise TemporalIntegrationError(
            "Модуль backend.temporal не найден: временной анализ ещё не подключён, выгрузки не созданы"
        ) from exc
    return compute_temporal


def _checked_temporal(result, gids: list) -> tuple:
    if not isinstance(result, dict) or not isinstance(result.get("by_gid"), dict) or "summary" not in result:
        raise TemporalIntegrationError("compute_temporal должен вернуть {'by_gid': dict, 'summary': dict}")
    by_gid = result["by_gid"]
    missing = [g for g in gids if g not in by_gid]
    if missing:
        raise TemporalIntegrationError(f"compute_temporal не вернул данные для {len(missing)} счетов, например {missing[0]}")
    for gid in gids:
        absent = [k for k in TEMPORAL_KEYS if k not in by_gid[gid]]
        if absent:
            raise TemporalIntegrationError(f"Временные данные счёта {gid} без полей: {', '.join(absent)}")
    return by_gid, result["summary"]


def _weak_components(node_ids: list, edges: list) -> int:
    parent = {g: g for g in node_ids}

    def find(g):
        while parent[g] != g:
            parent[g] = parent[parent[g]]
            g = parent[g]
        return g

    for e in edges:
        a, b = find(e["src"]), find(e["dst"])
        if a != b:
            parent[max(a, b)] = min(a, b)
    return len({find(g) for g in node_ids})


def build_analysis(data: Dataset, temporal_fn=None) -> dict:
    """Полный анализ. `temporal_fn` по умолчанию — backend.temporal.compute_temporal."""
    metrics = compute_metrics(data)
    gids = [n["gid"] for n in data.nodes]
    candidates = {g: evaluate(metrics[g]) for g in gids}
    chosen = {g: select(candidates[g]) for g in gids}
    primary = {g: chosen[g][0] for g in gids}

    nodes_json, edges_json, tx_json = json_rows(data)
    compute_temporal = temporal_fn or _load_temporal()
    by_gid, temporal_summary = _checked_temporal(
        compute_temporal(nodes_json, edges_json, tx_json), [str(g) for g in gids]
    )
    strict_counts = {g: int(by_gid[str(g)]["strict_seed_count"]) for g in gids}

    priority = compute_priority(metrics, primary, strict_counts)
    assignment = assign_clusters(gids, data.edges)
    roles = {g: primary[g].role for g in gids}
    cluster_rows = summarize(assignment, data.edges, metrics, roles, {g: priority[g]["score"] for g in gids})

    nodes = []
    for gid in gids:
        m = metrics[gid]
        role, alternatives = chosen[gid]
        pass_through = m.pass_through
        forward_share = m.forward_share
        nodes.append(
            {
                "gid": str(gid),
                "depth": m.depth,
                "is_seed": m.is_seed,
                "role": role.role,
                "role_score": round(role.score, 4),
                "role_basis": role.code,
                "cluster_id": assignment[gid],
                "priority_score": priority[gid]["score"],
                "evidence": evidence_text(m, role, alternatives[0]),
                "metrics": {
                    "in_degree": m.in_degree,
                    "out_degree": m.out_degree,
                    "in_kzt": kzt_value(m.in_tiyn),
                    "out_kzt": kzt_value(m.out_tiyn),
                    "in_tx": m.in_tx,
                    "out_tx": m.out_tx,
                    "seed_in_count": m.seed_in_count,
                    "seed_out_count": m.seed_out_count,
                    "pass_through": None if pass_through is None else round(pass_through, 4),
                    "forward_share": None if forward_share is None else round(forward_share, 4),
                    "counterparties": m.counterparties,
                    "seed_links": m.seed_links,
                    "last_in_date": m.last_in_date.isoformat() if m.last_in_date else None,
                    "observation_margin_days": m.margin_days,
                    "value_window_days": m.value_margin_days,
                },
                "observation": {"outgoing_censored": m.outgoing_censored, "warnings": warnings_for(m)},
                "role_alternatives": [
                    {"role": c.role, "score": round(c.score, 4), "reason": c.reason, "basis": c.code} for c in alternatives
                ],
                "next_request": next_request(m, role.role),
                "priority_families": priority[gid]["families"],
                "temporal": by_gid[str(gid)],
            }
        )

    ranking = rank(priority)
    top_nodes = [
        {
            "rank": position,
            "gid": str(gid),
            "role": primary[gid].role,
            "priority_score": priority[gid]["score"],
            "why": clip_text(
                why_text(metrics[gid], primary[gid], priority[gid]["families"], strict_counts[gid]), 300
            ),
        }
        for position, gid in enumerate(ranking[: policy.TOP_N], start=1)
    ]

    clusters = [
        {
            "cluster_id": row["cluster_id"],
            "n_nodes": row["n_nodes"],
            "n_seed": row["n_seed"],
            "sum_kzt_internal": kzt_value(row["sum_kzt_internal_tiyn"]),
            "top_gids": row["top_gids"],
            "hypothesis": row["hypothesis"],
        }
        for row in cluster_rows
    ]

    touched = {e["src"] for e in data.edges} | {e["dst"] for e in data.edges}
    summary = {
        "n_nodes": len(gids),
        "n_edges": len(data.edges),
        "n_transactions": len(data.transactions),
        "n_seed": sum(1 for n in data.nodes if n["is_seed"]),
        "total_kzt": kzt_value(sum(t["tiyn"] for t in data.transactions)),
        "period_start": data.period_start.isoformat() if data.period_start else None,
        "period_end": data.period_end.isoformat() if data.period_end else None,
        "n_boundary": sum(1 for g in gids if metrics[g].outgoing_censored),
        "n_isolates": sum(1 for g in gids if g not in touched),
        "n_weak_components": _weak_components(gids, data.edges),
        "input_sha256": data.input_sha256,
        "n_clusters": len(clusters),
        "role_counts": {r: sum(1 for g in gids if roles[g] == r) for r in policy.ROLE_PRECEDENCE},
        "input_checks": dict(data.checks),
    }

    return {
        "schema_version": SCHEMA_VERSION,
        "summary": summary,
        "policy": policy.policy_payload(),
        "nodes": nodes,
        "edges": edges_json,
        "transactions": tx_json,
        "clusters": clusters,
        "top_nodes": top_nodes,
        "temporal_summary": temporal_summary,
    }
