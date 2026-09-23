"""Запись трёх обязательных CSV и analysis.json из единой модели фактов.

Файлы пишутся во временный файл и атомарно заменяются, поэтому прерванный запуск
не оставляет наполовину записанных выгрузок. Меток времени в этих файлах нет.
"""

from __future__ import annotations

import csv
import io
import json
import os
from pathlib import Path

NODES_COLUMNS = ("gid", "role", "role_score", "cluster_id", "priority_score", "evidence")
CLUSTERS_COLUMNS = ("cluster_id", "n_nodes", "n_seed", "sum_kzt_internal", "top_gids", "hypothesis")
TOP_COLUMNS = ("rank", "gid", "role", "priority_score", "why")

OUTPUT_FILES = ("nodes_roles.csv", "clusters.csv", "top_nodes.csv", "analysis.json")


def _score(value: float) -> str:
    return f"{value:.4f}"


def _amount(value) -> str:
    return str(value) if isinstance(value, int) else f"{value:.2f}"


def _csv_text(columns: tuple, rows: list) -> str:
    buffer = io.StringIO()
    writer = csv.writer(buffer, lineterminator="\n")
    writer.writerow(columns)
    writer.writerows(rows)
    return buffer.getvalue()


def _atomic_write(path: Path, text: str) -> None:
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(text, encoding="utf-8")
    os.replace(temporary, path)


def render_outputs(analysis: dict) -> dict:
    """{имя файла: содержимое}; удобно и для записи, и для проверки детерминизма."""
    nodes_rows = [
        (n["gid"], n["role"], _score(n["role_score"]), n["cluster_id"], _score(n["priority_score"]), n["evidence"])
        for n in analysis["nodes"]
    ]
    cluster_rows = [
        (
            c["cluster_id"],
            c["n_nodes"],
            c["n_seed"],
            _amount(c["sum_kzt_internal"]),
            ";".join(c["top_gids"]),
            c["hypothesis"],
        )
        for c in analysis["clusters"]
    ]
    top_rows = [
        (t["rank"], t["gid"], t["role"], _score(t["priority_score"]), t["why"]) for t in analysis["top_nodes"]
    ]
    return {
        "nodes_roles.csv": _csv_text(NODES_COLUMNS, nodes_rows),
        "clusters.csv": _csv_text(CLUSTERS_COLUMNS, cluster_rows),
        "top_nodes.csv": _csv_text(TOP_COLUMNS, top_rows),
        "analysis.json": json.dumps(analysis, ensure_ascii=False, separators=(",", ":"), allow_nan=False) + "\n",
    }


def write_outputs(analysis: dict, out_dir) -> dict:
    """Пишет четыре файла и возвращает их пути."""
    directory = Path(out_dir)
    directory.mkdir(parents=True, exist_ok=True)
    paths = {}
    for name, text in render_outputs(analysis).items():
        path = directory / name
        _atomic_write(path, text)
        paths[name] = path
    return paths


def write_receipt(receipt: dict, out_dir) -> Path:
    """Отдельная квитанция запуска: время и длительность живут только здесь."""
    path = Path(out_dir) / "run_receipt.json"
    _atomic_write(path, json.dumps(receipt, ensure_ascii=False, indent=2) + "\n")
    return path
