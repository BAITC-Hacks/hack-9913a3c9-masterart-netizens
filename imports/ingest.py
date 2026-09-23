"""Импорт нового набора данных: три файла parquet или CSV по схеме кейса → проверка → анализ → выгрузки.

Поддерживается ровно одна схема — та же, что у официальных данных кейса: nodes.parquet,
edges.parquet и transactions.parquet. Это не подключение произвольной базы данных: другие
имена, форматы и схемы отклоняются с понятной ошибкой. Файлы проверяет тот же загрузчик
backend.io.load_dataset, что и командная строка, а анализ строит тот же build_analysis,
поэтому загруженный набор проходит ровно те же правила, что и данные кейса.

Безопасность. Имена файлов берутся только из закрытого списка, поэтому путь не может выйти
за временный каталог. Содержимое читается только как parquet: никакого pickle, SQL или
выполнения кода. Размер файлов, число строк и объём после распаковки ограничены до чтения
таблиц. Прежние выгрузки заменяются только после полного успеха, временные каталоги
удаляются в любом случае.
"""

from __future__ import annotations

import base64
import binascii
import csv
import datetime as dt
import hashlib
import json
import os
import re
import shutil
import tempfile
import threading
import time
from pathlib import Path
from typing import Mapping

import pyarrow as pa
import pyarrow.csv as pacsv
import pyarrow.parquet as pq

from backend.analysis import TemporalIntegrationError, build_analysis
from backend.exports import render_outputs, write_attempt, write_receipt
from backend.io import REQUIRED_COLUMNS, InputValidationError, load_dataset

REQUIRED_FILES = tuple(f"{name}.parquet" for name in REQUIRED_COLUMNS)
# Каждую из трёх таблиц можно передать в parquet или в CSV с той же схемой (первая строка — имена столбцов).
CSV_FILES = tuple(f"{name}.csv" for name in REQUIRED_COLUMNS)
ACCEPTED_FILES = REQUIRED_FILES + CSV_FILES
# CSV читается с явными типами столбцов, как в данных кейса: идентификаторы — точные int64,
# поэтому 18-значный gid не проходит через число с плавающей точкой и не округляется.
CSV_COLUMN_TYPES = {
    "gid": pa.int64(), "src": pa.int64(), "dst": pa.int64(), "depth": pa.int64(), "n_tx": pa.int64(),
    "is_seed": pa.bool_(), "sum_kzt": pa.float64(), "date": pa.date32(),
}
MIB = 1024 * 1024
# Официальные файлы кейса занимают 12, 34 и 41 КБ; пределы оставляют запас примерно в 100 раз.
MAX_FILE_BYTES = 4 * MIB
MAX_TOTAL_BYTES = 8 * MIB
# base64 увеличивает объём на треть, плюс обёртка JSON.
MAX_REQUEST_BYTES = 12 * MIB
# В кейсе 2 248 счетов, 3 119 рёбер и 4 840 транзакций; анализ на них идёт около 1,3 с.
MAX_ROWS = {"nodes.parquet": 25_000, "edges.parquet": 50_000, "transactions.parquet": 100_000}
# Защита от «сжатой бомбы»: маленький файл, который распаковывается в гигабайты.
MAX_UNCOMPRESSED_BYTES = 64 * MIB
PARQUET_MAGIC = b"PAR1"
FAILED_NOTE = (
    "Выгрузки в этом каталоге остались от предыдущего успешного запуска или импорта "
    "и этой попыткой не изменены."
)

_LOCK = threading.Lock()


class ImportRejected(Exception):
    """Импорт отклонён. Сообщение на русском адресовано пользователю, status — код HTTP."""

    def __init__(self, message: str, status: int = 422):
        super().__init__(message)
        self.status = status


def _supported() -> str:
    return "nodes, edges и transactions, каждый в формате .parquet или .csv"


def _table_of(name: str) -> str:
    return name.rsplit(".", 1)[0]


def _shown(name: str) -> str:
    # Имя приходит от пользователя: показываем коротко и без управляющих символов.
    clean = "".join(c if c.isprintable() else "?" for c in name)
    return f"«{clean[:60]}{'…' if len(clean) > 60 else ''}»"


def _check_names(names) -> None:
    names = list(names)
    unknown = [n for n in names if n not in ACCEPTED_FILES]
    if unknown:
        raise ImportRejected(
            f"Неподдерживаемые файлы: {', '.join(_shown(n) for n in unknown[:3])}. "
            f"Нужны ровно три файла: {_supported()}.",
            400,
        )
    for table in REQUIRED_COLUMNS:
        given = [n for n in names if _table_of(n) == table]
        if len(given) > 1:
            raise ImportRejected(f"Для таблицы {table} выбрано два файла ({', '.join(given)}): оставьте один формат.", 400)
    missing = [f"{t}.parquet" for t in REQUIRED_COLUMNS if not any(_table_of(n) == t for n in names)]
    if missing:
        raise ImportRejected(f"Не хватает файлов: {', '.join(missing)}. Нужны все три: {_supported()}.", 400)


def _unique_pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ImportRejected(f"Поле {_shown(key)} повторяется в запросе: каждый файл передаётся один раз.", 400)
        result[key] = value
    return result


def decode_request(body: bytes) -> dict:
    """Тело POST /api/import → {имя файла: байты}. Формат: {"files": {"nodes.parquet": "<base64>", ...}}."""
    if len(body) > MAX_REQUEST_BYTES:
        raise ImportRejected(f"Запрос больше {MAX_REQUEST_BYTES // MIB} МиБ.", 413)
    try:
        payload = json.loads(body, object_pairs_hook=_unique_pairs)
    except (ValueError, UnicodeDecodeError, RecursionError):
        raise ImportRejected("Тело запроса не является корректным JSON.", 400) from None
    if not isinstance(payload, dict) or set(payload) != {"files"} or not isinstance(payload["files"], dict):
        raise ImportRejected('Нужен объект JSON вида {"files": {"nodes.parquet": "<base64>", …}}.', 400)
    encoded = payload["files"]
    _check_names(encoded)
    encoded_limit = (MAX_FILE_BYTES + 2) // 3 * 4
    files = {}
    for name in encoded:
        text = encoded[name]
        if not isinstance(text, str):
            raise ImportRejected(f"Содержимое {name} должно быть строкой base64.", 400)
        if len(text) > encoded_limit:
            raise ImportRejected(f"Файл {name} больше {MAX_FILE_BYTES // MIB} МиБ.", 413)
        try:
            files[name] = base64.b64decode(text, validate=True)
        except (binascii.Error, ValueError):
            raise ImportRejected(f"Содержимое {name} не является корректной строкой base64.", 400) from None
    return files


def _csv_error(filename: str, exc: Exception) -> ImportRejected:
    # Сообщение Arrow содержит номер столбца, строку и значение; показываем их по-русски.
    text = str(exc)
    column = re.search(r"column #(\d+)", text)
    row = re.search(r"[Rr]ow #(\d+)", text)
    value = re.search(r"invalid value '([^']{0,40})", text)
    where = []
    if row:
        where.append(f"строка {row.group(1)}")
    if column:
        where.append(f"столбец {int(column.group(1)) + 1}")
    detail = f" ({', '.join(where)})" if where else ""
    shown = f" значение «{value.group(1)}» не подходит" if value else " значение не подходит"
    return ImportRejected(
        f"Файл {filename}{detail}:{shown} к типу столбца. Идентификаторы — целые числа без дробной части и "
        f"экспоненты, суммы — числа, даты — ГГГГ-ММ-ДД, is_seed — True или False.",
        422,
    )


def _csv_to_parquet(filename: str, data: bytes) -> bytes:
    """CSV по схеме кейса → parquet с теми же типами, что у данных кейса; дальше путь общий."""
    table_name = _table_of(filename)
    columns = REQUIRED_COLUMNS[table_name]
    if data[:3] == b"\xef\xbb\xbf":
        data = data[3:]
    try:
        header = next(csv.reader([data.split(b"\n", 1)[0].decode("utf-8").rstrip("\r")]))
    except (UnicodeDecodeError, StopIteration, csv.Error):
        raise ImportRejected(f"Файл {filename} не читается как CSV в кодировке UTF-8.", 422) from None
    present = {c.strip() for c in header}
    missing = [c for c in columns if c not in present]
    if missing:
        raise ImportRejected(
            f"В файле {filename} нет столбцов: {', '.join(missing)}. Первая строка должна содержать {', '.join(columns)}.",
            422,
        )
    try:
        table = pacsv.read_csv(
            pa.BufferReader(data),
            convert_options=pacsv.ConvertOptions(
                column_types={c: CSV_COLUMN_TYPES[c] for c in columns},
                include_columns=list(columns),
            ),
        )
    except (pa.ArrowInvalid, pa.ArrowTypeError, pa.ArrowNotImplementedError, ValueError) as exc:
        raise _csv_error(filename, exc) from None
    limit = MAX_ROWS[f"{table_name}.parquet"]
    if table.num_rows > limit:
        raise ImportRejected(f"В файле {filename} {table.num_rows} строк; локальный импорт принимает не больше {limit}.", 413)
    if table.num_rows == 0:
        raise ImportRejected(f"В файле {filename} нет строк данных.", 422)
    buffer = pa.BufferOutputStream()
    pq.write_table(table, buffer)
    return buffer.getvalue().to_pybytes()


def _as_parquet(files: Mapping[str, bytes]) -> dict:
    """Проверяет имена и размеры исходных файлов и приводит CSV к parquet под именем таблицы."""
    _check_names(files)
    total = 0
    result = {}
    for name, data in files.items():
        if not isinstance(data, (bytes, bytearray)):
            raise ImportRejected(f"Содержимое {name} должно быть байтами.", 400)
        if not data:
            raise ImportRejected(f"Файл {name} пуст.", 422)
        if len(data) > MAX_FILE_BYTES:
            raise ImportRejected(f"Файл {name} больше {MAX_FILE_BYTES // MIB} МиБ.", 413)
        total += len(data)
        if total > MAX_TOTAL_BYTES:
            raise ImportRejected(f"Три файла вместе больше {MAX_TOTAL_BYTES // MIB} МиБ.", 413)
        target = f"{_table_of(name)}.parquet"
        result[target] = _csv_to_parquet(name, bytes(data)) if name.endswith(".csv") else data
    return result


def _check_files(files: Mapping[str, bytes]) -> None:
    _check_names(files)
    total = 0
    for name in REQUIRED_FILES:
        data = files[name]
        if not isinstance(data, (bytes, bytearray)):
            raise ImportRejected(f"Содержимое {name} должно быть байтами.", 400)
        if not data:
            raise ImportRejected(f"Файл {name} пуст.", 422)
        if len(data) > MAX_FILE_BYTES:
            raise ImportRejected(f"Файл {name} больше {MAX_FILE_BYTES // MIB} МиБ.", 413)
        total += len(data)
        if len(data) < 8 or data[:4] != PARQUET_MAGIC or data[-4:] != PARQUET_MAGIC:
            raise ImportRejected(f"Файл {name} не является файлом parquet (нет подписи PAR1).", 422)
    if total > MAX_TOTAL_BYTES:
        raise ImportRejected(f"Три файла вместе больше {MAX_TOTAL_BYTES // MIB} МиБ.", 413)


def _check_parquet_bounds(name: str, data: bytes) -> None:
    """Число строк и объём после распаковки проверяются по метаданным, до чтения таблицы."""
    try:
        metadata = pq.ParquetFile(pa.BufferReader(bytes(data))).metadata
    except Exception:  # любая ошибка разбора — это повреждённый или чужой файл
        raise ImportRejected(f"Файл {name} не читается как parquet: он повреждён или имеет другой формат.", 422) from None
    if metadata.num_rows > MAX_ROWS[name]:
        raise ImportRejected(
            f"В файле {name} {metadata.num_rows} строк; локальный импорт принимает не больше {MAX_ROWS[name]}.", 413
        )
    uncompressed = sum(metadata.row_group(i).total_byte_size for i in range(metadata.num_row_groups))
    if uncompressed > MAX_UNCOMPRESSED_BYTES:
        raise ImportRejected(
            f"Файл {name} после распаковки больше {MAX_UNCOMPRESSED_BYTES // MIB} МиБ.", 413
        )


def _replace_outputs(rendered: dict, out_dir: Path) -> None:
    # Каталог подготовки лежит внутри out_dir: та же файловая система, поэтому os.replace
    # атомарен для каждого файла. Имя со скрытой точкой сервер никогда не отдаёт.
    staging = Path(tempfile.mkdtemp(prefix=".import-", dir=out_dir))
    try:
        for name, text in rendered.items():
            (staging / name).write_text(text, encoding="utf-8")
        # analysis.json заменяется последним: просмотрщик увидит его только когда CSV уже новые.
        for name in rendered:
            os.replace(staging / name, out_dir / name)
    finally:
        shutil.rmtree(staging, ignore_errors=True)


def _failed(out_dir: Path, started_at: str, message: str, status: int) -> ImportRejected:
    write_attempt(
        {"status": "failed", "source": "upload", "started_at_utc": started_at, "error": message, "note": FAILED_NOTE},
        out_dir,
    )
    return ImportRejected(f"{message} Прежние результаты не изменены.", status)


def _ingest_locked(files: Mapping[str, bytes], out_dir: Path, originals: Mapping[str, bytes]) -> dict:
    started = time.perf_counter()
    started_at = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
    out_dir.mkdir(parents=True, exist_ok=True)
    try:
        for name in REQUIRED_FILES:
            _check_parquet_bounds(name, files[name])
        with tempfile.TemporaryDirectory(prefix="finance-import-") as staging:
            staging_dir = Path(staging)
            for name in REQUIRED_FILES:
                (staging_dir / name).write_bytes(bytes(files[name]))
            data = load_dataset(staging_dir)
        analysis = build_analysis(data)
    except ImportRejected as exc:
        raise _failed(out_dir, started_at, str(exc), exc.status) from None
    except InputValidationError as exc:
        raise _failed(out_dir, started_at, f"Ошибка входных данных: {exc}.", 422) from None
    except TemporalIntegrationError as exc:
        raise _failed(out_dir, started_at, f"Ошибка интеграции: {exc}.", 500) from None

    rendered = render_outputs(analysis)
    _replace_outputs(rendered, out_dir)
    seconds = round(time.perf_counter() - started, 3)
    summary = analysis["summary"]
    write_receipt(
        {
            "started_at_utc": started_at,
            "pipeline_seconds": seconds,
            "input_sha256": summary["input_sha256"],
            "outputs": sorted(rendered),
            "source": "upload",
        },
        out_dir,
    )
    write_attempt({"status": "ok", "source": "upload", "started_at_utc": started_at, "pipeline_seconds": seconds}, out_dir)
    return {
        "input_sha256": summary["input_sha256"],
        "n_nodes": summary["n_nodes"],
        "n_edges": summary["n_edges"],
        "n_transactions": summary["n_transactions"],
        "n_seed": summary["n_seed"],
        "n_clusters": summary["n_clusters"],
        "period_start": summary["period_start"],
        "period_end": summary["period_end"],
        "input_checks": summary["input_checks"],
        "imported_at_utc": started_at,
        "pipeline_seconds": seconds,
        "files": {
            name: {"bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
            for name, data in sorted(originals.items())
        },
        "outputs": sorted(rendered),
    }


def ingest_files(files: Mapping[str, bytes], out_dir) -> dict:
    """Проверяет три файла, строит анализ и только после полного успеха заменяет выгрузки в out_dir.

    Возвращает сведения о новом наборе (контрольная сумма содержимого, число строк, период).
    Ошибка — ImportRejected с русским сообщением и кодом HTTP; прежние выгрузки при этом целы.
    """
    parquet_files = _as_parquet(files)
    _check_files(parquet_files)
    if not _LOCK.acquire(blocking=False):
        raise ImportRejected("Уже выполняется другой импорт. Дождитесь его завершения.", 409)
    try:
        return _ingest_locked(parquet_files, Path(out_dir), files)
    finally:
        _LOCK.release()


def handle_import_request(body: bytes, out_dir) -> tuple:
    """Обработчик POST /api/import для сервера: тело запроса → (код HTTP, ответ JSON)."""
    try:
        dataset = ingest_files(decode_request(body), out_dir)
    except ImportRejected as exc:
        return exc.status, {"ok": False, "error": str(exc)}
    except Exception:
        # Текст непредвиденной ошибки может содержать пути и данные расследования.
        return 500, {"ok": False, "error": "Импорт не выполнен из-за внутренней ошибки сервера."}
    return 200, {"ok": True, "dataset": dataset}
