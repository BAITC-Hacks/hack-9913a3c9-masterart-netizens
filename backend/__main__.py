"""Командная строка: python -m backend --data <каталог> --out <каталог>."""

from __future__ import annotations

import argparse
import datetime as dt
import sys
import time

from .analysis import TemporalIntegrationError, build_analysis
from .exports import write_attempt, write_outputs, write_receipt
from .fmt import plural_ru
from .insights import compute_insights
from .io import InputValidationError, load_dataset

FAILED_NOTE = (
    "Выгрузки в этом каталоге, если они есть, остались от предыдущего успешного запуска "
    "(см. run_receipt.json) и этой попыткой не изменены."
)


def _failed(args, started_at: str, code: int, message: str) -> int:
    print(message, file=sys.stderr)
    write_attempt({"status": "failed", "started_at_utc": started_at, "exit_code": code, "error": message, "note": FAILED_NOTE}, args.out)
    print(f"Прежние выгрузки в {args.out} не изменены; попытка отмечена в last_attempt.json.", file=sys.stderr)
    return code


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
        return _failed(args, started_at, 2, f"Ошибка входных данных: {exc}")
    except TemporalIntegrationError as exc:
        return _failed(args, started_at, 3, f"Ошибка интеграции: {exc}")
    # Дополнительные наблюдения (временные шаблоны, циклы, устойчивость) не меняют три CSV;
    # их сбой не должен лишать жюри обязательных выгрузок, поэтому он только сообщается.
    try:
        analysis["insights"] = compute_insights(analysis)
    except Exception as exc:  # noqa: BLE001 — дополнительный слой, обязательная часть уже готова
        print(f"Предупреждение: дополнительные наблюдения не построены ({type(exc).__name__}).", file=sys.stderr)
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
    write_attempt({"status": "ok", "started_at_utc": started_at, "pipeline_seconds": duration}, args.out)
    counts = (
        (summary["n_nodes"], "счёт", "счёта", "счетов"),
        (summary["n_edges"], "ребро", "ребра", "рёбер"),
        (summary["n_transactions"], "транзакция", "транзакции", "транзакций"),
        (summary["n_clusters"], "кластер", "кластера", "кластеров"),
    )
    listed = ", ".join(f"{n} {plural_ru(n, one, few, many)}" for n, one, few, many in counts)
    print(f"Готово за {duration} с: {listed}.")
    for name in sorted(paths):
        print(f"  {paths[name]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
