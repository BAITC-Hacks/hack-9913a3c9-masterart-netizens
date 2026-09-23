"""Регрессии по независимой проверке правил ролей (R1–R9) и счёту контрагентов.

Каждый тест назван по номеру дефекта: на коде до исправления он падает, после — проходит.
Запуск: python -m unittest tests.test_roles_repair -v
"""

from __future__ import annotations

import datetime as dt
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from backend import __main__ as cli  # noqa: E402
from backend.clusters import summarize  # noqa: E402
from backend.fmt import score_ru  # noqa: E402
from backend.io import InputValidationError, to_tiyn, validate_rows  # noqa: E402
from backend.metrics import NodeMetrics, compute_metrics  # noqa: E402
from backend.roles import evaluate, evidence_text, next_request, select, transit  # noqa: E402

BASE = 100000000343175100  # больше 2**53, как в данных организаторов


def gid(i: int) -> int:
    return BASE + i * 100


def node(**over) -> NodeMetrics:
    base = dict(
        gid=gid(1), depth=2, is_seed=False, in_degree=1, out_degree=0, in_tiyn=100_00, out_tiyn=0,
        in_tx=1, out_tx=0, seed_in_count=0, seed_out_count=0, seed_links=0, outgoing_censored=False,
        last_in_date=dt.date(2026, 7, 1), margin_days=30,
    )
    base.update(over)
    return NodeMetrics(**base)


def dataset(transfers: list, depth: dict):
    """Набор данных из списка (плательщик, получатель, день июля, сумма ₸) и глубин узлов."""
    nodes = [{"gid": g, "depth": d, "is_seed": d == 0} for g, d in depth.items()]
    edges: dict = {}
    for a, b, _, amount in transfers:
        e = edges.setdefault((a, b), {"src": a, "dst": b, "sum_kzt": 0.0, "n_tx": 0, "depth": depth[a] + 1})
        e["sum_kzt"] += amount
        e["n_tx"] += 1
    tx = [{"src": a, "dst": b, "date": dt.date(2026, 7, day), "sum_kzt": amount} for a, b, day, amount in transfers]
    return validate_rows(nodes, list(edges.values()), tx)


def primary_of(m: NodeMetrics):
    return select(evaluate(m))


class RoleRepairTests(unittest.TestCase):
    def test_R1_small_outflow_large_inflow_is_terminal_candidate(self):
        m = node(in_degree=2, in_tiyn=4_500_000_00, out_degree=1, out_tiyn=180_300_00, in_tx=2, out_tx=1,
                 margin_days=15, value_margin_days=15)
        primary, alternatives = primary_of(m)
        self.assertEqual(primary.role, "terminal")
        self.assertEqual(primary.code, "terminal.small_outflow")
        self.assertGreaterEqual(primary.score, 0.5)
        self.assertIn("исходящие — 4% наблюдаемых входящих", evidence_text(m, primary, alternatives[0]))
        # Отрицательный случай: ушло 30% — это уже не накопление.
        passed_on = node(in_degree=2, in_tiyn=4_500_000_00, out_degree=1, out_tiyn=1_350_000_00, in_tx=2, out_tx=1,
                         margin_days=15, value_margin_days=15)
        term = next(c for c in evaluate(passed_on) if c.role == "terminal")
        self.assertEqual((term.score, term.code), (0.0, "terminal.outgoing"))

    def test_R1_late_bulk_inflow_defers_the_verdict(self):
        m = node(in_degree=2, in_tiyn=2_600_000_00, out_degree=1, out_tiyn=150_000_00, in_tx=2, out_tx=1,
                 margin_days=2, value_margin_days=2)
        primary, _ = primary_of(m)
        self.assertEqual((primary.role, primary.code), ("peripheral", "peripheral.late_inflow"))
        self.assertLessEqual(primary.score, 0.5)
        self.assertIn("после конца периода", next_request(m, primary.role))

    def test_R2_missing_observation_does_not_inflate_no_signal_support(self):
        cutoff, _ = primary_of(node(depth=4, outgoing_censored=True, in_tiyn=50_000_00))
        self.assertEqual(cutoff.code, "peripheral.cutoff")
        self.assertLessEqual(cutoff.score, 0.5)
        isolate, _ = primary_of(node(in_degree=0, in_tiyn=0, in_tx=0, last_in_date=None, margin_days=None))
        self.assertEqual((isolate.score, isolate.code), (0.0, "peripheral.no_transfers"))
        short, _ = primary_of(node(in_tiyn=900_000_00, margin_days=3, value_margin_days=3))
        self.assertEqual(short.code, "peripheral.short_window")
        self.assertLessEqual(short.score, 0.5)
        # Полное наблюдение без признаков по-прежнему даёт высокую опору «сигналов нет».
        quiet, _ = primary_of(node(in_tiyn=20_000_00, margin_days=30, value_margin_days=30))
        self.assertGreater(quiet.score, 0.5)

    def test_R2_late_small_inflow_does_not_reset_the_window(self):
        a, b, c, big = gid(1), gid(2), gid(3), gid(4)
        data = dataset([(a, big, 2, 3_000_000.0), (b, big, 3, 1_000_000.0), (c, big, 30, 5_000.0), (a, c, 1, 10_000.0)],
                       {a: 0, b: 0, c: 1, big: 1})
        m = compute_metrics(data)[big]
        self.assertEqual(m.margin_days, 0)  # последнее поступление — в последний день
        self.assertEqual(m.value_margin_days, 27)  # 90% суммы пришло к 3 июля
        primary, _ = primary_of(m)
        self.assertEqual((primary.role, primary.code), ("terminal", "terminal.no_outgoing"))

    def test_R3_short_window_card_asks_for_more_data(self):
        m = node(in_tiyn=90_000_00, margin_days=2, value_margin_days=2)
        primary, _ = primary_of(m)
        request = next_request(m, primary.role)
        self.assertFalse(request.startswith("Дополнительный запрос не нужен"), request)
        self.assertIn("после конца периода", request)

    def test_R4_outflow_before_first_inflow_is_not_transit(self):
        a, b, c = gid(1), gid(2), gid(3)
        data = dataset([(b, c, 3, 100_000.0), (a, b, 10, 100_000.0)], {a: 0, b: 1, c: 2})
        cand = transit(compute_metrics(data)[b])
        self.assertEqual((cand.score, cand.code), (0.0, "transit.no_dated_forward"))

    def test_R4_back_and_forth_with_one_counterparty_is_not_transit(self):
        a, b = gid(1), gid(2)
        data = dataset([(a, b, 3, 1_000.0 * 1000), (b, a, 24, 30_000.0), (a, b, 29, 30_000.0)], {a: 0, b: 1})
        m = compute_metrics(data)[b]
        self.assertEqual(m.forward_tiyn, 0)
        self.assertEqual(transit(m).score, 0.0)

    def test_R4_valid_chain_survives_when_recipient_also_pays(self):
        # A→B, затем B→C, а C позже тоже платит B: получатели ⊆ плательщики, но цепочка настоящая.
        a, b, c = gid(1), gid(2), gid(3)
        data = dataset([(a, b, 5, 100_000.0), (a, b, 6, 50_000.0), (b, c, 6, 50_000.0), (b, c, 7, 50_000.0),
                        (b, c, 8, 50_000.0), (c, b, 20, 10_000.0)], {a: 0, b: 1, c: 2})
        m = compute_metrics(data)[b]
        self.assertEqual(m.forward_tiyn, 150_000_00)  # 150 000 из 160 000 ₸ — внутри коридора 80–120%
        cand = transit(m)
        self.assertEqual(cand.code, "transit.dated_forward")
        self.assertGreaterEqual(cand.score, 0.5)

    def test_R4_date_check_never_creates_transit_from_incomplete_balance(self):
        # Отправлено 150% полученного: даже если после поступлений ушло ровно 100%, баланс неполон.
        cand = transit(node(out_degree=2, out_tiyn=150_00, forward_tiyn=100_00, in_tx=3, out_tx=3))
        self.assertLess(cand.score, 0.5)
        self.assertIn("баланс в выгрузке неполон", cand.reason)

    def test_R4_same_day_order_is_allowed_but_not_assumed(self):
        a, b, c = gid(1), gid(2), gid(3)
        data = dataset([(a, b, 5, 100_000.0), (b, c, 5, 100_000.0)], {a: 0, b: 1, c: 2})
        self.assertEqual(compute_metrics(data)[b].forward_tiyn, 100_000_00)

    def test_R5_single_pair_cannot_saturate_transit(self):
        thin = transit(node(out_degree=1, out_tiyn=100_00, in_tx=1, out_tx=1))
        full = transit(node(out_degree=1, out_tiyn=100_00, in_tx=3, out_tx=3))
        self.assertLess(thin.score, 0.9)
        self.assertGreaterEqual(thin.score, 0.5)
        self.assertIn("операций мало", thin.reason)
        self.assertEqual(full.score, 1.0)

    def test_R6_cluster_star_counts_each_account_pair_once(self):
        hub, l1, l2, l3, l4 = (gid(i) for i in range(1, 6))
        edges = [{"src": s, "dst": d, "tiyn": 10_000_00, "n_tx": 1, "depth": 1}
                 for s, d in ((hub, l1), (l1, hub), (hub, l2), (l2, hub), (hub, l3), (hub, l4))]
        gids = [hub, l1, l2, l3, l4]
        metrics = {g: node(gid=g) for g in gids}
        rows = summarize({g: 1 for g in gids}, edges, metrics, {g: "peripheral" for g in gids}, dict.fromkeys(gids, 0.5))
        self.assertIn("связей 4 из 4 возможных", rows[0]["hypothesis"])

    def test_R7_sub_threshold_score_is_not_shown_as_threshold(self):
        self.assertEqual(score_ru(0.4999), "0,49")
        self.assertEqual(score_ru(0.5), "0,50")
        self.assertEqual(score_ru(0.8571), "0,86")

    def test_R8_float_noise_sum_is_accepted_and_real_mismatch_rejected(self):
        noisy = 80245.36 + 151153.35
        self.assertEqual(to_tiyn(noisy, "test"), 23139871)
        with self.assertRaises(InputValidationError):
            to_tiyn(0.001, "test")
        a, b = gid(1), gid(2)
        nodes = [{"gid": a, "depth": 0, "is_seed": True}, {"gid": b, "depth": 1, "is_seed": False}]
        tx = [{"src": a, "dst": b, "date": dt.date(2026, 7, 1), "sum_kzt": 80245.36},
              {"src": a, "dst": b, "date": dt.date(2026, 7, 2), "sum_kzt": 151153.35}]
        validate_rows(nodes, [{"src": a, "dst": b, "sum_kzt": noisy, "n_tx": 2, "depth": 1}], tx)
        with self.assertRaises(InputValidationError):
            validate_rows(nodes, [{"src": a, "dst": b, "sum_kzt": noisy + 0.01, "n_tx": 2, "depth": 1}], tx)

    def test_R9_stronger_alternative_explains_why_it_lost(self):
        m = node(in_degree=7, in_tiyn=9_000_000_00, in_tx=7, margin_days=25, value_margin_days=25)
        primary, alternatives = primary_of(m)
        self.assertEqual(primary.role, "consolidator")
        self.assertGreater(alternatives[0].score, primary.score)
        self.assertIn("веера приоритетнее", evidence_text(m, primary, alternatives[0]))

    def test_counterparties_count_each_account_once(self):
        a, b, c, d = gid(1), gid(2), gid(3), gid(4)
        data = dataset([(a, b, 1, 10_000.0), (b, a, 2, 10_000.0), (c, b, 3, 10_000.0), (b, d, 4, 10_000.0)],
                       {a: 0, b: 1, c: 0, d: 2})
        m = compute_metrics(data)
        self.assertEqual(m[b].counterparties, 3)  # A, C, D: встречные переводы с A — один контрагент
        self.assertEqual(m[a].counterparties, 1)
        self.assertEqual(node(in_degree=2, out_degree=3).counterparties, 5)  # без транзакций — прежний расчёт


class EvidenceFitTests(unittest.TestCase):
    def test_evidence_gap_note_never_cuts_the_explanation(self):
        m = node(in_degree=3, in_tiyn=2_635_000_00, out_degree=1, out_tiyn=390_000_00, in_tx=3, out_tx=1,
                 margin_days=2, value_margin_days=2)
        primary, alternatives = primary_of(m)
        text = evidence_text(m, primary, alternatives[0])
        self.assertLessEqual(len(text), 200)
        self.assertFalse(text.endswith("…"), text)

    @unittest.skipUnless(os.environ.get("FINANCE_DATA"), "FINANCE_DATA не задан")
    def test_no_official_evidence_is_clipped(self):
        from backend.analysis import build_analysis
        from backend.io import load_dataset

        nodes = build_analysis(load_dataset(os.environ["FINANCE_DATA"]))["nodes"]
        clipped = [n["gid"] for n in nodes if n["evidence"].endswith("…")]
        self.assertEqual(clipped, [])


class TopListTests(unittest.TestCase):
    @unittest.skipUnless(os.environ.get("FINANCE_DATA"), "FINANCE_DATA не задан")
    def test_top_list_starts_with_accounts_beyond_known_clients(self):
        from backend.analysis import build_analysis
        from backend.io import load_dataset

        a = build_analysis(load_dataset(os.environ["FINANCE_DATA"]))
        seeds = {n["gid"] for n in a["nodes"] if n["is_seed"]}
        top = a["top_nodes"]
        self.assertEqual(len(top), 30)
        self.assertFalse(seeds & {t["gid"] for t in top})
        self.assertEqual([t["rank"] for t in top], list(range(1, 31)))
        scores = [t["priority_score"] for t in top]
        self.assertEqual(scores, sorted(scores, reverse=True))
        best = max((n for n in a["nodes"] if not n["is_seed"]), key=lambda n: (n["priority_score"], -int(n["gid"])))
        self.assertEqual(top[0]["gid"], best["gid"])
        self.assertTrue(a["policy"]["top_excludes_seeds"])


class FailedRunTests(unittest.TestCase):
    def test_failed_run_keeps_prior_outputs_and_marks_the_attempt(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "out"
            out.mkdir()
            prior = out / "nodes_roles.csv"
            prior.write_text("gid,role\n", encoding="utf-8")
            code = cli.main(["--data", str(Path(tmp) / "missing"), "--out", str(out)])
            self.assertEqual(code, 2)
            self.assertEqual(prior.read_text(encoding="utf-8"), "gid,role\n")
            attempt = json.loads((out / "last_attempt.json").read_text(encoding="utf-8"))
            self.assertEqual((attempt["status"], attempt["exit_code"]), ("failed", 2))
            self.assertIn("предыдущего успешного запуска", attempt["note"])


if __name__ == "__main__":
    unittest.main()
