"""Приоритет проверки: пять раскрытых семейств признаков, отдельно от роли."""

from __future__ import annotations

from bisect import bisect_left, bisect_right

from . import policy
from .fmt import kzt_ru, score_ru


def percentile_ranks(values: dict) -> dict:
    """Средний ранг в долях [0, 1]; нулевое значение всегда даёт 0."""
    ordered = sorted(values.values())
    total = len(ordered)
    ranks = {}
    for key, value in values.items():
        if value <= 0 or total == 0:
            ranks[key] = 0.0
            continue
        below = bisect_left(ordered, value)
        equal = bisect_right(ordered, value) - below
        ranks[key] = (below + 0.5 * equal) / total
    return ranks


def compute_priority(metrics: dict, primary: dict, strict_seed_counts: dict) -> dict:
    """{gid: {"score": float, "families": {...}}}; score округлён до 4 знаков."""
    flow = percentile_ranks({g: m.turnover_tiyn for g, m in metrics.items()})
    breadth = percentile_ranks({g: m.counterparties for g, m in metrics.items()})
    result = {}
    for gid, m in metrics.items():
        role = primary[gid]
        families = {
            "role_signal": role.score if role.role != "peripheral" else 0.0,
            "flow": flow[gid],
            "seed_links": min(1.0, m.seed_links / policy.SEED_LINK_SATURATION),
            "chronology": min(1.0, strict_seed_counts.get(gid, 0) / policy.CHRONOLOGY_SATURATION),
            "breadth": breadth[gid],
        }
        score = sum(policy.PRIORITY_WEIGHTS[k] * v for k, v in families.items())
        result[gid] = {
            "score": round(min(1.0, max(0.0, score)), 4),
            "families": {k: round(v, 4) for k, v in families.items()},
        }
    return result


def rank(priority: dict) -> list:
    """gid по убыванию приоритета; равенство решает меньший gid."""
    return sorted(priority, key=lambda g: (-priority[g]["score"], g))


def why_text(m, role, families: dict, strict_count: int) -> str:
    """Почему счёт в верхней части списка: вклад каждого семейства признаков."""
    label = policy.ROLE_LABELS_RU[role.role]
    parts = []
    if role.role != "peripheral":
        parts.append(f"гипотеза «{label}» {score_ru(role.score)}")
    parts.append(f"оборот {kzt_ru(m.turnover_tiyn)} (выше {int(families['flow'] * 100)}% счетов)")
    parts.append(f"плательщиков — {m.in_degree}, получателей — {m.out_degree}")
    if m.seed_links:
        parts.append(f"связей с исходными клиентами — {m.seed_links}")
    if strict_count:
        parts.append(f"исходных клиентов с цепочками возрастающих дат — {strict_count}")
    if m.is_seed:
        parts.append("сам исходный клиент")
    if m.outgoing_censored:
        parts.append("исходящие не собирались")
    text = "; ".join(parts)
    return text[0].upper() + text[1:] + "."
