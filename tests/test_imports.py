"""IMPORT: загрузка трёх parquet-файлов по схеме кейса, отказ на неверных данных, сохранность прежних выгрузок.

Проверка на официальных данных включается переменной окружения FINANCE_DATA=<каталог>.
"""

from __future__ import annotations

import base64
import datetime as dt
import io
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import pyarrow as pa
import pyarrow.parquet as pq

import imports.ingest as ingest
from backend.io import load_dataset
from imports import REQUIRED_FILES, handle_import_request, ingest_files

# 2^53 + 1: в JavaScript Number такой идентификатор округлился бы.
BIG = 9007199254740993


def parquet(columns: dict, types: dict | None = None) -> bytes:
    types = types or {}
    table = pa.table({name: pa.array(values, types.get(name)) for name, values in columns.items()})
    buffer = io.BytesIO()
    pq.write_table(table, buffer)
    return buffer.getvalue()


def case_files(**overrides) -> dict:
    """Маленький корректный набор: засев → посредник → получатель."""
    files = {
        "nodes.parquet": parquet(
            {"gid": [1, BIG, 3], "depth": [0, 1, 2], "is_seed": [True, False, False]},
            {"gid": pa.int64(), "depth": pa.int64()},
        ),
        "edges.parquet": parquet(
            {"src": [1, BIG], "dst": [BIG, 3], "sum_kzt": [10000.0, 9000.0], "n_tx": [1, 1], "depth": [1, 2]},
            {"src": pa.int64(), "dst": pa.int64(), "n_tx": pa.int64(), "depth": pa.int8()},
        ),
        "transactions.parquet": parquet(
            {
                "src": [1, BIG],
                "dst": [BIG, 3],
                "date": [dt.date(2026, 7, 1), dt.date(2026, 7, 2)],
                "sum_kzt": [10000.0, 9000.0],
            },
            {"src": pa.int64(), "dst": pa.int64(), "date": pa.date32()},
        ),
    }
    files.update(overrides)
    return files


def body(files: dict) -> bytes:
    return json.dumps({"files": {n: base64.b64encode(b).decode() for n, b in files.items()}}).encode()


class ImportTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.out = Path(self.tmp.name) / "out"
        # Временные каталоги импорта создаются здесь, чтобы проверить их удаление.
        self.staging_root = Path(self.tmp.name) / "tmp"
        self.staging_root.mkdir()
        patcher = mock.patch.object(tempfile, "tempdir", str(self.staging_root))
        patcher.start()
        self.addCleanup(patcher.stop)

    def tearDown(self):
        self.tmp.cleanup()

    def assertNoStaging(self):
        self.assertEqual(list(self.staging_root.iterdir()), [])
        if self.out.exists():
            self.assertEqual([p.name for p in self.out.iterdir() if p.name.startswith(".")], [])

    def post(self, files=None, raw=None):
        return handle_import_request(raw if raw is not None else body(files or case_files()), self.out)

    def snapshot(self) -> dict:
        return {p.name: p.read_bytes() for p in self.out.iterdir() if p.name != "last_attempt.json"}

    def test_import_valid_writes_outputs_with_exact_ids(self):
        status, payload = self.post()
        self.assertEqual(status, 200, payload)
        dataset = payload["dataset"]
        self.assertEqual((dataset["n_nodes"], dataset["n_edges"], dataset["n_transactions"]), (3, 2, 2))
        self.assertEqual(dataset["period_start"], "2026-07-01")
        self.assertEqual(sorted(dataset["files"]), sorted(REQUIRED_FILES))
        analysis_text = (self.out / "analysis.json").read_text(encoding="utf-8")
        self.assertIn(f'"gid":"{BIG}"', analysis_text)
        self.assertIn(str(BIG), (self.out / "nodes_roles.csv").read_text(encoding="utf-8"))
        receipt = json.loads((self.out / "run_receipt.json").read_text(encoding="utf-8"))
        self.assertEqual((receipt["source"], receipt["input_sha256"]), ("upload", dataset["input_sha256"]))
        self.assertEqual(json.loads((self.out / "last_attempt.json").read_text(encoding="utf-8"))["status"], "ok")
        self.assertNoStaging()

    def test_import_same_content_same_identity_as_cli_loader(self):
        files = case_files()
        _, payload = self.post(files)
        source = Path(self.tmp.name) / "src"
        source.mkdir()
        for name, data in files.items():
            (source / name).write_bytes(data)
        self.assertEqual(payload["dataset"]["input_sha256"], load_dataset(source).input_sha256)

    def test_rejects_missing_file(self):
        files = case_files()
        del files["edges.parquet"]
        status, payload = self.post(files)
        self.assertEqual(status, 400)
        self.assertIn("Не хватает файлов: edges.parquet", payload["error"])
        self.assertFalse(payload["ok"])

    def test_rejects_unknown_and_path_names(self):
        for name in ("../nodes.parquet", "nodes.csv", "/etc/passwd", "model.pkl"):
            files = case_files()
            files[name] = files.pop("nodes.parquet")
            status, payload = self.post(files)
            self.assertEqual(status, 400, name)
            self.assertIn("Неподдерживаемые файлы", payload["error"])
        self.assertFalse(self.out.exists())
        self.assertNoStaging()

    def test_rejects_duplicate_file_field(self):
        encoded = {n: base64.b64encode(b).decode() for n, b in case_files().items()}
        pairs = ", ".join(f'"{n}": "{v}"' for n, v in encoded.items())
        raw = ('{"files": {' + pairs + f', "nodes.parquet": "{encoded["nodes.parquet"]}"' + "}}").encode()
        status, payload = self.post(raw=raw)
        self.assertEqual(status, 400)
        self.assertIn("повторяется", payload["error"])

    def test_rejects_malformed_request_shapes(self):
        for raw in (b"not json", b"[]", b'{"files": []}', b'{"files": {}, "extra": 1}'):
            status, payload = self.post(raw=raw)
            self.assertEqual(status, 400, raw)
            self.assertTrue(payload["error"])

    def test_rejects_bad_base64(self):
        encoded = {n: base64.b64encode(b).decode() for n, b in case_files().items()}
        encoded["edges.parquet"] = "@@not-base64@@"
        status, payload = self.post(raw=json.dumps({"files": encoded}).encode())
        self.assertEqual(status, 400)
        self.assertIn("base64", payload["error"])

    def test_rejects_oversize_file_request_and_total(self):
        with mock.patch.object(ingest, "MAX_FILE_BYTES", 100):
            status, payload = self.post()
            self.assertEqual(status, 413)
            self.assertIn("больше", payload["error"])
        with mock.patch.object(ingest, "MAX_REQUEST_BYTES", 100):
            status, _ = self.post()
            self.assertEqual(status, 413)
        with mock.patch.object(ingest, "MAX_TOTAL_BYTES", 100):
            status, payload = self.post()
            self.assertEqual(status, 413)
            self.assertIn("вместе", payload["error"])

    def test_rejects_row_cap_from_metadata(self):
        with mock.patch.dict(ingest.MAX_ROWS, {"transactions.parquet": 1}):
            status, payload = self.post()
        self.assertEqual(status, 413)
        self.assertIn("строк", payload["error"])
        self.assertNoStaging()

    def test_rejects_non_parquet_and_corrupt_parquet(self):
        for data in (b"hello, world", b"PAR1 garbage in the middle PAR1"):
            status, payload = self.post(case_files(**{"nodes.parquet": data}))
            self.assertEqual(status, 422, data)
            self.assertIn("parquet", payload["error"])
        self.assertNoStaging()

    def test_rejects_wrong_schema(self):
        nodes = parquet({"gid": [1, BIG, 3], "depth": [0, 1, 2]}, {"gid": pa.int64(), "depth": pa.int64()})
        status, payload = self.post(case_files(**{"nodes.parquet": nodes}))
        self.assertEqual(status, 422)
        self.assertIn("нет столбцов: is_seed", payload["error"])

    def test_rejects_float_ids(self):
        nodes = parquet({"gid": [1.0, 2.0, 3.0], "depth": [0, 1, 2], "is_seed": [True, False, False]})
        status, payload = self.post(case_files(**{"nodes.parquet": nodes}))
        self.assertEqual(status, 422)
        self.assertIn("int64", payload["error"])

    def test_rejects_unknown_edge_endpoint(self):
        nodes = parquet(
            {"gid": [1, BIG], "depth": [0, 1], "is_seed": [True, False]}, {"gid": pa.int64(), "depth": pa.int64()}
        )
        status, payload = self.post(case_files(**{"nodes.parquet": nodes}))
        self.assertEqual(status, 422)
        self.assertIn("Рёбра ссылаются на счета, которых нет в nodes: 3", payload["error"])

    def test_failure_preserves_previous_outputs(self):
        self.assertEqual(self.post()[0], 200)
        before = self.snapshot()
        broken = parquet({"src": [1], "dst": [3]}, {"src": pa.int64(), "dst": pa.int64()})
        status, payload = self.post(case_files(**{"edges.parquet": broken}))
        self.assertEqual(status, 422)
        self.assertIn("Прежние результаты не изменены", payload["error"])
        self.assertEqual(self.snapshot(), before)
        attempt = json.loads((self.out / "last_attempt.json").read_text(encoding="utf-8"))
        self.assertEqual((attempt["status"], attempt["source"]), ("failed", "upload"))
        self.assertNoStaging()

    def test_concurrent_import_is_refused(self):
        with ingest._LOCK:
            status, payload = self.post()
        self.assertEqual(status, 409)
        self.assertIn("другой импорт", payload["error"])

    def test_direct_call_validates_bytes(self):
        with self.assertRaises(ingest.ImportRejected) as caught:
            ingest_files(case_files(**{"edges.parquet": b""}), self.out)
        self.assertIn("пуст", str(caught.exception))


@unittest.skipUnless(os.environ.get("FINANCE_DATA"), "FINANCE_DATA не задан: проверка на официальных данных пропущена")
class OfficialImportTests(unittest.TestCase):
    def test_official_case_imports_like_cli(self):
        source = Path(os.environ["FINANCE_DATA"])
        files = {name: (source / name).read_bytes() for name in REQUIRED_FILES}
        with tempfile.TemporaryDirectory() as tmp:
            status, payload = handle_import_request(body(files), Path(tmp) / "out")
        self.assertEqual(status, 200, payload)
        dataset = payload["dataset"]
        self.assertEqual((dataset["n_nodes"], dataset["n_edges"], dataset["n_transactions"]), (2248, 3119, 4840))
        self.assertEqual(dataset["input_sha256"], load_dataset(source).input_sha256)


if __name__ == "__main__":
    unittest.main()
