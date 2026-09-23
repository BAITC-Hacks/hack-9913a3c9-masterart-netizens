#!/usr/bin/env bash
set -euo pipefail

fail() { printf 'Ошибка: %s\n' "$*" >&2; exit 1; }
usage() {
  cat <<'HELP'
Запуск: ./run.sh [--data каталог] [--out каталог] [--no-serve] [--port порт]
По умолчанию: data/, out/, http://127.0.0.1:8765.
Для анализа нужен Python >=3.12. Для просмотрщика дополнительно нужны Node.js 20.19+ (ветка 20)
либо >=22.12 и npm; без них анализ всё равно выполняется и три CSV-файла появляются в out/.
WORKBENCH_PYTHON задаёт интерпретатор; WORKBENCH_VENV — каталог среды.
Первая установка зависимостей может требовать сеть. Подготовленная среда работает автономно.
Установка, анализ и сборка интерфейса измеряются отдельно.
HELP
}

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
DATA="$ROOT/data"
OUT="$ROOT/out"
PORT=8765
SERVE=1
while [[ $# -gt 0 ]]; do
  case "$1" in
    --data|--out|--port)
      [[ $# -ge 2 && -n "$2" && "$2" != --* ]] || fail "После $1 нужно значение."
      case "$1" in
        --data) DATA="$2" ;;
        --out) OUT="$2" ;;
        --port) PORT="$2" ;;
      esac
      shift 2 ;;
    --no-serve) SERVE=0; shift ;;
    --help|-h) usage; exit 0 ;;
    *) fail "Неизвестный параметр: $1. См. --help." ;;
  esac
done
[[ "$DATA" = /* ]] || DATA="$PWD/$DATA"
[[ "$OUT" = /* ]] || OUT="$PWD/$OUT"
[[ "$PORT" =~ ^[0-9]{1,5}$ ]] || fail 'Порт должен быть целым числом от 1 до 65535.'
(( 10#$PORT >= 1 && 10#$PORT <= 65535 )) || fail 'Порт должен быть от 1 до 65535.'
PORT=$((10#$PORT))
[[ -d "$DATA" ]] || fail "Нет каталога данных: $DATA. Укажите --data."
for file in nodes.parquet edges.parquet transactions.parquet; do
  [[ -r "$DATA/$file" && -f "$DATA/$file" ]] || fail "Нет входного файла: $file."
done
[[ -f "$ROOT/backend/__main__.py" ]] || fail 'Нет backend/__main__.py: аналитический модуль ещё не установлен.'

PYTHON_BIN="${WORKBENCH_PYTHON:-}"
if [[ -z "$PYTHON_BIN" ]]; then
  if command -v python3.12 >/dev/null 2>&1; then PYTHON_BIN=python3.12; else PYTHON_BIN=python3; fi
fi
command -v "$PYTHON_BIN" >/dev/null 2>&1 || fail 'Установите Python >=3.12 или задайте WORKBENCH_PYTHON.'
"$PYTHON_BIN" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 12) else 1)' || fail 'Требуется Python >=3.12; проверенная версия — 3.12.'

clock_now() { "$PYTHON_BIN" -c 'import time; print(time.perf_counter())'; }
elapsed() { "$PYTHON_BIN" -c 'import sys,time; print(f"{time.perf_counter()-float(sys.argv[1]):.3f}")' "$1"; }

# 1. Среда Python и анализ: обязательная часть, не зависит от Node.js.
SETUP_START="$(clock_now)"
VENV_DIR="${WORKBENCH_VENV:-$ROOT/.venv}"
[[ "$VENV_DIR" = /* ]] || VENV_DIR="$PWD/$VENV_DIR"
if [[ ! -x "$VENV_DIR/bin/python" ]]; then
  "$PYTHON_BIN" -m venv "$VENV_DIR" || fail 'Не удалось создать среду Python.'
fi
PYTHON_BIN="$VENV_DIR/bin/python"
"$PYTHON_BIN" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 12) else 1)' || fail 'Существующая среда требует Python >=3.12; задайте другой WORKBENCH_VENV.'
if ! "$PYTHON_BIN" - "$ROOT/requirements.txt" <<'PY'
import importlib.metadata
import pathlib
import sys

try:
    for line in pathlib.Path(sys.argv[1]).read_text().splitlines():
        line = line.split("#", 1)[0].strip()
        if line:
            name, version = line.split("==", 1)
            if importlib.metadata.version(name) != version:
                raise ValueError(name)
except (ValueError, importlib.metadata.PackageNotFoundError):
    sys.exit(1)
PY
then
  printf '%s\n' 'Установка зависимостей Python; для первой подготовки может потребоваться сеть.'
  "$PYTHON_BIN" -m pip install --disable-pip-version-check -r "$ROOT/requirements.txt" || fail 'Не удалось установить зависимости Python. Проверьте доступ к пакетам.'
fi
SETUP_SECONDS="$(elapsed "$SETUP_START")"

cd -- "$ROOT"
PIPELINE_START="$(clock_now)"
"$PYTHON_BIN" -m backend --data "$DATA" --out "$OUT" || fail 'Анализ завершился ошибкой; сервер не запущен.'
PIPELINE_SECONDS="$(elapsed "$PIPELINE_START")"
for file in nodes_roles.csv clusters.csv top_nodes.csv analysis.json; do
  [[ -s "$OUT/$file" ]] || fail "Анализ не создал обязательный файл: $file."
done
printf 'Анализ: %s с. Результаты: %s\n' "$PIPELINE_SECONDS" "$OUT"

write_receipt() {
  "$PYTHON_BIN" - "$OUT" "$SETUP_SECONDS" "$PIPELINE_SECONDS" "$1" "$2" <<'PY'
import json
import pathlib
import sys

out, setup, pipeline, build, viewer = sys.argv[1:6]
receipt = {"setup_seconds": float(setup), "pipeline_seconds": float(pipeline),
           "build_seconds": float(build) if build else None, "viewer": viewer,
           "schema_version": "finance-workbench/runtime-v2"}
pathlib.Path(out, "runtime-receipt.json").write_text(json.dumps(receipt, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
PY
}

# 2. Просмотрщик: дополнительная часть. Без Node.js результаты анализа уже готовы.
viewer_unavailable() {
  write_receipt "" "unavailable"
  printf 'Просмотрщик недоступен: %s\n' "$1" >&2
  printf 'Три CSV-файла и analysis.json уже готовы в %s.\n' "$OUT" >&2
  exit 0
}
[[ -f "$ROOT/web/package.json" && -f "$ROOT/web/package-lock.json" ]] || viewer_unavailable 'нет web/package.json или web/package-lock.json.'
command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1 || viewer_unavailable 'для интерфейса установите Node.js ^20.19 или >=22.12 и npm, затем повторите ./run.sh.'
node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit((a===20&&b>=19)||(a===22&&b>=12)||a>22?0:1)' || viewer_unavailable "Vite требует Node.js ^20.19 или >=22.12, установлена $(node --version)."

cd -- "$ROOT/web"
LOCK_HASH="$("$PYTHON_BIN" -c 'import hashlib,pathlib; print(hashlib.sha256(pathlib.Path("package.json").read_bytes()+pathlib.Path("package-lock.json").read_bytes()).hexdigest())')"
MARKER=node_modules/.workbench-lock-sha256
if [[ ! -f "$MARKER" ]] || [[ "$(cat "$MARKER")" != "$LOCK_HASH" ]] || ! npm ls --depth=0 --silent >/dev/null 2>&1; then
  printf '%s\n' 'Установка зависимостей интерфейса из package-lock.json.'
  npm ci --no-audit --no-fund || viewer_unavailable 'не удалось выполнить npm ci; проверьте доступ к пакетам.'
  printf '%s\n' "$LOCK_HASH" > "$MARKER"
fi
BUILD_START="$(clock_now)"
npm run build || fail "Сборка интерфейса завершилась ошибкой; результаты анализа готовы в $OUT."
[[ -f "$ROOT/web/dist/index.html" ]] || fail 'Сборка не создала web/dist/index.html.'
BUILD_SECONDS="$(elapsed "$BUILD_START")"
printf 'Сборка интерфейса: %s с.\n' "$BUILD_SECONDS"
write_receipt "$BUILD_SECONDS" "built"

cd -- "$ROOT"
if [[ "$SERVE" = 1 ]]; then
  exec "$PYTHON_BIN" "$ROOT/serve.py" --out "$OUT" --port "$PORT"
fi
