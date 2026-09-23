"""Кластеры: Louvain с фиксированным зерном по неориентированной проекции графа.

Вес пары счетов — сумма переводов в обе стороны (в тиынах). Граф строится в
каноническом порядке, а номера кластеров назначаются по размеру и наименьшему gid,
поэтому перестановка строк во входных файлах не меняет результат. Изолированные
счета сохраняются как отдельные кластеры.
"""

from __future__ import annotations

from collections import Counter

import networkx as nx

from . import policy
from .fmt import kzt_ru, plural_ru


def assign_clusters(node_ids: list, edges: list) -> dict:
    """{gid: cluster_id}; номера с 1, крупные кластеры первыми."""
    weights: Counter = Counter()
    for e in edges:
        a, b = sorted((e["src"], e["dst"]))
        weights[(a, b)] += e["tiyn"]
    graph = nx.Graph()
    graph.add_nodes_from(sorted(node_ids))
    for (a, b) in sorted(weights):
        graph.add_edge(a, b, weight=weights[(a, b)])
    communities = nx.community.louvain_communities(
        graph, weight="weight", resolution=policy.LOUVAIN_RESOLUTION, seed=policy.LOUVAIN_SEED
    )
    ordered = sorted((sorted(c) for c in communities), key=lambda c: (-len(c), c[0]))
    return {gid: index for index, members in enumerate(ordered, start=1) for gid in members}


def summarize(assignment: dict, edges: list, metrics: dict, roles: dict, priority: dict) -> list:
    """Строки clusters.csv: размер, исходные клиенты, внутренний оборот, ключевые счета, гипотеза."""
    members: dict = {}
    for gid, cid in assignment.items():
        members.setdefault(cid, []).append(gid)
    internal = Counter()
    neighbours: dict = {}
    for e in edges:
        cid = assignment[e["src"]]
        if assignment[e["dst"]] == cid:
            internal[cid] += e["tiyn"]
            if e["src"] != e["dst"]:
                # Встречные переводы A→B и B→A — одна связь между двумя счетами, а не две.
                neighbours.setdefault(e["src"], set()).add(e["dst"])
                neighbours.setdefault(e["dst"], set()).add(e["src"])
    internal_degree = Counter({g: len(s) for g, s in neighbours.items()})
    rows = []
    for cid in sorted(members):
        gids = sorted(members[cid])
        ranked = sorted(gids, key=lambda g: (-priority[g], g))
        top = ranked[: policy.CLUSTER_TOP_GIDS]
        rows.append(
            {
                "cluster_id": cid,
                "n_nodes": len(gids),
                "n_seed": sum(1 for g in gids if metrics[g].is_seed),
                "sum_kzt_internal_tiyn": internal[cid],
                "top_gids": [str(g) for g in top],
                "hypothesis": _hypothesis(gids, internal[cid], internal_degree, metrics, roles),
            }
        )
    return rows


def _hypothesis(gids: list, internal_tiyn: int, internal_degree: Counter, metrics: dict, roles: dict) -> str:
    n = len(gids)
    seeds = sum(1 for g in gids if metrics[g].is_seed)
    if n == 1:
        m = metrics[gids[0]]
        if m.in_degree == 0 and m.out_degree == 0:
            return "Отдельный счёт без переводов в выгрузке: структура не наблюдается, нужны данные вне выборки."
        return "Отдельный счёт, связи которого отнесены к другим группам: самостоятельной структуры нет."
    parts = [f"Группа: {n} {plural_ru(n, 'счёт', 'счёта', 'счетов')}, исходных клиентов — {seeds}; внутренний оборот {kzt_ru(internal_tiyn)}."]
    hub = max(gids, key=lambda g: (internal_degree[g], -g))
    share = internal_degree[hub] / (n - 1)
    if n >= 4 and share >= 0.5:
        parts.append(
            f"Звезда вокруг {hub} ({policy.ROLE_LABELS_RU[roles[hub]]}): связей {internal_degree[hub]} из {n - 1} возможных."
        )
    counts = Counter(roles[g] for g in gids if roles[g] != "peripheral")
    if counts:
        listed = ", ".join(
            f"{policy.ROLE_LABELS_RU[r]} — {c}" for r, c in sorted(counts.items(), key=lambda x: (-x[1], x[0]))[:3]
        )
        parts.append(f"Роли-гипотезы: {listed}.")
    else:
        parts.append("Выраженных ролей нет.")
    parts.append("Это наблюдаемая структура переводов, а не вывод о связи владельцев.")
    return " ".join(parts)
