"""Командная строка: python -m backend --data <каталог> --out <каталог>."""

from __future__ import annotations

import argparse
import datetime as dt
import sys
import time

from .analysis import TemporalIntegrationError, build_analysis
from .exports import write_outputs, write_receipt
from .io import InputValidationError, load_dataset


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m backend",
        description="Анализ графа переводов: роли, кластеры, приоритеты и выгрузки.",
    )
    parser.add_argument("--data", required=True, help="каталог с nodes/edges/transactions.parquet")
    parser.add_argument("--out", required=True, help="каталог для CSV-файлов и analysis.json")
    args = parser.parse_args(argv)

    started = time.perf_counter()
    started_at = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
    try:
        data = load_dataset(args.data)
        analysis = build_analysis(data)
    except InputValidationError as exc:
        print(f"Ошибка входных данных: {exc}", file=sys.stderr)
        return 2
    except TemporalIntegrationError as exc:
        print(f"Ошибка интеграции: {exc}", file=sys.stderr)
        return 3
    paths = write_outputs(analysis, args.out)
    duration = round(time.perf_counter() - started, 3)
    summary = analysis["summary"]
    write_receipt(
        {
            "started_at_utc": started_at,
            "pipeline_seconds": duration,
            "input_sha256": summary["input_sha256"],
            "outputs": sorted(paths),
        },
        args.out,
    )
    print(
        f"Готово за {duration} с: {summary['n_nodes']} счетов, {summary['n_edges']} рёбер, "
        f"{summary['n_transactions']} транзакций, {summary['n_clusters']} кластеров."
    )
    for name in sorted(paths):
        print(f"  {paths[name]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
