"""Проверки PDF-справки: точные идентификаторы и суммы в тексте PDF, запреты запроса, CLI.

Запуск: python -m unittest tests.test_reports -v  (нужны reportlab и pypdf).
Проверка на реальном файле анализа включается переменной FINANCE_ANALYSIS=<путь к analysis.json>.
Тестовый файл анализа собран здесь же: он повторяет форму analysis.json и содержит
граничные случаи — копейки в сумме, граница сбора, счёт без переводов, малый отток.
"""

from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

HAS_DEPS = all(importlib.util.find_spec(name) for name in ("reportlab", "pypdf"))
SKIP_REASON = "SKIP: нет reportlab или pypdf — установите reportlab==4.4.9 и pypdf"

A = "100000000000000100"
B = "100000000000000200"
C = "100000000000000300"
D = "100000000000000400"
SEED = "100000000000000900"
SHA = "ab" * 32


def _node(gid, role, basis, metrics, *, censored=False, warnings=(), witness=None, alternatives=None, seed=False):
    base = {
        "in_degree": 0, "out_degree": 0, "in_kzt": 0, "out_kzt": 0, "in_tx": 0, "out_tx": 0,
        "seed_in_count": 0, "seed_out_count": 0, "pass_through": None, "forward_share": None,
        "counterparties": 0, "seed_links": 0, "last_in_date": None, "observation_margin_days": None, "value_window_days": None,
    }
    base.update(metrics)
    return {
        "gid": gid, "depth": 0 if seed else 2, "is_seed": seed, "role": role, "role_score": 0.85, "role_basis": basis,
        "cluster_id": 7, "priority_score": 0.61, "evidence": f"Основание для {gid} < порога & выше нуля",
        "metrics": base, "observation": {"outgoing_censored": censored, "warnings": list(warnings)},
        "role_alternatives": alternatives if alternatives is not None else [
            {"role": "consolidator", "score": 0.0714, "reason": "разных плательщиков: 1 (порог 7); окно после 90% суммы — 15 дн.", "basis": "consolidator.payers"},
            {"role": "distributor", "score": 0.0, "reason": "получателей нет", "basis": "distributor.recipients"},
            {"role": "peripheral", "score": 0.15, "reason": "1 минус сильнейший признак", "basis": "peripheral.below_threshold"},
        ],
        "next_request": "Запросить снятия наличных и мелкие (< 5 000 ₸) списания.",
        "priority_families": {"role_signal": 0.5},
        "temporal": {
            "static_seed_count": 3, "strict_seed_count": 1 if witness else 0, "same_day_seed_count": 1 if witness else 0,
            "strict_seed_ids": [], "same_day_seed_ids": [], "strict_witness": witness, "same_day_witness": witness,
        },
    }


def sample_analysis() -> dict:
    witness = {"seed_gid": SEED, "hops": [
        {"src": SEED, "dst": B, "date": "2026-07-03", "sum_kzt": 248500},
        {"src": B, "dst": A, "date": "2026-07-08", "sum_kzt": 12345678.91},
    ]}
    nodes = [
        _node(A, "terminal", "terminal.small_outflow", {"in_degree": 1, "out_degree": 1, "in_kzt": 12345678.91, "out_kzt": 57500, "in_tx": 1, "out_tx": 1,
              "pass_through": 0.0047, "last_in_date": "2026-07-08", "observation_margin_days": 23, "value_window_days": 23}, witness=witness),
        _node(B, "transit", "transit.dated_forward", {"in_degree": 1, "out_degree": 1, "in_kzt": 248500, "out_kzt": 12345678.91, "in_tx": 1, "out_tx": 1}),
        _node(C, "peripheral", "peripheral.cutoff", {"in_degree": 1, "in_kzt": 7000, "in_tx": 1, "last_in_date": "2026-07-18"}, censored=True,
              warnings=["Исходящие переводы за границей выгрузки (глубина 4) не собирались."]),
        _node(D, "peripheral", "peripheral.no_transfers", {}, warnings=["В выгрузке нет переводов этого счёта."], alternatives=[
            {"role": "coordinator", "score": 0.0, "reason": "связей нет", "basis": "coordinator.seed_links"}]),
        _node(SEED, "distributor", "distributor.recipients", {"out_degree": 1, "out_kzt": 248500, "out_tx": 1}, seed=True),
    ]
    transactions = [
        {"src": SEED, "dst": B, "date": "2026-07-03", "sum_kzt": 248500},
        {"src": B, "dst": A, "date": "2026-07-08", "sum_kzt": 12345678.91},
        {"src": A, "dst": SEED, "date": "2026-07-20", "sum_kzt": 57500},
        {"src": B, "dst": C, "date": "2026-07-18", "sum_kzt": 7000},
    ]
    rules = [{"role": r, "label": l, "description": f"Правило «{l}».", "thresholds": {}} for r, l in (
        ("coordinator", "координатор"), ("distributor", "распределитель"), ("consolidator", "консолидатор"),
        ("transit", "транзит"), ("terminal", "конечный получатель"), ("peripheral", "периферийный"))]
    return {
        "schema_version": "finance-workbench/v1",
        "summary": {"input_sha256": SHA, "period_start": "2026-07-01", "period_end": "2026-07-31"},
        "policy": {"version": "finance-policy/2", "rules": rules, "limitations": ["Дата без времени не задаёт порядок операций внутри дня."],
                   "score_description": "эвристика", "priority_description": "очередь"},
        "nodes": nodes,
        "edges": [],
        "transactions": transactions,
        "clusters": [{"cluster_id": 7, "n_nodes": 5, "n_seed": 1, "sum_kzt_internal": 12658678.91, "top_gids": [A], "hypothesis": "Группа из 5 счетов."}],
        "top_nodes": [{"rank": 1, "gid": A, "role": "terminal", "priority_score": 0.61, "why": "—"}],
        "temporal_summary": {},
    }


def pdf_text(data: bytes) -> str:
    """Текст всех страниц; неразрывные пробелы приводятся к обычным для сравнения."""
    from io import BytesIO

    from pypdf import PdfReader

    reader = PdfReader(BytesIO(data))
    text = "\n".join(page.extract_text() or "" for page in reader.pages)
    return text.replace(" ", " ").replace(" ", " ")


def one_line(text: str) -> str:
    return " ".join(text.split())


def page_texts(data: bytes) -> list:
    from io import BytesIO

    from pypdf import PdfReader

    return [one_line(page.extract_text() or "") for page in PdfReader(BytesIO(data)).pages]


def basis_codes(analysis: dict) -> set:
    """Машинные коды оснований (peripheral.below_threshold и т. п.): в тексте справки их быть не должно."""
    codes = {n["role_basis"] for n in analysis["nodes"]}
    for node in analysis["nodes"]:
        codes |= {alt["basis"] for alt in node.get("role_alternatives", [])}
    return codes


class FormattingTests(unittest.TestCase):
    def test_pdf_fmt_exact_kzt_from_json_numbers(self):
        from reports.facts import kzt

        self.assertEqual(kzt(29510727.39), "29 510 727,39 ₸")
        self.assertEqual(kzt(393066), "393 066 ₸")
        self.assertEqual(kzt(5000.5), "5 000,50 ₸")
        self.assertEqual(kzt(0), "0 ₸")

    def test_pdf_fmt_score_below_threshold_not_rounded_up(self):
        from reports.facts import score

        self.assertEqual(score(0.4999), "0,49")
        self.assertEqual(score(0.8477), "0,85")

    def test_pdf_fmt_small_share_is_not_zero(self):
        from reports.facts import share

        self.assertEqual(share(0.0047), "0,5%")
        self.assertEqual(share(0.023), "2,3%")
        self.assertEqual(share(0.0001), "< 0,1%")
        self.assertEqual(share(0.0), "0%")


class RequestValidationTests(unittest.TestCase):
    def assertRefused(self, gids, mode="structural", status=400):
        from reports.facts import ReportRequestError, validate_request

        with self.assertRaises(ReportRequestError) as ctx:
            validate_request(sample_analysis(), gids, mode)
        self.assertEqual(ctx.exception.status, status)
        self.assertTrue(str(ctx.exception))
        return str(ctx.exception)

    def test_pdf_req_refuses_bad_selection(self):
        self.assertRefused([])
        self.assertIn("дважды", self.assertRefused([A, A]))
        self.assertRefused([int(A)])
        self.assertRefused([f" {A}"])
        self.assertRefused([A + ".0"])
        self.assertRefused(A)
        self.assertRefused([A], mode="fast")
        self.assertIn("999", self.assertRefused(["999"], status=404))
        self.assertRefused([str(10**17 + i) for i in range(26)], status=413)

    def test_pdf_req_accepts_exact_ids_in_order(self):
        from reports.facts import validate_request

        nodes = validate_request(sample_analysis(), [C, A], "strict")
        self.assertEqual([n["gid"] for n in nodes], [C, A])


@unittest.skipUnless(HAS_DEPS, SKIP_REASON)
class RenderTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from reports import render_pdf

        cls.analysis = sample_analysis()
        cls.single = render_pdf(cls.analysis, [A], "strict")
        cls.multi = render_pdf(cls.analysis, [C, A, D], "same_day")
        cls.single_text = pdf_text(cls.single)
        cls.multi_text = pdf_text(cls.multi)

    def test_pdf_single_exact_ids_amounts_and_provenance(self):
        text = one_line(self.single_text)
        self.assertTrue(self.single.startswith(b"%PDF-"))
        for expected in (A, B, SEED, "12 345 678,91 ₸", "57 500 ₸", "248 500 ₸", "finance-policy/2", "finance-workbench/v1", SHA,
                         "Справка для проверки".upper(), "Конечный получатель"):
            self.assertIn(expected, text, expected)

    def test_pdf_copy_no_machine_codes_or_double_periods(self):
        # Решение владельца 17:01: машинные коды оснований читателю не показываются.
        for text in (one_line(self.single_text), one_line(self.multi_text)):
            for code in basis_codes(self.analysis):
                self.assertNotIn(code, text)
            self.assertNotIn("дн..", text)
        self.assertIn("окно после 90% суммы — 15 дн.", one_line(self.single_text))

    def test_pdf_copy_one_concise_caution_and_request_first(self):
        from reports.pdf import CAUTION

        single, multi = one_line(self.single_text), one_line(self.multi_text)
        self.assertEqual(single.count(CAUTION), 1)
        self.assertEqual(multi.count(CAUTION), 1)
        self.assertNotIn("Опора правила показывает", single + multi)
        # Следующий запрос — на первой странице счёта: в одиночной справке это стр. 1, в сводной — стр. 2.
        self.assertIn("Запросить снятия наличных", page_texts(self.single)[0])
        self.assertIn("Запросить снятия наличных", page_texts(self.multi)[1])

    def test_pdf_copy_ninety_percent_is_a_cumulative_threshold(self):
        text = one_line(self.single_text)
        self.assertIn("90% входящей суммы набралось за 23 дня до конца периода", text)
        self.assertNotIn("основной суммы", text)

    def test_pdf_single_separates_support_from_priority(self):
        text = one_line(self.single_text)
        self.assertIn("Опора правила роли", text)
        self.assertIn("Приоритет проверки", text)
        self.assertIn("0,85", text)
        self.assertIn("0,61", text)
        self.assertIn("№ 1 в очереди проверки", text)
        self.assertIn("Отдано дальше от полученного: 0,5%", text)
        # Дополнение «1 минус сильнейший признак» не выдаётся за альтернативную роль.
        self.assertIn("Ближайшая альтернатива: консолидатор 0,07", text)
        self.assertNotIn("peripheral.below_threshold", text)

    def test_pdf_single_witness_is_not_same_money(self):
        text = one_line(self.single_text)
        self.assertIn("8 июля 2026", text)
        self.assertIn("не доказывает, что двигались те же деньги", text)

    def test_pdf_single_small_outflow_shows_observed_outflow(self):
        # policy/2: малый отток у конечного получателя наблюдается, это не граница сбора.
        self.assertNotIn("не наблюдаются", self.single_text)

    def test_pdf_multi_cover_order_cutoff_and_isolate(self):
        text = one_line(self.multi_text)
        self.assertIn("3 счёта для проверки", text)
        positions = [text.index(gid) for gid in (C, A, D)]
        self.assertEqual(positions, sorted(positions))
        self.assertIn("не наблюдаются", text)
        self.assertIn("Это не доказывает, что деньги остались на счёте", text)
        self.assertIn("В выгрузке нет переводов этого счёта", text)
        self.assertIn("Альтернативные роли не набрали опоры", text)
        self.assertIn("Запросить снятия наличных и мелкие (< 5 000 ₸) списания", text)

    def test_pdf_deterministic_bytes(self):
        from reports import render_pdf

        self.assertEqual(render_pdf(self.analysis, [A], "strict"), self.single)

    def test_pdf_cli_writes_file_and_refuses_unknown(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "analysis.json"
            source.write_text(json.dumps(self.analysis, ensure_ascii=False), encoding="utf-8")
            out = Path(tmp) / "spravka.pdf"
            ok = subprocess.run([sys.executable, "-m", "reports", "--analysis", str(source), "--gid", A, "--gid", C, "--out", str(out)],
                                cwd=ROOT, capture_output=True, text=True)
            self.assertEqual(ok.returncode, 0, ok.stderr)
            self.assertTrue(out.read_bytes().startswith(b"%PDF-"))
            bad = subprocess.run([sys.executable, "-m", "reports", "--analysis", str(source), "--gid", "123", "--out", str(out)],
                                 cwd=ROOT, capture_output=True, text=True)
            self.assertEqual(bad.returncode, 2)
            self.assertIn("не найден", bad.stderr)


@unittest.skipUnless(HAS_DEPS and os.environ.get("FINANCE_ANALYSIS"), "SKIP: задайте FINANCE_ANALYSIS=<analysis.json> для проверки на реальных данных")
class RealAnalysisTests(unittest.TestCase):
    def test_pdf_real_exact_values_for_representative_accounts(self):
        from reports import render_pdf
        from reports.facts import kzt

        analysis = json.loads(Path(os.environ["FINANCE_ANALYSIS"]).read_text(encoding="utf-8"))
        nodes = analysis["nodes"]
        picks = [analysis["top_nodes"][0]["gid"]]
        picks += [next(n["gid"] for n in nodes if n["observation"]["outgoing_censored"])]
        picks += [next(n["gid"] for n in nodes if n["metrics"]["in_tx"] + n["metrics"]["out_tx"] == 0)]
        picks += [n["gid"] for n in nodes if n["role_basis"] == "terminal.small_outflow"][:1]
        by = {n["gid"]: n for n in nodes}
        text = pdf_text(render_pdf(analysis, picks, "strict"))
        for gid in picks:
            self.assertIn(gid, text)
            self.assertIn(kzt(by[gid]["metrics"]["in_kzt"]).replace(" ", " "), text)
        flat = one_line(text)
        for code in basis_codes(analysis):
            self.assertNotIn(code, flat)
        self.assertNotIn("дн..", flat)
        self.assertIn(analysis["summary"]["input_sha256"], text)
        self.assertIn(analysis["policy"]["version"], text)


if __name__ == "__main__":
    unittest.main()
