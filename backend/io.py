"""Чтение и проверка трёх исходных parquet-файлов.

Идентификаторы остаются целыми числами Python (int64 без округления), суммы переводятся
в целые тиыны через десятичную запись, поэтому агрегаты точны. Любое нарушение
контракта входных данных останавливает конвейер с понятным сообщением.
"""

from __future__ import annotations

import datetime as dt
import hashlib
from collections import Counter
from dataclasses import dataclass, field
from decimal import Decimal, InvalidOperation
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq

REQUIRED_COLUMNS = {
    "nodes": ("gid", "depth", "is_seed"),
    "edges": ("src", "dst", "sum_kzt", "n_tx", "depth"),
    "transactions": ("src", "dst", "date", "sum_kzt"),
}

INT64_MIN = -(2**63)
INT64_MAX = 2**63 - 1
MAX_REPORTED = 5


class InputValidationError(ValueError):
    """Входные данные нарушают контракт; сообщение адресовано аналитику."""


@dataclass(frozen=True)
class Dataset:
    """Проверенные данные в каноническом порядке: узлы по gid, рёбра по (src, dst)."""

    nodes: list  # {gid:int, depth:int, is_seed:bool}
    edges: list  # {src:int, dst:int, tiyn:int, n_tx:int, depth:int}
    transactions: list  # {src:int, dst:int, date:date, tiyn:int}
    input_sha256: str
    checks: dict = field(default_factory=dict)

    @property
    def period_start(self) -> dt.date | None:
        return self.transactions[0]["date"] if self.transactions else None

    @property
    def period_end(self) -> dt.date | None:
        return max((t["date"] for t in self.transactions), default=None)


def to_tiyn(value, where: str) -> int:
    """Сумма в тенге → целые тиыны без двоичной погрешности."""
    if isinstance(value, bool) or value is None:
        raise InputValidationError(f"{where}: сумма отсутствует или не является числом")
    if isinstance(value, int):
        return value * 100
    try:
        exact = Decimal(repr(value)) if isinstance(value, float) else Decimal(value)
    except (InvalidOperation, ValueError, TypeError):
        raise InputValidationError(f"{where}: сумма «{value}» не является числом") from None
    if not exact.is_finite():
        raise InputValidationError(f"{where}: сумма «{value}» не является конечным числом")
    tiyn = exact * 100
    if tiyn != tiyn.to_integral_value():
        raise InputValidationError(f"{where}: сумма {value} точнее одного тиына")
    return int(tiyn)


def _gid(value, where: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise InputValidationError(f"{where}: идентификатор «{value}» должен быть целым числом int64")
    if not INT64_MIN <= value <= INT64_MAX:
        raise InputValidationError(f"{where}: идентификатор {value} выходит за пределы int64")
    return value


def _date(value, where: str) -> dt.date:
    if isinstance(value, dt.datetime):
        return value.date()
    if isinstance(value, dt.date):
        return value
    if isinstance(value, str):
        try:
            return dt.date.fromisoformat(value)
        except ValueError:
            pass
    raise InputValidationError(f"{where}: дата «{value}» не распознана (нужен формат ГГГГ-ММ-ДД)")


def _read_table(path: Path, name: str) -> pa.Table:
    if not path.is_file():
        raise InputValidationError(f"Не найден файл {path.name}: ожидается {name}.parquet в каталоге данных")
    try:
        table = pq.read_table(path)
    except Exception as exc:  # повреждённый файл сообщается аналитику без трассировки
        raise InputValidationError(f"Файл {path.name} не читается как parquet: {exc}") from None
    missing = [c for c in REQUIRED_COLUMNS[name] if c not in table.column_names]
    if missing:
        raise InputValidationError(f"В файле {path.name} нет столбцов: {', '.join(missing)}")
    for column in REQUIRED_COLUMNS[name]:
        nulls = table.column(column).null_count
        if nulls:
            raise InputValidationError(f"В файле {path.name} столбец {column} содержит {nulls} пустых значений")
    for column in ("gid", "src", "dst"):
        if column in REQUIRED_COLUMNS[name] and not pa.types.is_integer(table.column(column).type):
            raise InputValidationError(
                f"В файле {path.name} столбец {column} имеет тип {table.column(column).type}; "
                "идентификаторы должны быть целыми int64, иначе они округлятся"
            )
    return table.select(list(REQUIRED_COLUMNS[name]))


def _fail(problems: list, total: int, title: str) -> None:
    if problems:
        shown = "; ".join(problems[:MAX_REPORTED])
        more = f" (и ещё {total - MAX_REPORTED})" if total > MAX_REPORTED else ""
        raise InputValidationError(f"{title}: {shown}{more}")


def _content_sha256(nodes: list, edges: list, transactions: list) -> str:
    """Контрольная сумма содержимого; порядок строк во входных файлах на неё не влияет."""
    digest = hashlib.sha256()
    for n in nodes:
        digest.update(f"n|{n['gid']}|{n['depth']}|{int(n['is_seed'])}\n".encode())
    for e in edges:
        digest.update(f"e|{e['src']}|{e['dst']}|{e['tiyn']}|{e['n_tx']}|{e['depth']}\n".encode())
    for t in transactions:
        digest.update(f"t|{t['src']}|{t['dst']}|{t['date'].isoformat()}|{t['tiyn']}\n".encode())
    return digest.hexdigest()


def validate_rows(raw_nodes: list, raw_edges: list, raw_transactions: list) -> Dataset:
    """Проверяет строки трёх таблиц и возвращает канонический набор данных."""
    nodes = []
    for i, row in enumerate(raw_nodes):
        where = f"nodes, строка {i + 1}"
        depth = row["depth"]
        if isinstance(depth, bool) or not isinstance(depth, int) or depth < 0:
            raise InputValidationError(f"{where}: глубина «{depth}» должна быть целым числом ≥ 0")
        if not isinstance(row["is_seed"], bool) and row["is_seed"] not in (0, 1):
            raise InputValidationError(f"{where}: is_seed должен быть логическим значением")
        nodes.append({"gid": _gid(row["gid"], where), "depth": depth, "is_seed": bool(row["is_seed"])})
    counts = Counter(n["gid"] for n in nodes)
    duplicates = sorted(g for g, c in counts.items() if c > 1)
    _fail([str(g) for g in duplicates], len(duplicates), "В nodes повторяются gid")
    nodes.sort(key=lambda n: n["gid"])
    known = {n["gid"]: n for n in nodes}

    edges = []
    for i, row in enumerate(raw_edges):
        where = f"edges, строка {i + 1}"
        src, dst = _gid(row["src"], where), _gid(row["dst"], where)
        n_tx, depth = row["n_tx"], row["depth"]
        if isinstance(n_tx, bool) or not isinstance(n_tx, int) or n_tx < 1:
            raise InputValidationError(f"{where}: n_tx «{n_tx}» должен быть целым числом ≥ 1")
        if isinstance(depth, bool) or not isinstance(depth, int) or depth < 1:
            raise InputValidationError(f"{where}: depth «{depth}» должен быть целым числом ≥ 1")
        tiyn = to_tiyn(row["sum_kzt"], where)
        if tiyn <= 0:
            raise InputValidationError(f"{where}: сумма {row['sum_kzt']} должна быть положительной")
        if src == dst:
            raise InputValidationError(f"{where}: перевод счёта {src} самому себе")
        edges.append({"src": src, "dst": dst, "tiyn": tiyn, "n_tx": n_tx, "depth": depth})
    pairs = Counter((e["src"], e["dst"]) for e in edges)
    repeated = sorted(p for p, c in pairs.items() if c > 1)
    _fail([f"{s}→{d}" for s, d in repeated], len(repeated), "В edges повторяются пары src→dst")
    unknown = sorted({g for e in edges for g in (e["src"], e["dst"]) if g not in known})
    _fail([str(g) for g in unknown], len(unknown), "Рёбра ссылаются на счета, которых нет в nodes")
    edges.sort(key=lambda e: (e["src"], e["dst"]))

    transactions = []
    for i, row in enumerate(raw_transactions):
        where = f"transactions, строка {i + 1}"
        src, dst = _gid(row["src"], where), _gid(row["dst"], where)
        tiyn = to_tiyn(row["sum_kzt"], where)
        if tiyn <= 0:
            raise InputValidationError(f"{where}: сумма {row['sum_kzt']} должна быть положительной")
        transactions.append({"src": src, "dst": dst, "date": _date(row["date"], where), "tiyn": tiyn})
    transactions.sort(key=lambda t: (t["date"], t["src"], t["dst"], t["tiyn"]))

    edge_by_pair = {(e["src"], e["dst"]): e for e in edges}
    tx_sum, tx_count = Counter(), Counter()
    for t in transactions:
        tx_sum[(t["src"], t["dst"])] += t["tiyn"]
        tx_count[(t["src"], t["dst"])] += 1
    orphan = sorted(p for p in tx_count if p not in edge_by_pair)
    _fail([f"{s}→{d}" for s, d in orphan], len(orphan), "Транзакции без агрегированного ребра")
    mismatched = []
    for pair, edge in edge_by_pair.items():
        if tx_count[pair] != edge["n_tx"] or tx_sum[pair] != edge["tiyn"]:
            mismatched.append(
                f"{pair[0]}→{pair[1]}: ребро {edge['n_tx']} шт. / {edge['tiyn'] / 100} ₸, "
                f"транзакции {tx_count[pair]} шт. / {tx_sum[pair] / 100} ₸"
            )
    _fail(mismatched, len(mismatched), "Суммы или число транзакций не совпадают с рёбрами")

    depth_mismatch = sum(1 for e in edges if e["depth"] != known[e["src"]]["depth"] + 1)
    repeated_rows = sum(
        c - 1 for c in Counter((t["src"], t["dst"], t["date"], t["tiyn"]) for t in transactions).values() if c > 1
    )
    checks = {
        "edges_match_transactions": True,
        "repeated_identical_transactions": repeated_rows,
        "edge_depth_not_src_plus_one": depth_mismatch,
        "transactions_below_5000_kzt": sum(1 for t in transactions if t["tiyn"] < 500_000),
        "seeds_not_at_depth_0": sum(1 for n in nodes if n["is_seed"] and n["depth"] != 0),
    }
    return Dataset(
        nodes=nodes,
        edges=edges,
        transactions=transactions,
        input_sha256=_content_sha256(nodes, edges, transactions),
        checks=checks,
    )


def load_dataset(data_dir) -> Dataset:
    """Читает nodes/edges/transactions.parquet из каталога и проверяет их."""
    directory = Path(data_dir)
    if not directory.is_dir():
        raise InputValidationError(f"Каталог данных {directory} не найден")
    tables = {name: _read_table(directory / f"{name}.parquet", name) for name in REQUIRED_COLUMNS}
    return validate_rows(
        tables["nodes"].to_pylist(),
        tables["edges"].to_pylist(),
        tables["transactions"].to_pylist(),
    )
