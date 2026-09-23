"""Командная строка: PDF-справка по счетам из готового analysis.json.

Пример: python -m reports --analysis out/analysis.json --gid 100000005382566100 --mode strict --out spravka.pdf
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from . import MODES, ReportRequestError, render_pdf, report_filename


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="python -m reports", description="PDF-справка для проверки по выбранным счетам.")
    parser.add_argument("--analysis", required=True, type=Path, help="путь к analysis.json (результат python -m backend)")
    parser.add_argument("--gid", action="append", default=[], help="идентификатор счёта; флаг можно повторить")
    parser.add_argument("--mode", default="structural", choices=MODES, help="режим путей: без дат, позже по датам или тот же день")
    parser.add_argument("--out", type=Path, help="куда сохранить PDF; по умолчанию spravka-<счёт>.pdf в текущем каталоге")
    args = parser.parse_args(argv)

    try:
        analysis = json.loads(args.analysis.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        print(f"Не удалось прочитать файл анализа {args.analysis}: {exc}", file=sys.stderr)
        return 2
    try:
        pdf = render_pdf(analysis, args.gid, args.mode)
    except ReportRequestError as exc:
        print(f"Справка не собрана: {exc}", file=sys.stderr)
        return 2
    out = args.out or Path(report_filename(args.gid))
    out.write_bytes(pdf)
    print(f"Справка сохранена: {out} ({len(pdf)} байт)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
