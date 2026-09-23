"""Проверки дополнительных наблюдений (backend/insights.py).

Запуск: python -m unittest tests.test_insights -v
Проверка на официальных данных включается переменной FINANCE_DATA=<каталог> (или FINANCE_DATA_DIR).
Синтетические примеры задают каждое наблюдение и его отрицательный случай явно: обратные даты,
обычный активный счёт, отсутствие шаблона, циклы в разном порядке строк и граничные идентификаторы.
"""

from __future__ import annotations

import json
import os
import random
import sys
import time
import unittest
from collections import Counter
from decimal import Decimal
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from backend import insight_policy as ip  # noqa: E402
from backend.insights import compute_insights  # noqa: E402

BASE = 100000000343175100  # больше 2**53: преобразование во float исказило бы идентификатор
INT64_MAX = 2**63 - 1


def gid(i: int) -> str:
    return str(BASE + 1000 * i)


def make_analysis(txs, meta=None, ids=(), start="2026-07-01", end="2026-07-31") -> dict:
    """Минимальный analysis.json: txs — (отправитель, получатель, день июля, сумма в тенге)."""
    meta = meta or {}
    transactions = [
        {"src": gid(s), "dst": gid(d), "date": f"2026-07-{day:02d}", "sum_kzt": kzt} for s, d, day, kzt in txs
    ]
    agg = {}
    for t in transactions:
        e = agg.setdefault((t["src"], t["dst"]), [Decimal(0), 0])
        e[0] += Decimal(str(t["sum_kzt"]))
        e[1] += 1
    edges = [
        {"src": s, "dst": d, "sum_kzt": int(v[0]) if v[0] == int(v[0]) else float(v[0]), "n_tx": v[1], "depth": 1}
        for (s, d), v in agg.items()
    ]
    everyone = {s for s, _, _, _ in txs} | {d for _, d, _, _ in txs} | set(meta) | set(ids)
    nodes = []
    for i in sorted(everyone):
        m = meta.get(i, {})
        nodes.append(
            {
                "gid": gid(i),
                "depth": m.get("depth", 1),
                "is_seed": m.get("is_seed", False),
                "priority_score": m.get("priority", 0.0),
            }
        )
    return {
        "schema_version": "finance-workbench/v1",
        "summary": {"period_start": start, "period_end": end, "input_sha256": "синтетика"},
        "nodes": nodes,
        "edges": edges,
        "transactions": transactions,
    }


def section(result: dict, key: str) -> dict:
    return next(s for s in result["sections"] if s["key"] == key)


def tiyn(value) -> int:
    return int(Decimal(str(value)) * 100)


def records(obj):
    """Все строки транзакций, на которые ссылается результат."""
    if isinstance(obj, dict):
        if set(obj) == {"src", "dst", "date", "sum_kzt"}:
            yield obj
            return
        for v in obj.values():
            yield from records(v)
    elif isinstance(obj, list):
        for v in obj:
            yield from records(v)


def assert_sources(case: unittest.TestCase, analysis: dict, result: dict) -> None:
    """Каждая приведённая транзакция есть в исходных строках; каждый gid — существующий счёт."""
    source = Counter((t["src"], t["dst"], t["date"], tiyn(t["sum_kzt"])) for t in analysis["transactions"])
    for rec in records(result["sections"]):
        case.assertIn((rec["src"], rec["dst"], rec["date"], tiyn(rec["sum_kzt"])), source, rec)
    known = {n["gid"] for n in analysis["nodes"]}
    for gid_ in result["by_gid"]:
        case.assertIn(gid_, known)
    for s in result["sections"]:
        for ex in s["examples"]:
            for key in ("gid", "src", "dst"):
                if key in ex:
                    case.assertIsInstance(ex[key], str)
                    case.assertIn(ex[key], known)
            for key in ("route", "cycle"):
                for g in ex.get(key, []):
                    case.assertIsInstance(g, str)
                    case.assertIn(g, known)
            if "text" in ex:
                case.assertTrue(1 <= len(ex["text"]) <= 200, ex["text"])


def rich_fixture() -> dict:
    """Несколько шаблонов сразу: для проверки порядка строк и общей схемы."""
    txs = [
        (0, 1, 3, 100000), (1, 2, 4, 98000),               # быстрый транзит через 1
        (3, 9, 5, 20000), (4, 9, 5, 30000), (5, 9, 5, 40000), (9, 10, 6, 85000),  # схождение на 9
        (1, 2, 10, 50000), (2, 6, 4, 90000), (2, 6, 11, 45000),  # маршрут 1→2→6 дважды
        (6, 7, 12, 40000), (7, 6, 13, 30000),              # возврат 6↔7 по датам
        (7, 8, 7, 10000), (7, 8, 7, 10000), (7, 8, 8, 10000),  # серия одной пары
    ]
    meta = {0: {"depth": 0, "is_seed": True, "priority": 0.5}, 9: {"priority": 0.9}, 2: {"priority": 0.7}}
    return make_analysis(txs, meta, ids=(20,))


class TemporalPatternsTest(unittest.TestCase):
    def test_INS_TEMPORAL_pass_through_positive_reversed_and_corridor(self):
        positive = compute_insights(make_analysis([(0, 1, 3, 100000), (1, 2, 4, 98000)]))
        pt = section(positive, "pass_through")
        self.assertEqual(pt["counts"]["accounts"], 1)
        ex = pt["examples"][0]
        self.assertEqual(ex["gid"], gid(1))
        self.assertEqual(ex["pairs"][0]["lag_days"], 1)
        self.assertEqual(ex["pairs"][0]["in"], {"src": gid(0), "dst": gid(1), "date": "2026-07-03", "sum_kzt": 100000})
        self.assertEqual(ex["pairs"][0]["out"], {"src": gid(1), "dst": gid(2), "date": "2026-07-04", "sum_kzt": 98000})

        reversed_dates = compute_insights(make_analysis([(0, 1, 5, 100000), (1, 2, 3, 98000)]))
        self.assertEqual(section(reversed_dates, "pass_through")["counts"]["accounts"], 0)
        outside = compute_insights(make_analysis([(0, 1, 3, 100000), (1, 2, 4, 50000)]))
        self.assertEqual(section(outside, "pass_through")["counts"]["accounts"], 0)
        too_late = compute_insights(make_analysis([(0, 1, 3, 100000), (1, 2, 6, 98000)]))
        self.assertEqual(section(too_late, "pass_through")["counts"]["accounts"], 0)

    def test_INS_TEMPORAL_same_day_is_possible_not_observed(self):
        result = compute_insights(make_analysis([(0, 1, 3, 100000), (1, 2, 3, 100000)]))
        pt = section(result, "pass_through")
        self.assertEqual(pt["counts"]["by_lag_days"]["0"], 1)
        request = next(r for r in section(result, "data_requests")["examples"] if r["key"] == "intraday_time")
        self.assertEqual(request["example_gids"], [gid(1)])
        self.assertTrue(any("внутри дня" in text for text in pt["limitations"]))

    def test_INS_TEMPORAL_convergence_same_day_vs_spread(self):
        same_day = make_analysis([(1, 9, 5, 20000), (2, 9, 5, 30000), (3, 9, 5, 40000), (9, 10, 6, 80000)])
        conv = section(compute_insights(same_day), "convergence")
        self.assertEqual(conv["counts"]["events"], 1)
        ex = conv["examples"][0]
        self.assertEqual((ex["gid"], ex["date"], ex["n_payers"], ex["sum_kzt"]), (gid(9), "2026-07-05", 3, 90000))
        self.assertEqual((ex["onward_n_tx"], ex["onward_kzt"]), (1, 80000))

        spread = make_analysis([(1, 9, 5, 20000), (2, 9, 6, 30000), (3, 9, 7, 40000)])
        self.assertEqual(section(compute_insights(spread), "convergence")["counts"]["events"], 0)

        boundary = make_analysis([(1, 9, 5, 20000), (2, 9, 5, 30000), (3, 9, 5, 40000)], {9: {"depth": 4}})
        result = compute_insights(boundary)
        ex = section(result, "convergence")["examples"][0]
        self.assertIsNone(ex["onward_n_tx"])  # исходящие глубины 4 не собирались — не «ноль»
        request = next(r for r in section(result, "data_requests")["examples"] if r["key"] == "beyond_depth4")
        self.assertEqual(request["example_gids"], [gid(9)])

    def test_INS_TEMPORAL_bursts_ordinary_hub_is_not_a_burst(self):
        hub = [(1, 100 + day, day, 10000) for day in range(1, 21)]  # один получатель в день весь месяц
        burst = [(50, 200 + k, 10, 10000) for k in range(6)]  # шесть получателей за один день
        late = [(60, 300 + k, 30 + k % 2, 10000) for k in range(6)]  # вся активность в последние два дня
        result = compute_insights(make_analysis(hub + burst + late))
        bursts = section(result, "bursts")
        flagged = {(ex["gid"], ex["direction"]) for ex in bursts["examples"]}
        self.assertEqual(flagged, {(gid(50), "out")})
        ex = bursts["examples"][0]
        self.assertEqual((ex["n_tx"], ex["n_counterparties"], ex["basis_days"]), (6, 6, 22))
        self.assertAlmostEqual(ex["rate_ratio"], 11.0)
        self.assertEqual(len(bursts["daily"]), 31)
        self.assertEqual(sum(d["n_tx"] for d in bursts["daily"]), len(hub + burst + late))


class RoutesAndCyclesTest(unittest.TestCase):
    def test_INS_ROUTES_repeated_once_and_reversed(self):
        repeated = compute_insights(make_analysis([(1, 2, 3, 50000), (2, 3, 4, 45000), (1, 2, 10, 50000), (2, 3, 11, 45000)]))
        routes = section(repeated, "routes")
        self.assertEqual(routes["counts"]["routes_dated"], 1)
        ex = routes["examples"][0]
        self.assertEqual((ex["route"], ex["repeats"]), ([gid(1), gid(2), gid(3)], 2))
        self.assertEqual([o["lag_days"] for o in ex["occurrences"]], [1, 1])

        once = compute_insights(make_analysis([(1, 2, 3, 50000), (2, 3, 4, 45000)]))
        self.assertEqual(section(once, "routes")["counts"]["routes_dated"], 0)

        reversed_dates = compute_insights(make_analysis([(1, 2, 5, 50000), (2, 3, 3, 45000), (1, 2, 12, 50000), (2, 3, 10, 45000)]))
        rev = section(reversed_dates, "routes")
        self.assertEqual(rev["counts"]["routes_dated"], 0)
        self.assertEqual(rev["counts"]["routes_structural_repeated"], 1)  # связь повторялась, но не по датам

    def test_INS_ROUTES_one_onward_day_is_not_two_repeats(self):
        # Два перевода A→B, но только один день B→C: маршрут повторился один раз.
        result = compute_insights(make_analysis([(1, 2, 5, 50000), (1, 2, 6, 50000), (2, 3, 6, 45000)]))
        self.assertEqual(section(result, "routes")["counts"]["routes_dated"], 0)

    def test_INS_CYCLES_normalized_once_with_dated_labels(self):
        dated = [(1, 2, 1, 30000), (2, 3, 2, 30000), (3, 1, 3, 30000)]
        structural = [(11, 12, 5, 30000), (12, 13, 3, 30000), (13, 11, 1, 30000)]
        same_day = [(21, 22, 4, 30000), (22, 21, 4, 30000)]
        analysis = make_analysis(dated + structural + same_day)
        cycles = section(compute_insights(analysis), "cycles")
        self.assertEqual(cycles["counts"]["cycles"], 3)
        by_first = {ex["cycle"][0]: ex for ex in cycles["examples"]}
        self.assertEqual(by_first[gid(1)]["cycle"], [gid(1), gid(2), gid(3)])
        self.assertEqual(by_first[gid(1)]["dated_return"], "strict")
        witness = by_first[gid(1)]["witness"]
        self.assertEqual(witness[0]["src"], witness[-1]["dst"])  # цепочка возвращается к первому счёту
        self.assertEqual([w["date"] for w in witness], ["2026-07-01", "2026-07-02", "2026-07-03"])
        self.assertEqual(by_first[gid(11)]["dated_return"], "none")
        self.assertIsNone(by_first[gid(11)]["witness"])
        self.assertIn("Структурный", by_first[gid(11)]["text"])
        self.assertEqual(by_first[gid(21)]["dated_return"], "same_day")
        self.assertEqual(cycles["counts"]["by_length"], {"2": 1, "3": 2, "4": 0})

        # Тот же цикл, записанный с другого счёта и в другом порядке строк, находится один раз.
        rotated = make_analysis([(3, 1, 3, 30000), (2, 3, 2, 30000), (1, 2, 1, 30000)])
        again = section(compute_insights(rotated), "cycles")
        self.assertEqual([ex["cycle"] for ex in again["examples"]], [[gid(1), gid(2), gid(3)]])

    def test_INS_CYCLES_direction_matters_and_terminates(self):
        # Два цикла разного направления на одних счетах и плотный полный граф из пяти счетов.
        both = make_analysis([(1, 2, 1, 1e4), (2, 3, 2, 1e4), (3, 1, 3, 1e4), (1, 3, 4, 1e4), (3, 2, 5, 1e4), (2, 1, 6, 1e4)])
        cycles = section(compute_insights(both), "cycles")
        self.assertEqual(cycles["counts"]["by_length"]["3"], 2)
        self.assertEqual(cycles["counts"]["by_length"]["2"], 3)
        complete = [(a, b, 1 + (a * 5 + b) % 28, 10000) for a in range(5) for b in range(5) if a != b]
        dense = section(compute_insights(make_analysis(complete)), "cycles")
        # Простые направленные циклы полного графа K5 длиной 2..4: 10 + 20 + 30.
        self.assertEqual(dense["counts"]["by_length"], {"2": 10, "3": 20, "4": 30})


    def test_INS_CYCLES_enumeration_cap_is_reported(self):
        complete = [(a, b, 1 + (a * 5 + b) % 28, 10000) for a in range(5) for b in range(5) if a != b]
        saved = ip.CYCLE_ENUMERATION_CAP
        ip.CYCLE_ENUMERATION_CAP = 7
        try:
            cycles = section(compute_insights(make_analysis(complete)), "cycles")
        finally:
            ip.CYCLE_ENUMERATION_CAP = saved
        self.assertEqual(cycles["counts"]["cycles"], 7)
        self.assertTrue(cycles["counts"]["truncated"])
        full = section(compute_insights(make_analysis(complete)), "cycles")
        self.assertFalse(full["counts"]["truncated"])


class AnomaliesTest(unittest.TestCase):
    def test_INS_ANOMALY_splitting_series_vs_spread(self):
        series = [(1, 2, 7, 10000), (1, 2, 7, 10000), (1, 2, 7, 10000), (1, 2, 8, 12000)]
        spread = [(1, 3, 1, 10000), (1, 3, 10, 10000), (1, 3, 20, 10000)]
        split = section(compute_insights(make_analysis(series + spread)), "splitting")
        self.assertEqual(split["counts"]["pairs"], 1)
        ex = split["examples"][0]
        self.assertEqual((ex["src"], ex["dst"], ex["n_parts"], ex["identical_parts"]), (gid(1), gid(2), 4, 3))
        self.assertEqual((ex["sum_kzt"], ex["min_kzt"], ex["max_kzt"]), (42000, 10000, 12000))
        self.assertTrue(any("5 000 ₸" in text for text in split["limitations"]))

    def test_INS_ANOMALY_depth_profile_outlier_vs_uniform(self):
        uniform = [(0, 10 + k, 1 + k % 28, 10000) for k in range(30)]
        meta = {10 + k: {"depth": 2} for k in range(31)}
        meta[0] = {"depth": 1}
        quiet = section(compute_insights(make_analysis(uniform, meta)), "depth_profile")
        self.assertEqual(quiet["counts"]["accounts"], 0)

        outlier = uniform + [(0, 40, 5, 9000000)]
        meta[40] = {"depth": 2}
        loud = section(compute_insights(make_analysis(outlier, meta)), "depth_profile")
        self.assertEqual([ex["gid"] for ex in loud["examples"]], [gid(40)])
        feature = loud["examples"][0]["features"][0]
        self.assertEqual((feature["name"], feature["value"], feature["cohort_median"]), ("in_kzt", 9000000, 10000))
        self.assertEqual(loud["examples"][0]["cohort_size"], 31)

    def test_INS_ANOMALY_boundary_outgoing_not_compared(self):
        txs = [(0, 10 + k, 2, 10000) for k in range(30)]
        meta = {10 + k: {"depth": 4} for k in range(30)}
        cohorts = section(compute_insights(make_analysis(txs, meta)), "depth_profile")["cohorts"]
        depth4 = next(c for c in cohorts if c["depth"] == 4)
        self.assertNotIn("out_kzt", depth4["medians"])
        self.assertIn("in_kzt", depth4["medians"])


class ResilienceTest(unittest.TestCase):
    def test_INS_RESILIENCE_hub_removal_order_and_conservation(self):
        txs = [(0, 1, 1, 100000)] + [(1, 2 + k, 2, 10000) for k in range(10)] + [(0, 12, 1, 50000), (12, 13, 2, 20000)]
        meta = {0: {"depth": 0, "is_seed": True, "priority": 0.2}, 1: {"priority": 0.9}, 12: {"priority": 0.5}}
        analysis = make_analysis(txs, meta, ids=(99,))
        res = section(compute_insights(analysis), "resilience")
        self.assertEqual(res["baseline"]["reachable_non_seed"], 13)
        self.assertEqual(res["baseline"]["components"], 2)  # изолированный счёт 99 — отдельная компонента
        top1 = next(r for r in res["scenarios"] if r["strategy"] == "priority" and r["n_removed"] == 1)
        self.assertEqual(top1["removed_gids"], [gid(1)])
        self.assertEqual(top1["reachable_non_seed"], 2)  # остаются только 12 и 13
        self.assertAlmostEqual(top1["reachable_share"], round(2 / 12, 4))
        top3 = next(r for r in res["scenarios"] if r["strategy"] == "priority" and r["n_removed"] == 3)
        self.assertEqual(top3["removed_gids"], [gid(1), gid(12), gid(0)])

        total = sum(tiyn(e["sum_kzt"]) for e in analysis["edges"])
        for row in res["scenarios"]:
            if row["strategy"] == "random":
                continue
            removed = set(row["removed_gids"])
            expected = sum(tiyn(e["sum_kzt"]) for e in analysis["edges"] if e["src"] in removed or e["dst"] in removed)
            self.assertEqual(tiyn(row["edge_kzt_removed"]), expected)
            self.assertEqual(tiyn(row["edge_kzt_removed"]) + tiyn(row["edge_kzt_remaining"]), total)
        self.assertTrue(any("не прогноз" in text for text in res["limitations"]))


class ScaleTest(unittest.TestCase):
    def test_INS_SCALE_dense_hub_and_sparse_graph_stay_fast(self):
        rng = random.Random(20260923)
        hub = [(1, 2, 1 + k % 31, 10000 + k) for k in range(3000)]  # 3 000 поступлений на один счёт
        hub += [(2, 3 + k % 500, 1 + k % 31, 10000 + k) for k in range(3000)]  # и 3 000 исходящих
        sparse = [(10 + rng.randrange(5000), 10 + rng.randrange(5000), 1 + rng.randrange(31), 5000 + rng.randrange(100000))
                  for _ in range(20000)]
        sparse = [t for t in sparse if t[0] != t[1]]
        analysis = make_analysis(hub + sparse, {1: {"depth": 0, "is_seed": True}})
        started = time.perf_counter()
        result = compute_insights(analysis)
        elapsed = time.perf_counter() - started
        self.assertLess(elapsed, 20.0, f"{elapsed:.2f} с на {len(analysis['transactions'])} транзакций")
        self.assertGreater(section(result, "pass_through")["counts"]["outgoing_matched"], 0)


class ContractTest(unittest.TestCase):
    def test_INS_SCHEMA_shape_parameters_and_bounds(self):
        analysis = rich_fixture()
        result = compute_insights(analysis)
        self.assertEqual(result["schema_version"], "finance-insights/v1")
        self.assertEqual(result["input_sha256"], "синтетика")
        keys = [s["key"] for s in result["sections"]]
        self.assertEqual(keys, ["pass_through", "convergence", "bursts", "routes", "cycles", "splitting",
                                "depth_profile", "resilience", "data_requests"])
        self.assertEqual(sorted(k for item in result["case_items"] for k in item["sections"]), sorted(keys))
        for s in result["sections"]:
            for field in ("title", "case_item", "method", "parameters", "counts", "examples", "limitations"):
                self.assertIn(field, s, s["key"])
            self.assertLessEqual(len(s["examples"]), ip.MAX_EXAMPLES)
            for spec in s["parameters"].values():
                self.assertEqual(set(spec), {"value", "unit", "rationale"})
        for flags in result["by_gid"].values():
            self.assertLessEqual(len(flags), ip.MAX_FLAGS_PER_GID)
            for flag in flags:
                self.assertTrue(1 <= len(flag["text"]) <= 160, flag)
        self.assertEqual(result["analyst_effort_hypothesis"]["status"], "гипотеза, не проверена")
        assert_sources(self, analysis, result)

    def test_INS_SCHEMA_no_pattern_input_is_empty_not_an_error(self):
        analysis = make_analysis([(0, 1, 1, 10000), (1, 2, 20, 10000)], {0: {"depth": 0, "is_seed": True}}, ids=(3,))
        result = compute_insights(analysis)
        for key in ("pass_through", "convergence", "bursts", "routes", "cycles", "splitting", "depth_profile"):
            self.assertEqual(section(result, key)["examples"], [], key)
        self.assertEqual(result["by_gid"], {})
        self.assertEqual(section(result, "data_requests")["counts"]["accounts"], 0)
        self.assertEqual(section(result, "resilience")["baseline"]["reachable_non_seed"], 2)

    def test_INS_DETERMINISM_row_permutation(self):
        analysis = rich_fixture()
        expected = json.dumps(compute_insights(analysis), ensure_ascii=False, sort_keys=True)
        rng = random.Random(7)
        for _ in range(5):
            shuffled = dict(analysis)
            for key in ("nodes", "edges", "transactions"):
                rows = list(analysis[key])
                rng.shuffle(rows)
                shuffled[key] = rows
            self.assertEqual(json.dumps(compute_insights(shuffled), ensure_ascii=False, sort_keys=True), expected)

    def test_INS_IDS_exact_large_identifiers(self):
        a, b = str(INT64_MAX), str(INT64_MAX - 1)
        analysis = {
            "summary": {"period_start": "2026-07-01", "period_end": "2026-07-31"},
            "nodes": [{"gid": a, "depth": 1, "is_seed": False}, {"gid": b, "depth": 1, "is_seed": False}],
            "edges": [{"src": a, "dst": b, "sum_kzt": 10000, "n_tx": 1}, {"src": b, "dst": a, "sum_kzt": 10000, "n_tx": 1}],
            "transactions": [
                {"src": a, "dst": b, "date": "2026-07-01", "sum_kzt": 10000},
                {"src": b, "dst": a, "date": "2026-07-02", "sum_kzt": 10000},
            ],
        }
        result = compute_insights(analysis)
        cycle = section(result, "cycles")["examples"][0]
        self.assertEqual(cycle["cycle"], [b, a])
        text = json.dumps(result)
        self.assertNotIn(str(INT64_MAX - 2), text)  # соседнее несуществующее число не появляется
        self.assertEqual(set(result["by_gid"]), {a, b})

        with self.assertRaises(ValueError):
            compute_insights({**analysis, "nodes": [{"gid": float(BASE), "depth": 1, "is_seed": False}]})
        with self.assertRaises(ValueError):
            broken = dict(analysis)
            broken["transactions"] = analysis["transactions"] + [{"src": a, "dst": "123", "date": "2026-07-03", "sum_kzt": 5000}]
            compute_insights(broken)

    def test_INS_AMOUNTS_fractional_tenge_are_exact(self):
        analysis = make_analysis([(1, 2, 7, 10000.01), (1, 2, 7, 10000.01), (1, 2, 7, 10000.01)])
        ex = section(compute_insights(analysis), "splitting")["examples"][0]
        self.assertEqual(tiyn(ex["sum_kzt"]), 3000003)
        self.assertEqual(ex["identical_parts"], 3)


def _official_dir():
    for name in ("FINANCE_DATA", "FINANCE_DATA_DIR"):
        value = os.environ.get(name)
        if value and Path(value).is_dir():
            return Path(value)
    return None


@unittest.skipUnless(_official_dir(), "Официальные данные не заданы: FINANCE_DATA=<каталог> (проверка не выполнялась)")
class OfficialDataTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from backend.analysis import build_analysis
        from backend.io import load_dataset

        cls.analysis = json.loads(json.dumps(build_analysis(load_dataset(_official_dir()))))
        started = time.perf_counter()
        cls.result = compute_insights(cls.analysis)
        cls.seconds = time.perf_counter() - started

    def test_INS_OFFICIAL_runtime_sources_and_rerun(self):
        self.assertLess(self.seconds, 10.0)
        assert_sources(self, self.analysis, self.result)
        again = compute_insights(self.analysis)
        self.assertEqual(json.dumps(again, sort_keys=True), json.dumps(self.result, sort_keys=True))
        self.assertEqual(self.result["input_sha256"], self.analysis["summary"]["input_sha256"])

    def test_INS_OFFICIAL_in_process_equals_json_round_trip(self):
        from backend.analysis import build_analysis
        from backend.io import load_dataset

        direct = compute_insights(build_analysis(load_dataset(_official_dir())))
        self.assertEqual(json.dumps(direct, sort_keys=True), json.dumps(self.result, sort_keys=True))

    def test_INS_OFFICIAL_counts_match_examples_and_conservation(self):
        for s in self.result["sections"]:
            if s["key"] in ("resilience", "data_requests"):
                continue
            first = next(iter(s["counts"].values()))
            self.assertEqual(len(s["examples"]), min(ip.MAX_EXAMPLES, first), s["key"])
        res = section(self.result, "resilience")
        total = sum(tiyn(e["sum_kzt"]) for e in self.analysis["edges"])
        self.assertEqual(res["baseline"]["reachable_non_seed"], self.analysis["summary"]["n_nodes"] - self.analysis["summary"]["n_seed"])
        for row in res["scenarios"]:
            if row["strategy"] != "random":
                self.assertEqual(tiyn(row["edge_kzt_removed"]) + tiyn(row["edge_kzt_remaining"]), total)

    def test_INS_OFFICIAL_profile_matches_core_metrics(self):
        metrics = {n["gid"]: n["metrics"] for n in self.analysis["nodes"]}
        for ex in section(self.result, "depth_profile")["examples"]:
            for f in ex["features"]:
                if f["name"] in ("in_degree", "out_degree", "in_tx", "out_tx"):
                    self.assertEqual(f["value"], metrics[ex["gid"]][f["name"]])
                elif f["name"] in ("in_kzt", "out_kzt"):
                    self.assertEqual(tiyn(f["value"]), tiyn(metrics[ex["gid"]][f["name"]]))


if __name__ == "__main__":
    unittest.main()
