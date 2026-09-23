"""Проверки временной достижимости (функция TEMP): даты, один день, циклы, порядок строк, свидетели.

Запуск из корня проекта: ``python -m unittest tests.test_temporal -v``.

Результат модуля сверяется с двумя независимыми способами расчёта: полным перебором простых
цепочек на малых графах и подневным распространением множеств исходных клиентов. Проверка на
официальных данных читает каталог из переменной ``FINANCE_DATA_DIR`` или ``data/`` в корне
проекта и пропускается с явной причиной, если файлов нет.
"""

from __future__ import annotations

import copy
import datetime as dt
import json
import os
import random
import re
import sys
import time
import unittest
from collections import Counter, defaultdict
from decimal import Decimal
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from backend.temporal import compute_temporal

TEMPORAL_KEYS = {
    "static_seed_count",
    "strict_seed_count",
    "same_day_seed_count",
    "strict_seed_ids",
    "same_day_seed_ids",
    "strict_witness",
    "same_day_witness",
}
DATED_MODES = (("strict", True), ("same_day", False))
GID_PATTERN = re.compile(r"0|-?[1-9][0-9]*")
DATE_PATTERN = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}")
# Независимый замер на официальных данных (подневное распространение, отдельный скрипт).
OFFICIAL_AT_LEAST_5 = {"static": 1596, "strict": 30, "same_day": 34}
OFFICIAL_AT_LEAST_1 = {"static": 2198, "strict": 1228, "same_day": 1437}
BASE_GID = 100_000_000_000_000_000


def node(gid, seed=False):
    return {"gid": str(gid), "depth": 0 if seed else 1, "is_seed": seed}


def tx(src, dst, day, amount=10_000.0):
    return {"src": str(src), "dst": str(dst), "date": f"2026-07-{day:02d}", "sum_kzt": amount}


def edges_for(transactions):
    grouped = {}
    for row in transactions:
        total, count = grouped.get((row["src"], row["dst"]), (0, 0))
        grouped[(row["src"], row["dst"])] = (total + row["sum_kzt"], count + 1)
    return [
        {"src": src, "dst": dst, "sum_kzt": total, "n_tx": count, "depth": 1}
        for (src, dst), (total, count) in grouped.items()
    ]


def run(nodes, transactions, edges=None):
    return compute_temporal(nodes, edges_for(transactions) if edges is None else edges, transactions)


def date_text(value):
    return value.isoformat() if isinstance(value, dt.date) else value


def witness_problems(result, nodes, transactions):
    """Все нарушения контракта свидетелей: исходные транзакции, связность и правило режима."""
    seeds = {row["gid"] for row in nodes if row["is_seed"]}
    pool = Counter(
        (row["src"], row["dst"], date_text(row["date"]), row["sum_kzt"]) for row in transactions
    )
    problems = []
    for gid, entry in result["by_gid"].items():
        for mode, strict in DATED_MODES:
            witness = entry[f"{mode}_witness"]
            ids = entry[f"{mode}_seed_ids"]
            label = f"{gid}/{mode}"
            if not ids:
                if witness is not None:
                    problems.append(f"{label}: свидетель без достижимости")
                continue
            if witness is None:
                problems.append(f"{label}: нет свидетеля при достижимости")
                continue
            seed, hops = witness["seed_gid"], witness["hops"]
            if seed not in ids or seed not in seeds or seed == gid:
                problems.append(f"{label}: неверный исходный клиент {seed}")
            if not hops or hops[0]["src"] != seed or hops[-1]["dst"] != gid:
                problems.append(f"{label}: цепочка не соединяет клиента и счёт")
                continue
            path = [seed] + [hop["dst"] for hop in hops]
            if len(set(path)) != len(path):
                problems.append(f"{label}: цепочка повторяет счёт")
            used = Counter()
            for index, hop in enumerate(hops):
                key = (hop["src"], hop["dst"], hop["date"], hop["sum_kzt"])
                used[key] += 1
                if used[key] > pool[key]:
                    problems.append(f"{label}: переход {index} не является исходной транзакцией")
                if index and hops[index - 1]["dst"] != hop["src"]:
                    problems.append(f"{label}: разрыв цепочки на переходе {index}")
                if index:
                    before, after = hops[index - 1]["date"], hop["date"]
                    if (after <= before) if strict else (after < before):
                        problems.append(f"{label}: даты нарушают правило режима")
    return problems


def brute_force(nodes, transactions, edges):
    """Полный перебор простых цепочек: достижимость и ранг лучшего свидетеля.

    Для каждого счёта и режима возвращает словарь «исходный клиент → (число переводов, дата
    последнего перевода)» — минимум по всем допустимым цепочкам.
    """
    seeds = sorted((row["gid"] for row in nodes if row["is_seed"]), key=int)
    successors = defaultdict(set)
    for row in list(edges) + list(transactions):
        successors[row["src"]].add(row["dst"])
    static = defaultdict(set)
    for seed in seeds:
        seen, stack = {seed}, [seed]
        while stack:
            for following in successors[stack.pop()]:
                if following not in seen:
                    seen.add(following)
                    stack.append(following)
        for gid in seen - {seed}:
            static[gid].add(seed)

    outgoing = defaultdict(list)
    for row in transactions:
        outgoing[row["src"]].append(row)
    ranks = {mode: defaultdict(dict) for mode, _ in DATED_MODES}

    def walk(mode, strict, seed, current, last, visited, hops):
        for row in outgoing[current]:
            following, day = row["dst"], date_text(row["date"])
            if following in visited:
                continue
            if last is not None and ((day <= last) if strict else (day < last)):
                continue
            rank = (hops + 1, day)
            known = ranks[mode][following].get(seed)
            if known is None or rank < known:
                ranks[mode][following][seed] = rank
            walk(mode, strict, seed, following, day, visited | {following}, hops + 1)

    for mode, strict in DATED_MODES:
        for seed in seeds:
            walk(mode, strict, seed, seed, None, {seed}, 0)
    return static, ranks


def day_sweep(nodes, transactions, strict):
    """Подневное распространение множеств исходных клиентов (битовые маски).

    Строгий режим замораживает состояние перед каждым днём; режим одного дня доводит переходы
    дня до неподвижной точки. Исходный клиент исключается из собственного множества.
    """
    seeds = sorted((row["gid"] for row in nodes if row["is_seed"]), key=int)
    bit = {seed: 1 << index for index, seed in enumerate(seeds)}
    reached = {row["gid"]: bit.get(row["gid"], 0) for row in nodes}
    by_day = defaultdict(list)
    for row in transactions:
        by_day[date_text(row["date"])].append((row["src"], row["dst"]))
    for day in sorted(by_day):
        pairs = by_day[day]
        if strict:
            before = dict(reached)
            for src, dst in pairs:
                reached[dst] |= before[src]
        else:
            changed = True
            while changed:
                changed = False
                for src, dst in pairs:
                    merged = reached[dst] | reached[src]
                    if merged != reached[dst]:
                        reached[dst] = merged
                        changed = True
    return {
        gid: [seed for seed in seeds if mask & bit[seed] and seed != gid]
        for gid, mask in reached.items()
    }


def random_case(rng, n_nodes, n_transactions, n_days, seed_share=0.35):
    gids = [str(BASE_GID + 100 * k) for k in rng.sample(range(100_000), n_nodes)]
    seeds = set(rng.sample(gids, max(1, round(n_nodes * seed_share))))
    nodes = [node(gid, gid in seeds) for gid in gids]
    transactions = []
    for _ in range(n_transactions):
        src, dst = rng.sample(gids, 2) if n_nodes > 1 else (gids[0], gids[0])
        if src == dst:
            continue
        transactions.append(tx(src, dst, rng.randint(1, n_days), rng.choice([5_000.0, 7_500.5, 12_000.0])))
    if transactions:
        # Точные повторы строк встречаются и в официальных данных.
        transactions.extend(copy.deepcopy(rng.sample(transactions, min(2, len(transactions)))))
    return nodes, transactions


def shuffled(rng, rows):
    rows = copy.deepcopy(rows)
    rng.shuffle(rows)
    return rows


class TemporalFixtureTest(unittest.TestCase):
    """Малые мотивы с заранее известным ответом."""

    def test_TEMP_forward_dates_reach_in_every_mode(self):
        nodes = [node(1, seed=True), node(2), node(3)]
        result = run(nodes, [tx(1, 2, 1), tx(2, 3, 2)])
        entry = result["by_gid"]["3"]
        self.assertEqual(
            (entry["static_seed_count"], entry["strict_seed_count"], entry["same_day_seed_count"]),
            (1, 1, 1),
        )
        self.assertEqual(entry["strict_seed_ids"], ["1"])
        expected = {
            "seed_gid": "1",
            "hops": [
                {"src": "1", "dst": "2", "date": "2026-07-01", "sum_kzt": 10_000.0},
                {"src": "2", "dst": "3", "date": "2026-07-02", "sum_kzt": 10_000.0},
            ],
        }
        self.assertEqual(entry["strict_witness"], expected)
        self.assertEqual(entry["same_day_witness"], expected)

    def test_TEMP_reversed_dates_block_dated_modes(self):
        nodes = [node(1, seed=True), node(2), node(3)]
        result = run(nodes, [tx(1, 2, 2), tx(2, 3, 1)])
        entry = result["by_gid"]["3"]
        self.assertEqual(entry["static_seed_count"], 1)
        for mode, _ in DATED_MODES:
            self.assertEqual(entry[f"{mode}_seed_count"], 0)
            self.assertEqual(entry[f"{mode}_seed_ids"], [])
            self.assertIsNone(entry[f"{mode}_witness"])
        # Первый переход от клиента допустим в любом режиме.
        self.assertEqual(result["by_gid"]["2"]["strict_seed_ids"], ["1"])

    def test_TEMP_same_day_chain_is_possible_but_not_strict(self):
        nodes = [node(1, seed=True), node(2), node(3)]
        forward = [tx(1, 2, 5), tx(2, 3, 5)]
        for rows in (forward, list(reversed(forward))):
            entry = run(nodes, rows)["by_gid"]["3"]
            self.assertEqual(entry["strict_seed_count"], 0)
            self.assertIsNone(entry["strict_witness"])
            self.assertEqual(entry["same_day_seed_ids"], ["1"])
            self.assertEqual(
                [(hop["src"], hop["dst"], hop["date"]) for hop in entry["same_day_witness"]["hops"]],
                [("1", "2", "2026-07-05"), ("2", "3", "2026-07-05")],
            )

    def test_TEMP_strict_needs_a_later_day_at_every_hop(self):
        # Первые два перехода в один день: строгая цепочка возможна только через обход 1 → 3.
        nodes = [node(1, seed=True), node(2), node(3), node(4)]
        rows = [tx(1, 2, 3), tx(2, 4, 3), tx(1, 3, 1), tx(3, 4, 2)]
        entry = run(nodes, rows)["by_gid"]["4"]
        self.assertEqual(
            [(hop["src"], hop["dst"], hop["date"]) for hop in entry["strict_witness"]["hops"]],
            [("1", "3", "2026-07-01"), ("3", "4", "2026-07-02")],
        )
        self.assertEqual(entry["same_day_witness"]["hops"][-1]["date"], "2026-07-02")

    def test_TEMP_seed_is_excluded_from_its_own_count(self):
        nodes = [node(1, seed=True), node(2), node(3, seed=True)]
        result = run(nodes, [tx(1, 2, 1), tx(2, 1, 2), tx(3, 1, 3)])
        seed = result["by_gid"]["1"]
        self.assertEqual(seed["static_seed_count"], 1)
        self.assertEqual(seed["strict_seed_ids"], ["3"])
        self.assertEqual(seed["same_day_seed_ids"], ["3"])
        self.assertEqual(seed["strict_witness"]["seed_gid"], "3")
        # Клиент 3 связан со счётом 2 только структурно: перевод 3 → 1 позже перевода 1 → 2.
        second = result["by_gid"]["2"]
        self.assertEqual(second["static_seed_count"], 2)
        self.assertEqual(second["strict_seed_ids"], ["1"])
        self.assertEqual(second["same_day_seed_ids"], ["1"])

    def test_TEMP_static_mode_uses_edges_without_dated_rows(self):
        nodes = [node(1, seed=True), node(2)]
        entry = compute_temporal(nodes, [{"src": "1", "dst": "2"}], [])["by_gid"]["2"]
        self.assertEqual(entry["static_seed_count"], 1)
        self.assertEqual((entry["strict_seed_count"], entry["same_day_seed_count"]), (0, 0))

    def test_TEMP_cycles_terminate_and_match_brute_force(self):
        nodes = [node(1, seed=True), node(2), node(3), node(4), node(5, seed=True)]
        rows = [
            tx(1, 2, 2), tx(2, 3, 2), tx(3, 2, 2), tx(3, 4, 1), tx(4, 2, 3),
            tx(2, 3, 4), tx(3, 4, 4), tx(4, 5, 4), tx(5, 1, 4), tx(1, 2, 5),
        ]
        edges = edges_for(rows)
        result = compute_temporal(nodes, edges, rows)
        static, ranks = brute_force(nodes, rows, edges)
        for gid, entry in result["by_gid"].items():
            self.assertEqual(entry["static_seed_count"], len(static[gid]))
            for mode, _ in DATED_MODES:
                self.assertEqual(entry[f"{mode}_seed_ids"], sorted(ranks[mode][gid], key=int))
        self.assertEqual(witness_problems(result, nodes, rows), [])

    def test_TEMP_isolated_seed_and_isolated_account_are_kept(self):
        nodes = [node(7, seed=True), node(8), node(1, seed=True), node(2)]
        result = run(nodes, [tx(1, 2, 1)])
        self.assertEqual(list(result["by_gid"]), ["1", "2", "7", "8"])
        for gid in ("7", "8"):
            entry = result["by_gid"][gid]
            self.assertEqual(
                entry,
                {
                    "static_seed_count": 0,
                    "strict_seed_count": 0,
                    "same_day_seed_count": 0,
                    "strict_seed_ids": [],
                    "same_day_seed_ids": [],
                    "strict_witness": None,
                    "same_day_witness": None,
                },
            )

    def test_TEMP_empty_input_gives_empty_result(self):
        result = compute_temporal([], [], [])
        self.assertEqual(result["by_gid"], {})
        self.assertEqual(result["summary"]["n_days"], 0)
        self.assertIsNone(result["summary"]["first_date"])
        self.assertEqual(result["summary"]["reachable_from_at_least_1_seed"], {"static": 0, "strict": 0, "same_day": 0})

    def test_TEMP_witness_prefers_fewest_hops_then_earliest_arrival_then_smaller_seed(self):
        nodes = [node(9, seed=True), node(4, seed=True), node(2), node(3)]

        def witness(rows):
            return run(nodes, rows)["by_gid"]["3"]["strict_witness"]

        # Один перевод от 4 (6 июля) короче двух от 9, хотя цепочка от 9 приходит раньше.
        shortest = witness([tx(9, 2, 1), tx(2, 3, 2), tx(4, 3, 6)])
        self.assertEqual((shortest["seed_gid"], len(shortest["hops"])), ("4", 1))
        # Одинаково коротко: раньше приходит перевод от 9.
        earliest = witness([tx(9, 3, 1), tx(4, 2, 1), tx(2, 3, 2), tx(4, 3, 6)])
        self.assertEqual((earliest["seed_gid"], earliest["hops"][0]["date"]), ("9", "2026-07-01"))
        # Полное равенство: меньший идентификатор исходного клиента.
        self.assertEqual(witness([tx(9, 3, 2), tx(4, 3, 2)])["seed_gid"], "4")

    def test_TEMP_dates_and_decimal_amounts_are_normalized(self):
        nodes = [node(1, seed=True), node(2)]
        as_objects = [{"src": "1", "dst": "2", "date": dt.date(2026, 7, 3), "sum_kzt": Decimal("5000.50")}]
        as_datetime = [{"src": "1", "dst": "2", "date": dt.datetime(2026, 7, 3, 0, 0), "sum_kzt": Decimal("5000.50")}]
        expected = {"src": "1", "dst": "2", "date": "2026-07-03", "sum_kzt": 5000.5}
        for rows in (as_objects, as_datetime):
            witness = compute_temporal(nodes, [{"src": "1", "dst": "2"}], rows)["by_gid"]["2"]["strict_witness"]
            self.assertEqual(witness["hops"], [expected])
        whole = [{"src": "1", "dst": "2", "date": "2026-07-03", "sum_kzt": Decimal("7000")}]
        hop = compute_temporal(nodes, [{"src": "1", "dst": "2"}], whole)["by_gid"]["2"]["strict_witness"]["hops"][0]
        self.assertEqual((hop["sum_kzt"], type(hop["sum_kzt"])), (7000, int))


class TemporalIdentifierTest(unittest.TestCase):
    """Идентификаторы остаются точными десятичными строками."""

    def test_TEMP_exact_large_identifiers_survive(self):
        biggest, neighbour = "9223372036854775807", "9223372036854775806"
        real, real_neighbour = "100000000343175100", "100000000343175101"
        self.assertEqual(float(biggest), float(neighbour))
        self.assertEqual(float(real), float(real_neighbour))
        nodes = [node(biggest, seed=True), node(real), node("100000008782800100")]
        rows = [tx(biggest, real, 1), tx(real, "100000008782800100", 2)]
        result = run(nodes, rows)
        self.assertEqual(set(result["by_gid"]), {biggest, real, "100000008782800100"})
        self.assertNotIn(neighbour, result["by_gid"])
        self.assertNotIn(real_neighbour, result["by_gid"])
        decoded = json.loads(json.dumps(result))
        witness = decoded["by_gid"]["100000008782800100"]["strict_witness"]
        self.assertEqual(witness["seed_gid"], biggest)
        self.assertEqual([hop["src"] for hop in witness["hops"]], [biggest, real])
        self.assertEqual(decoded["by_gid"][real]["strict_seed_ids"], [biggest])

    def test_TEMP_integer_input_is_normalized_to_strings(self):
        nodes = [{"gid": 100000000343175100, "is_seed": True}, {"gid": 5, "is_seed": 0}]
        rows = [{"src": 100000000343175100, "dst": 5, "date": "2026-07-01", "sum_kzt": 5000}]
        result = compute_temporal(nodes, [{"src": 100000000343175100, "dst": 5}], rows)
        self.assertEqual(list(result["by_gid"]), ["5", "100000000343175100"])
        self.assertEqual(result["by_gid"]["5"]["strict_witness"]["seed_gid"], "100000000343175100")

    def test_TEMP_unsafe_identifiers_are_rejected(self):
        for bad in (1.0e17, True, "0123", "12.0", " 5", "+5", "-0", "", "٣", "9223372036854775808", None):
            with self.subTest(gid=bad), self.assertRaises(ValueError):
                compute_temporal([{"gid": bad, "is_seed": True}], [], [])

    def test_TEMP_invalid_rows_are_rejected_in_russian(self):
        nodes = [node(1, seed=True), node(2)]
        cases = {
            "неизвестный счёт": (nodes, [tx(1, 3, 1)]),
            "повтор счёта": (nodes + [node(2)], [tx(1, 2, 1)]),
            "дата без нулей": (nodes, [{"src": "1", "dst": "2", "date": "2026-7-1", "sum_kzt": 5000.0}]),
            "неделя ISO": (nodes, [{"src": "1", "dst": "2", "date": "2026-W27-3", "sum_kzt": 5000.0}]),
            "нет даты": (nodes, [{"src": "1", "dst": "2", "sum_kzt": 5000.0}]),
            "сумма NaN": (nodes, [{"src": "1", "dst": "2", "date": "2026-07-01", "sum_kzt": float("nan")}]),
            "признак строкой": ([{"gid": "1", "is_seed": "да"}], []),
        }
        for name, (rows_nodes, rows) in cases.items():
            with self.subTest(case=name), self.assertRaises(ValueError) as caught:
                compute_temporal(rows_nodes, [], rows)
            self.assertRegex(str(caught.exception), "[а-яё]")


class TemporalContractTest(unittest.TestCase):
    """Форма результата, неизменность входов, независимость от порядка строк."""

    def setUp(self):
        self.nodes, self.rows = random_case(random.Random(2026), 30, 90, 5)
        self.edges = edges_for(self.rows)

    def test_TEMP_output_shape_matches_contract(self):
        before = copy.deepcopy((self.nodes, self.edges, self.rows))
        result = compute_temporal(self.nodes, self.edges, self.rows)
        self.assertEqual(before, (self.nodes, self.edges, self.rows))
        self.assertEqual(set(result), {"by_gid", "summary"})
        self.assertEqual(set(result["by_gid"]), {row["gid"] for row in self.nodes})
        identifiers = []
        for gid, entry in result["by_gid"].items():
            self.assertEqual(set(entry), TEMPORAL_KEYS)
            identifiers.append(gid)
            self.assertLessEqual(entry["strict_seed_count"], entry["same_day_seed_count"])
            self.assertLessEqual(entry["same_day_seed_count"], entry["static_seed_count"])
            self.assertLessEqual(set(entry["strict_seed_ids"]), set(entry["same_day_seed_ids"]))
            for mode, _ in DATED_MODES:
                ids = entry[f"{mode}_seed_ids"]
                identifiers.extend(ids)
                self.assertEqual(len(ids), entry[f"{mode}_seed_count"])
                self.assertEqual(ids, sorted(set(ids), key=int))
                self.assertNotIn(gid, ids)
                witness = entry[f"{mode}_witness"]
                self.assertEqual(witness is None, not ids)
                if witness:
                    self.assertEqual(set(witness), {"seed_gid", "hops"})
                    identifiers.append(witness["seed_gid"])
                    for hop in witness["hops"]:
                        self.assertEqual(set(hop), {"src", "dst", "date", "sum_kzt"})
                        identifiers.extend((hop["src"], hop["dst"]))
                        self.assertIsNotNone(DATE_PATTERN.fullmatch(hop["date"]), hop["date"])
                        self.assertIsInstance(hop["sum_kzt"], (int, float))
        for value in identifiers:
            self.assertIsInstance(value, str)
            self.assertIsNotNone(GID_PATTERN.fullmatch(value), value)
        json.dumps(result, ensure_ascii=False, allow_nan=False)
        summary = result["summary"]
        for key in ("reachable_from_at_least_1_seed", "reachable_from_at_least_5_seeds", "max_seed_count"):
            self.assertEqual(set(summary[key]), {"static", "strict", "same_day"})
        self.assertEqual([mode["key"] for mode in summary["modes"]], ["static", "strict", "same_day"])
        self.assertTrue(summary["witness_rule"] and summary["seed_count_rule"] and summary["limitations"])
        self.assertEqual(witness_problems(result, self.nodes, self.rows), [])

    def test_TEMP_row_order_does_not_change_any_byte(self):
        rng = random.Random(7)
        baseline = json.dumps(compute_temporal(self.nodes, self.edges, self.rows), ensure_ascii=False)
        for _ in range(25):
            again = compute_temporal(
                shuffled(rng, self.nodes), shuffled(rng, self.edges), shuffled(rng, self.rows)
            )
            self.assertEqual(json.dumps(again, ensure_ascii=False), baseline)

    def test_TEMP_same_day_fixed_point_ignores_row_order(self):
        # Один день, длинная цепочка в обратном порядке строк и цикл внутри дня.
        nodes = [node(1, seed=True)] + [node(gid) for gid in range(2, 8)]
        rows = [tx(gid, gid + 1, 4) for gid in range(6, 0, -1)] + [tx(7, 3, 4)]
        rng = random.Random(11)
        results = {
            json.dumps(run(nodes, shuffled(rng, rows))["by_gid"]["7"]) for _ in range(20)
        }
        self.assertEqual(len(results), 1)
        entry = json.loads(results.pop())
        self.assertEqual(entry["same_day_seed_ids"], ["1"])
        self.assertEqual(len(entry["same_day_witness"]["hops"]), 6)
        self.assertEqual(entry["strict_seed_count"], 0)


class TemporalReferenceTest(unittest.TestCase):
    """Сверка с независимыми способами расчёта на случайных графах."""

    def test_TEMP_matches_brute_force_on_random_small_graphs(self):
        rng = random.Random(20260923)
        for case in range(400):
            nodes, rows = random_case(
                rng, rng.randint(1, 7), rng.randint(0, 12), rng.randint(1, 4), rng.choice([0.2, 0.5, 0.9])
            )
            edges = edges_for(rows)
            result = compute_temporal(nodes, edges, rows)
            static, ranks = brute_force(nodes, rows, edges)
            with self.subTest(case=case):
                self.assertEqual(witness_problems(result, nodes, rows), [])
                for gid, entry in result["by_gid"].items():
                    self.assertEqual(entry["static_seed_count"], len(static[gid]))
                    for mode, _ in DATED_MODES:
                        by_seed = ranks[mode][gid]
                        self.assertEqual(entry[f"{mode}_seed_ids"], sorted(by_seed, key=int))
                        witness = entry[f"{mode}_witness"]
                        if not by_seed:
                            continue
                        hops, day, seed = min((rank + (int(seed),)) for seed, rank in by_seed.items())
                        self.assertEqual(
                            (len(witness["hops"]), witness["hops"][-1]["date"], witness["seed_gid"]),
                            (hops, day, str(seed)),
                        )

    def test_TEMP_matches_day_sweep_on_random_medium_graphs(self):
        rng = random.Random(4840)
        for case in range(40):
            nodes, rows = random_case(rng, rng.randint(20, 80), rng.randint(40, 300), rng.randint(1, 8))
            result = run(nodes, rows)
            with self.subTest(case=case):
                for mode, strict in DATED_MODES:
                    expected = day_sweep(nodes, rows, strict)
                    actual = {gid: entry[f"{mode}_seed_ids"] for gid, entry in result["by_gid"].items()}
                    self.assertEqual(actual, expected)
                self.assertEqual(witness_problems(result, nodes, rows), [])


def official_directory():
    configured = os.environ.get("FINANCE_DATA_DIR")
    directory = Path(configured) if configured else ROOT / "data"
    names = ("nodes.parquet", "edges.parquet", "transactions.parquet")
    return directory if all((directory / name).is_file() for name in names) else None


@unittest.skipUnless(
    official_directory(),
    "нет официальных данных: задайте FINANCE_DATA_DIR или положите три parquet-файла в data/",
)
class TemporalOfficialDataTest(unittest.TestCase):
    """Официальные данные: независимо измеренные счётчики и проверяемые свидетели."""

    @classmethod
    def setUpClass(cls):
        try:
            import pyarrow.parquet as parquet
        except ImportError as error:
            raise unittest.SkipTest("pyarrow не установлен; см. requirements.txt") from error
        directory = official_directory()

        def rows(name):
            table = parquet.read_table(directory / f"{name}.parquet").to_pylist()
            for row in table:
                for key in ("gid", "src", "dst"):
                    if key in row:
                        row[key] = str(row[key])
            return table

        cls.nodes, cls.edges, cls.rows = rows("nodes"), rows("edges"), rows("transactions")
        started = time.perf_counter()
        cls.result = compute_temporal(cls.nodes, cls.edges, cls.rows)
        cls.seconds = time.perf_counter() - started

    def test_TEMP_official_counts_reproduce_independent_measurement(self):
        summary = self.result["summary"]
        self.assertEqual(summary["reachable_from_at_least_5_seeds"], OFFICIAL_AT_LEAST_5)
        self.assertEqual(summary["reachable_from_at_least_1_seed"], OFFICIAL_AT_LEAST_1)
        self.assertEqual(
            (summary["n_nodes"], summary["n_seeds"], summary["n_transactions"], summary["n_days"]),
            (2248, 81, 4840, 31),
        )
        self.assertEqual(len(self.result["by_gid"]), 2248)
        self.assertLess(self.seconds, 30)

    def test_TEMP_official_counts_match_day_sweep_per_account(self):
        for mode, strict in DATED_MODES:
            expected = day_sweep(self.nodes, self.rows, strict)
            actual = {gid: entry[f"{mode}_seed_ids"] for gid, entry in self.result["by_gid"].items()}
            self.assertEqual(actual, expected)

    def test_TEMP_official_witnesses_are_source_transactions(self):
        self.assertEqual(witness_problems(self.result, self.nodes, self.rows), [])


if __name__ == "__main__":
    unittest.main()
