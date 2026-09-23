"""Чувствительность ролей и очереди проверки к порогам и весам приоритета.

Запуск из корня репозитория: python tools/sensitivity.py data
Скрипт запускает тот же анализ, что и `python -m backend`, но по очереди сдвигает один порог или
набор весов и печатает JSON: сколько счетов получили роль и сколько счетов очереди проверки
(30 и первые 10) совпали с исходными правилами. Выгрузки в out/ не меняются.
"""
import collections, copy, json, sys

sys.path.insert(0, ".")
from backend import policy  # noqa: E402
from backend.analysis import build_analysis  # noqa: E402
from backend.io import load_dataset  # noqa: E402

data = load_dataset(sys.argv[1] if len(sys.argv) > 1 else "data")
BASE_T = copy.deepcopy(policy.THRESHOLDS)
BASE_W = dict(policy.PRIORITY_WEIGHTS)


def run():
    analysis = build_analysis(data)
    return collections.Counter(n["role"] for n in analysis["nodes"]), [t["gid"] for t in analysis["top_nodes"]], analysis


def reset():
    policy.THRESHOLDS.clear()
    policy.THRESHOLDS.update(copy.deepcopy(BASE_T))
    policy.PRIORITY_WEIGHTS.clear()
    policy.PRIORITY_WEIGHTS.update(BASE_W)


def compare(roles, top, base_top, role, base_roles):
    return {"role_count": roles[role], "base_count": base_roles[role],
            "top30_same": len(set(top) & set(base_top)), "top10_same": len(set(top[:10]) & set(base_top[:10])),
            "top1_same": top[0] == base_top[0]}


base_roles, base_top, base_analysis = run()
result = {"base_roles": dict(base_roles), "base_top1": base_top[0], "thresholds": [], "weights": []}

# Каждый порог сдвигается на один шаг вниз и вверх; остальные остаются как в policy.py.
for role, name, values in [
    ("consolidator", "min_payers", [6, 8]), ("distributor", "min_recipients", [8, 12]),
    ("coordinator", "min_seed_links", [2, 4]), ("terminal", "min_margin_days", [5, 10]),
    ("terminal", "max_pass_through", [0.15, 0.25]),
]:
    for value in values:
        reset()
        policy.THRESHOLDS[role][name]["value"] = value
        roles, top, _ = run()
        result["thresholds"].append({"param": f"{role}.{name}", "value": value, **compare(roles, top, base_top, role, base_roles)})
for low, high in [(0.75, 1.25), (0.85, 1.15)]:
    reset()
    policy.THRESHOLDS["transit"]["pass_through_low"]["value"] = low
    policy.THRESHOLDS["transit"]["pass_through_high"]["value"] = high
    roles, top, _ = run()
    result["thresholds"].append({"param": "transit.corridor", "value": f"{low}-{high}", **compare(roles, top, base_top, "transit", base_roles)})

# Другие веса пяти признаков приоритета.
for label, weights in {
    "equal_20": {"role_signal": .2, "flow": .2, "seed_links": .2, "chronology": .2, "breadth": .2},
    "role_50": {"role_signal": .5, "flow": .15, "seed_links": .15, "chronology": .1, "breadth": .1},
    "flow_50": {"role_signal": .15, "flow": .5, "seed_links": .15, "chronology": .1, "breadth": .1},
    "no_dates": {"role_signal": .35, "flow": .3, "seed_links": .2, "chronology": 0.0, "breadth": .15},
}.items():
    reset()
    policy.PRIORITY_WEIGHTS.clear()
    policy.PRIORITY_WEIGHTS.update(weights)
    _, top, _ = run()
    result["weights"].append({"weights": label, "top30_same": len(set(top) & set(base_top)),
                              "top10_same": len(set(top[:10]) & set(base_top[:10])), "top1_same": top[0] == base_top[0]})
reset()

# Очередь — не просто самые крупные счета: сравнение с 30 счетами наибольшего оборота (без исходных клиентов).
nodes = {n["gid"]: n for n in base_analysis["nodes"]}
by_turnover = sorted((g for g, n in nodes.items() if not n["is_seed"]),
                     key=lambda g: -(nodes[g]["metrics"]["in_kzt"] + nodes[g]["metrics"]["out_kzt"]))[:30]
result["queue_vs_turnover_top30_same"] = len(set(by_turnover) & set(base_top))
print(json.dumps(result, ensure_ascii=False, indent=1))
