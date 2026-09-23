"""Проверки аналитического ядра: роли, приоритет, кластеры, выгрузки и проверка входных данных.

Запуск: python -m unittest tests.test_core -v
Проверка на официальных данных включается переменной окружения FINANCE_DATA=<каталог>.
Временной модуль здесь заменён тестовым дублёром с формой контракта: ядро проверяется
независимо от него, реальная интеграция проверяется командой и приёмочными тестами.
"""

from __future__ import annotations

import csv
import datetime as dt
import importlib.util
import io
import json
import os
import random
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from backend import policy  # noqa: E402
from backend.analysis import TemporalIntegrationError, _checked_temporal, build_analysis  # noqa: E402
from backend.exports import CLUSTERS_COLUMNS, NODES_COLUMNS, TOP_COLUMNS, render_outputs  # noqa: E402
from backend.io import InputValidationError, load_dataset, to_tiyn, validate_rows  # noqa: E402
from backend.metrics import NodeMetrics  # noqa: E402
from backend.roles import evaluate, ramp, select, transit  # noqa: E402

BASE = 100000000343175100  # больше 2**53: преобразование во float исказило бы идентификатор
INT64_MAX = 2**63 - 1
ROLES = set(policy.ROLE_PRECEDENCE)
TEMPORAL_KEYS = (
    "static_seed_count", "strict_seed_count", "same_day_seed_count",
    "strict_seed_ids", "same_day_seed_ids", "strict_witness", "same_day_witness",
)


def gid(i: int) -> int:
    return BASE + 1000 * i


def temporal_double(strict=None, calls=None):
    """Тестовый дублёр compute_temporal: только форма контракта, без временной логики."""
    strict = strict or {}

    def compute(nodes, edges, transactions):
        if calls is not None:
            calls.append((nodes, edges, transactions))
        by_gid = {}
        for n in nodes:
            k = strict.get(n["gid"], 0)
            by_gid[n["gid"]] = {
                "static_seed_count": k, "strict_seed_count": k, "same_day_seed_count": k,
                "strict_seed_ids": [], "same_day_seed_ids": [], "strict_witness": None, "same_day_witness": None,
            }
        return {"by_gid": by_gid, "summary": {"double": True}}

    return compute


class World:
    """Небольшой граф с заранее известными положительными и отрицательными мотивами."""

    def __init__(self):
        self.nodes = {}
        self.tx = []

    def node(self, i, depth, seed=False, raw=None):
        g = raw if raw is not None else gid(i)
        self.nodes[g] = (depth, seed)
        return g

    def pay(self, a, b, amount, day=5):
        self.tx.append((a, b, dt.date(2026, 7, day), amount))

    def rows(self):
        nodes = [{"gid": g, "depth": d, "is_seed": s} for g, (d, s) in self.nodes.items()]
        agg = {}
        for a, b, _, amount in self.tx:
            e = agg.setdefault((a, b), {"src": a, "dst": b, "tiyn": 0, "n_tx": 0, "depth": self.nodes[a][0] + 1})
            e["tiyn"] += to_tiyn(amount, "fixture")
            e["n_tx"] += 1
        edges = [
            {"src": e["src"], "dst": e["dst"], "sum_kzt": e["tiyn"] / 100, "n_tx": e["n_tx"], "depth": e["depth"]}
            for e in agg.values()
        ]
        tx = [{"src": a, "dst": b, "date": day, "sum_kzt": amount} for a, b, day, amount in self.tx]
        return nodes, edges, tx


def motif_world() -> tuple:
    """Возвращает (World, словарь имён) со всеми шестью ролями и их отрицательными парами."""
    w = World()
    s1, s2, s3, s4 = (w.node(i, 0, seed=True) for i in (1, 2, 3, 4))
    names = {"s1": s1, "s2": s2, "s3": s3, "s4": s4, "s_iso": w.node(5, 0, seed=True)}

    # Консолидатор: 8 плательщиков, исходящих нет → веер побеждает баланс, «конечный» — альтернатива.
    names["C"] = w.node(100, 2)
    for i in range(101, 109):
        p = w.node(i, 1)
        w.pay(s1, p, 50_000)
        w.pay(p, names["C"], 10_000)
    names["P1"], names["P2"] = gid(101), gid(102)
    # Отрицательный консолидатор: 6 плательщиков, но накопление без исходящих → конечный получатель.
    names["C2"] = w.node(110, 2)
    for i in range(111, 117):
        q = w.node(i, 1)
        w.pay(s2, q, 50_000)
        w.pay(q, names["C2"], 20_000)

    # Распределитель: 12 получателей, передано 60% → транзит не срабатывает.
    names["D"] = w.node(200, 1)
    w.pay(s3, names["D"], 1_000_000)
    for i in range(201, 213):
        w.pay(names["D"], w.node(i, 2), 50_000)
    names["R1"] = gid(201)
    # Отрицательный распределитель: 9 получателей, передано 90% → транзит.
    names["D2"] = w.node(220, 1)
    w.pay(s3, names["D2"], 100_000)
    for i in range(221, 230):
        w.pay(names["D2"], w.node(i, 2), 10_000)

    # Транзит: передано 95%. Отрицательный: передано 40%.
    names["T"], names["U"] = w.node(300, 1), w.node(301, 2)
    w.pay(s4, names["T"], 100_000)
    w.pay(names["T"], names["U"], 95_000)
    names["T2"], names["U2"] = w.node(310, 1), w.node(311, 2)
    w.pay(s4, names["T2"], 100_000)
    w.pay(names["T2"], names["U2"], 40_000)

    # Граница выгрузки: веер входящих допустим, выводы об исходящих — нет.
    names["B"] = w.node(400, 4)
    for i in range(401, 409):
        w.pay(w.node(i, 3), names["B"], 30_000)
    names["B2"] = w.node(410, 4)
    w.pay(gid(401), names["B2"], 600_000)
    # Короткое окно наблюдения: поступления за 2 дня до конца периода.
    names["L"] = w.node(420, 2)
    w.pay(names["P1"], names["L"], 300_000, day=29)
    w.pay(names["P2"], names["L"], 300_000, day=29)

    # Координатор: переводы от 3 исходных клиентов. Отрицательный: от 2.
    names["K"], names["K2"] = w.node(500, 1), w.node(510, 1)
    for s in (s1, s2, s3):
        w.pay(s, names["K"], 20_000)
    for s in (s1, s2):
        w.pay(s, names["K2"], 20_000)

    # Дробные суммы и предельный int64-идентификатор.
    names["F"] = w.node(600, 1)
    w.pay(s4, names["F"], 5000.1)
    w.pay(s4, names["F"], 5000.2)
    names["MAX"] = w.node(0, 1, raw=INT64_MAX)
    w.pay(s4, names["MAX"], 7_000)
    # Конец периода — 31 июля.
    w.pay(s1, names["P1"], 5_000, day=31)
    return w, names


def analyse(world, strict=None):
    return build_analysis(validate_rows(*world.rows()), temporal_double(strict))


def node_of(analysis, g):
    return next(n for n in analysis["nodes"] if n["gid"] == str(g))


def metrics(**over):
    base = dict(
        gid=1, depth=1, is_seed=False, in_degree=1, out_degree=1, in_tiyn=100_00, out_tiyn=100_00,
        in_tx=1, out_tx=1, seed_in_count=0, seed_out_count=0, seed_links=0, outgoing_censored=False,
        last_in_date=dt.date(2026, 7, 1), margin_days=30,
    )
    base.update(over)
    return NodeMetrics(**base)


class RoleMotifTests(unittest.TestCase):
    """CORE-ROLES: синтетические положительные и отрицательные мотивы каждой роли."""

    @classmethod
    def setUpClass(cls):
        cls.world, cls.n = motif_world()
        cls.a = analyse(cls.world)

    def role(self, key):
        return node_of(self.a, self.n[key])

    def test_core_roles_consolidator_positive_with_terminal_runner_up(self):
        c = self.role("C")
        self.assertEqual(c["role"], "consolidator")
        self.assertEqual(c["role_alternatives"][0]["role"], "terminal")
        self.assertGreaterEqual(c["role_alternatives"][0]["score"], 0.5)

    def test_core_roles_consolidator_negative_six_payers(self):
        c2 = self.role("C2")
        self.assertNotEqual(c2["role"], "consolidator")
        self.assertEqual(c2["role"], "terminal")

    def test_core_roles_distributor_positive_and_negative(self):
        self.assertEqual(self.role("D")["role"], "distributor")
        d2 = self.role("D2")
        self.assertEqual(d2["role"], "transit")
        dist = next(a for a in d2["role_alternatives"] if a["role"] == "distributor")
        self.assertLess(dist["score"], 0.5)

    def test_core_roles_transit_positive_and_negative(self):
        t = self.role("T")
        self.assertEqual(t["role"], "transit")
        self.assertAlmostEqual(t["metrics"]["pass_through"], 0.95)
        self.assertEqual(self.role("T2")["role"], "peripheral")

    def test_core_roles_terminal_negatives_single_small_payer_and_short_window(self):
        r1 = self.role("R1")
        self.assertEqual(r1["role"], "peripheral")
        self.assertEqual(r1["role_alternatives"][0]["role"], "terminal")
        l_node = self.role("L")
        self.assertNotEqual(l_node["role"], "terminal")
        self.assertTrue(any("окно наблюдения" in w for w in l_node["observation"]["warnings"]))

    def test_core_roles_coordinator_positive_and_negative(self):
        k = self.role("K")
        self.assertEqual(k["role"], "coordinator")
        self.assertEqual(k["metrics"]["seed_in_count"], 3)
        self.assertNotEqual(self.role("K2")["role"], "coordinator")

    def test_core_roles_boundary_fan_in_allowed_outgoing_claims_blocked(self):
        b = self.role("B")
        self.assertEqual(b["role"], "consolidator")
        self.assertTrue(b["observation"]["outgoing_censored"])
        self.assertIsNone(b["metrics"]["pass_through"])
        blocked = {a["role"]: a["score"] for a in b["role_alternatives"]}
        self.assertEqual((blocked["transit"], blocked["distributor"], blocked["terminal"]), (0.0, 0.0, 0.0))
        self.assertIn("4-го шага", b["next_request"])
        b2 = self.role("B2")
        self.assertEqual(b2["role"], "peripheral")
        self.assertIn("исходящие не собирались", b2["evidence"])

    def test_core_roles_isolated_seed_kept(self):
        # R2: у счёта без переводов «сигналов нет» — не довод, поэтому опора 0, а не 1.
        iso = self.role("s_iso")
        self.assertEqual(iso["role"], "peripheral")
        self.assertEqual(iso["role_score"], 0.0)
        self.assertEqual(iso["role_basis"], "peripheral.no_transfers")
        self.assertTrue(iso["is_seed"])
        self.assertIn("нет переводов", iso["evidence"])

    def test_core_roles_all_six_labels_and_alternatives_complete(self):
        self.assertEqual({n["role"] for n in self.a["nodes"]}, ROLES)
        for n in self.a["nodes"]:
            listed = {n["role"]} | {a["role"] for a in n["role_alternatives"]}
            self.assertEqual(listed, ROLES, n["gid"])

    def test_core_roles_seed_transit_blocked_and_threshold_ramp(self):
        seed = transit(metrics(is_seed=True))
        self.assertEqual(seed.score, 0.0)
        self.assertIn("исходный клиент", seed.reason)
        self.assertEqual(ramp(7, 7, 20), 0.5)
        self.assertLess(ramp(6, 7, 20), 0.5)
        self.assertEqual(ramp(40, 7, 20), 1.0)
        self.assertEqual(transit(metrics(out_tiyn=80_00)).score, 0.5)
        self.assertEqual(transit(metrics(in_tx=3, out_tx=3)).score, 1.0)
        # R5: одна пара переводов не даёт полной опоры транзита.
        self.assertLess(transit(metrics()).score, 0.9)
        self.assertLess(transit(metrics(out_tiyn=125_00)).score, 0.5)

    def test_core_roles_tie_uses_precedence(self):
        m = metrics(in_degree=20, out_degree=40, in_tiyn=10**9, out_tiyn=10**9)
        primary, alternatives = select(evaluate(m))
        self.assertEqual(primary.role, "distributor")  # опора 1,0 у двух ролей веера, решает порядок
        self.assertEqual(alternatives[0].role, "consolidator")


class OutputContractTests(unittest.TestCase):
    """CORE-EXPORTS: форма analysis.json и трёх CSV, границы значений, сохранение сумм."""

    @classmethod
    def setUpClass(cls):
        cls.world, cls.n = motif_world()
        cls.a = analyse(cls.world)
        cls.files = render_outputs(cls.a)

    def csv_rows(self, name):
        return list(csv.DictReader(io.StringIO(self.files[name])))

    def test_core_exports_analysis_schema(self):
        a = self.a
        self.assertEqual(a["schema_version"], "finance-workbench/v1")
        for key in ("summary", "policy", "nodes", "edges", "transactions", "clusters", "top_nodes", "temporal_summary"):
            self.assertIn(key, a)
        for key in ("n_nodes", "n_edges", "n_transactions", "n_seed", "total_kzt", "period_start", "period_end",
                    "n_boundary", "n_isolates", "n_weak_components", "input_sha256"):
            self.assertIn(key, a["summary"])
        for key in ("version", "rules", "priority_description", "score_description", "limitations"):
            self.assertIn(key, a["policy"])
        self.assertEqual({r["role"] for r in a["policy"]["rules"]}, ROLES)
        for n in a["nodes"]:
            for key in ("gid", "depth", "is_seed", "role", "role_score", "cluster_id", "priority_score", "evidence",
                        "metrics", "observation", "role_alternatives", "next_request", "temporal"):
                self.assertIn(key, n)
            for key in ("in_degree", "out_degree", "in_kzt", "out_kzt", "in_tx", "out_tx",
                        "seed_in_count", "seed_out_count", "pass_through"):
                self.assertIn(key, n["metrics"])
            self.assertEqual(set(TEMPORAL_KEYS) - set(n["temporal"]), set())
            self.assertIsInstance(n["observation"]["outgoing_censored"], bool)
            self.assertIsInstance(n["gid"], str)
            self.assertTrue(n["next_request"])
        self.assertEqual(a["summary"]["period_start"], "2026-07-05")
        self.assertEqual(a["summary"]["period_end"], "2026-07-31")
        json.loads(self.files["analysis.json"])

    def test_core_exports_bounds_and_exact_ids(self):
        rows = self.csv_rows("nodes_roles.csv")
        self.assertEqual(tuple(rows[0].keys()), NODES_COLUMNS)
        self.assertEqual({r["gid"] for r in rows}, {str(g) for g in self.world.nodes})
        self.assertIn(str(INT64_MAX), {r["gid"] for r in rows})
        self.assertIn(f'"{INT64_MAX}"', self.files["analysis.json"])
        for r in rows:
            self.assertIn(r["role"], ROLES)
            self.assertTrue(0 <= float(r["role_score"]) <= 1)
            self.assertTrue(0 <= float(r["priority_score"]) <= 1)
            self.assertTrue(1 <= len(r["evidence"]) <= 200, r["evidence"])
            int(r["cluster_id"])

    def test_core_exports_clusters_cover_every_node_and_conserve_amounts(self):
        rows = self.csv_rows("clusters.csv")
        self.assertEqual(tuple(rows[0].keys()), CLUSTERS_COLUMNS)
        self.assertEqual(sum(int(r["n_nodes"]) for r in rows), len(self.world.nodes))
        self.assertEqual(sum(int(r["n_seed"]) for r in rows), 5)
        ids = {int(r["cluster_id"]) for r in rows}
        self.assertEqual({n["cluster_id"] for n in self.a["nodes"]}, ids)
        self.assertTrue(all(r["hypothesis"] and r["top_gids"] for r in rows))
        assignment = {n["gid"]: n["cluster_id"] for n in self.a["nodes"]}
        cross = sum(to_tiyn(e["sum_kzt"], "e") for e in self.a["edges"] if assignment[e["src"]] != assignment[e["dst"]])
        internal = sum(to_tiyn(r["sum_kzt_internal"], "c") for r in rows)
        total_edges = sum(to_tiyn(e["sum_kzt"], "e") for e in self.a["edges"])
        total_tx = sum(to_tiyn(t["sum_kzt"], "t") for t in self.a["transactions"])
        self.assertEqual(internal + cross, total_edges)
        self.assertEqual(total_edges, total_tx)
        self.assertEqual(to_tiyn(self.a["summary"]["total_kzt"], "s"), total_tx)

    def test_core_exports_top_nodes_sorted_with_reasons(self):
        rows = self.csv_rows("top_nodes.csv")
        self.assertEqual(tuple(rows[0].keys()), TOP_COLUMNS)
        self.assertEqual(len(rows), min(policy.TOP_N, len(self.world.nodes)))
        self.assertEqual([int(r["rank"]) for r in rows], list(range(1, len(rows) + 1)))
        scores = [float(r["priority_score"]) for r in rows]
        self.assertEqual(scores, sorted(scores, reverse=True))
        self.assertTrue(all(r["why"] for r in rows))

    def test_core_exports_fractional_amounts_exact(self):
        f_edge = next(e for e in self.a["edges"] if e["dst"] == str(self.n["F"]))
        self.assertEqual(f_edge["sum_kzt"], 10000.3)
        self.assertEqual(f_edge["n_tx"], 2)
        self.assertEqual(to_tiyn(0.1, "x") + to_tiyn(0.2, "x"), to_tiyn(0.3, "x"))

    def test_core_exports_temporal_receives_contract_shapes(self):
        calls = []
        build_analysis(validate_rows(*self.world.rows()), temporal_double(calls=calls))
        nodes, edges, tx = calls[0]
        self.assertTrue(all(isinstance(n["gid"], str) for n in nodes))
        self.assertTrue(all(isinstance(e["src"], str) and isinstance(e["dst"], str) for e in edges))
        self.assertTrue(all(isinstance(t["date"], str) and len(t["date"]) == 10 for t in tx))
        self.assertEqual(len(tx), len(self.world.tx))


class DeterminismTests(unittest.TestCase):
    """CORE-DETERMINISM: повторный запуск и перестановка строк дают те же байты."""

    def test_core_determinism_rerun_and_row_shuffle(self):
        world, _ = motif_world()
        nodes, edges, tx = world.rows()
        first = render_outputs(build_analysis(validate_rows(nodes, edges, tx), temporal_double()))
        again = render_outputs(build_analysis(validate_rows(nodes, edges, tx), temporal_double()))
        self.assertEqual(first, again)
        rng = random.Random(7)
        for _ in range(3):
            shuffled = [list(rows) for rows in (nodes, edges, tx)]
            for rows in shuffled:
                rng.shuffle(rows)
            other = render_outputs(build_analysis(validate_rows(*shuffled), temporal_double()))
            self.assertEqual(first, other)


class PriorityTests(unittest.TestCase):
    """CORE-PRIORITY: приоритет отделён от роли и складывается из раскрытых семейств."""

    def test_core_priority_chronology_family_is_one_bounded_input(self):
        world, n = motif_world()
        base = node_of(analyse(world), n["K"])
        boosted = node_of(analyse(world, strict={str(n["K"]): 5}), n["K"])
        self.assertAlmostEqual(boosted["priority_score"] - base["priority_score"], 0.15, places=4)
        self.assertEqual(boosted["role"], base["role"])
        self.assertEqual(boosted["role_score"], base["role_score"])

    def test_core_priority_families_disclosed_and_isolate_zero(self):
        world, n = motif_world()
        a = analyse(world)
        self.assertEqual(set(a["policy"]["priority_weights"]), set(policy.PRIORITY_WEIGHTS))
        self.assertAlmostEqual(sum(policy.PRIORITY_WEIGHTS.values()), 1.0)
        self.assertEqual(node_of(a, n["s_iso"])["priority_score"], 0.0)
        for node in a["nodes"]:
            fam = node["priority_families"]
            expected = round(sum(policy.PRIORITY_WEIGHTS[k] * fam[k] for k in fam), 4)
            self.assertAlmostEqual(node["priority_score"], expected, places=3)


class ValidationTests(unittest.TestCase):
    """CORE-VALIDATION: нарушения контракта входных данных останавливают конвейер."""

    def setUp(self):
        world, _ = motif_world()
        self.nodes, self.edges, self.tx = world.rows()

    def assertRejected(self, fragment, nodes=None, edges=None, tx=None):
        with self.assertRaises(InputValidationError) as ctx:
            validate_rows(nodes or self.nodes, edges or self.edges, tx or self.tx)
        self.assertIn(fragment, str(ctx.exception))

    def test_core_validation_sum_and_count_mismatch(self):
        edges = [dict(e) for e in self.edges]
        edges[0]["sum_kzt"] += 1
        self.assertRejected("не совпадают", edges=edges)
        edges = [dict(e) for e in self.edges]
        edges[0]["n_tx"] += 1
        self.assertRejected("не совпадают", edges=edges)

    def test_core_validation_duplicates_endpoints_and_orphans(self):
        self.assertRejected("повторяются gid", nodes=self.nodes + [dict(self.nodes[0])])
        self.assertRejected("повторяются пары", edges=self.edges + [dict(self.edges[0])])
        ghost = dict(self.edges[0], dst=gid(9999))
        self.assertRejected("которых нет в nodes", edges=self.edges + [ghost])
        orphan = dict(self.tx[0], dst=self.tx[0]["src"] + 1)
        self.assertRejected("без агрегированного ребра", tx=self.tx + [orphan])

    def test_core_validation_values(self):
        bad = [dict(t) for t in self.tx]
        bad[0]["sum_kzt"] = 0
        self.assertRejected("положительной", tx=bad)
        bad = [dict(n) for n in self.nodes]
        bad[0]["gid"] = float(bad[0]["gid"])
        self.assertRejected("int64", nodes=bad)
        loop = dict(self.edges[0], dst=self.edges[0]["src"])
        self.assertRejected("самому себе", edges=self.edges + [loop])
        bad = [dict(t) for t in self.tx]
        bad[0]["date"] = "31.07.2026"
        self.assertRejected("дата", tx=bad)
        with self.assertRaises(InputValidationError):
            to_tiyn(0.001, "x")

    def test_core_validation_temporal_result_checked(self):
        with self.assertRaises(TemporalIntegrationError):
            _checked_temporal({"by_gid": {}, "summary": {}}, ["1"])
        with self.assertRaises(TemporalIntegrationError):
            _checked_temporal({"by_gid": {"1": {"strict_seed_count": 0}}, "summary": {}}, ["1"])


def write_parquet(directory: Path, nodes, edges, tx, gid_type=pa.int64()):
    pq.write_table(pa.table({
        "gid": pa.array([n["gid"] if pa.types.is_integer(gid_type) else float(n["gid"]) for n in nodes], gid_type),
        "depth": pa.array([n["depth"] for n in nodes], pa.int64()),
        "is_seed": pa.array([n["is_seed"] for n in nodes], pa.bool_()),
    }), directory / "nodes.parquet")
    pq.write_table(pa.table({
        "src": pa.array([e["src"] for e in edges], pa.int64()),
        "dst": pa.array([e["dst"] for e in edges], pa.int64()),
        "sum_kzt": pa.array([e["sum_kzt"] for e in edges], pa.float64()),
        "n_tx": pa.array([e["n_tx"] for e in edges], pa.int64()),
        "depth": pa.array([e["depth"] for e in edges], pa.int8()),
    }), directory / "edges.parquet")
    pq.write_table(pa.table({
        "src": pa.array([t["src"] for t in tx], pa.int64()),
        "dst": pa.array([t["dst"] for t in tx], pa.int64()),
        "date": pa.array([t["date"] for t in tx], pa.date32()),
        "sum_kzt": pa.array([t["sum_kzt"] for t in tx], pa.float64()),
    }), directory / "transactions.parquet")


class ParquetAndCliTests(unittest.TestCase):
    """CORE-CLI: чтение parquet, коды выхода и русские сообщения командной строки."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        world, _ = motif_world()
        self.rows = world.rows()

    def tearDown(self):
        self.tmp.cleanup()

    def run_cli(self, data, out):
        return subprocess.run(
            [sys.executable, "-m", "backend", "--data", str(data), "--out", str(out)],
            cwd=ROOT, capture_output=True, text=True, timeout=120,
        )

    def test_core_cli_parquet_roundtrip_matches_rows(self):
        write_parquet(self.dir, *self.rows)
        from_file = render_outputs(build_analysis(load_dataset(self.dir), temporal_double()))
        from_rows = render_outputs(build_analysis(validate_rows(*self.rows), temporal_double()))
        self.assertEqual(from_file, from_rows)

    def test_core_cli_rejects_float_ids_and_nulls(self):
        nodes, edges, tx = self.rows
        write_parquet(self.dir, nodes, edges, tx, gid_type=pa.float64())
        with self.assertRaises(InputValidationError) as ctx:
            load_dataset(self.dir)
        self.assertIn("int64", str(ctx.exception))
        write_parquet(self.dir, nodes, edges, tx)
        table = pq.read_table(self.dir / "transactions.parquet")
        sums = table.column("sum_kzt").to_pylist()
        sums[0] = None
        pq.write_table(table.set_column(3, "sum_kzt", pa.array(sums, pa.float64())), self.dir / "transactions.parquet")
        with self.assertRaises(InputValidationError) as ctx:
            load_dataset(self.dir)
        self.assertIn("пустых значений", str(ctx.exception))

    def test_core_cli_exit_codes(self):
        nodes, edges, tx = self.rows
        broken = [dict(e) for e in edges]
        broken[0]["sum_kzt"] += 1
        write_parquet(self.dir, nodes, broken, tx)
        bad = self.run_cli(self.dir, self.dir / "out")
        self.assertEqual(bad.returncode, 2, bad.stderr)
        self.assertIn("Ошибка входных данных", bad.stderr)
        self.assertFalse((self.dir / "out" / "nodes_roles.csv").exists())

        write_parquet(self.dir, nodes, edges, tx)
        good = self.run_cli(self.dir, self.dir / "out")
        if importlib.util.find_spec("backend.temporal") is None:
            # Временной модуль ещё не подключён: команда обязана честно остановиться.
            self.assertEqual(good.returncode, 3, good.stderr)
            self.assertIn("backend.temporal", good.stderr)
        else:
            self.assertEqual(good.returncode, 0, good.stderr)
            for name in ("nodes_roles.csv", "clusters.csv", "top_nodes.csv", "analysis.json", "run_receipt.json"):
                self.assertTrue((self.dir / "out" / name).is_file(), name)


@unittest.skipUnless(os.environ.get("FINANCE_DATA"), "FINANCE_DATA не задан: проверка на официальных данных пропущена")
class OfficialDataTests(unittest.TestCase):
    """CORE-OFFICIAL: полный прогон ядра на данных организаторов (временной модуль — дублёр)."""

    def test_core_official_counts_roles_and_bounds(self):
        data = load_dataset(os.environ["FINANCE_DATA"])
        a = build_analysis(data, temporal_double())
        s = a["summary"]
        self.assertEqual(
            (s["n_nodes"], s["n_edges"], s["n_transactions"], s["n_seed"], s["n_boundary"], s["n_isolates"],
             s["n_weak_components"]),
            (2248, 3119, 4840, 81, 444, 19, 35),
        )
        self.assertEqual({n["role"] for n in a["nodes"]}, ROLES)
        self.assertTrue(all(1 <= len(n["evidence"]) <= 200 for n in a["nodes"]))
        self.assertEqual(sum(c["n_nodes"] for c in a["clusters"]), 2248)
        self.assertEqual(sum(c["n_seed"] for c in a["clusters"]), 81)
        self.assertGreaterEqual(len(a["top_nodes"]), 20)
        boundary = [n for n in a["nodes"] if n["observation"]["outgoing_censored"]]
        self.assertTrue(all(n["role"] in ("consolidator", "coordinator", "peripheral") for n in boundary))


if __name__ == "__main__":
    unittest.main()
