"""Локальный просмотрщик: только собранный интерфейс и четыре публичных результата."""

from __future__ import annotations

import argparse
import json
import math
import os
import stat
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Callable, Optional
from urllib.parse import unquote, urlsplit


ARTIFACTS = frozenset({"analysis.json", "nodes_roles.csv", "clusters.csv", "top_nodes.csv"})
ASSET_TYPES = {
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
}
Assistant = Callable[[dict], dict]
# Отчёт возвращает {"status": 200, "pdf": bytes, "filename": str} или {"status": код, "error": текст}.
Report = Callable[[dict], dict]
MAX_BODY_BYTES = 16_384
# Глубже 32 уровней запрос помощника или отчёта не бывает; глубокая вложенность — признак атаки.
MAX_JSON_DEPTH = 32
REPORT_MODES = frozenset({"structural", "strict", "same_day"})
REPORT_ERROR_STATUSES = frozenset({400, 404, 413, 503})


def _depth_ok(value, limit: int = MAX_JSON_DEPTH) -> bool:
    """Проверка вложенности без рекурсии: стек пар (значение, глубина)."""
    stack = [(value, 1)]
    while stack:
        item, depth = stack.pop()
        if isinstance(item, (dict, list)):
            if depth > limit:
                return False
            children = item.values() if isinstance(item, dict) else item
            stack.extend((child, depth + 1) for child in children)
    return True


def _decode_request(data: bytes) -> dict:
    def reject(value):
        raise ValueError("Недопустимое число JSON.")

    def finite(value):
        number = float(value)
        if not math.isfinite(number):
            reject(value)
        return number

    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("Повтор поля JSON.")
            result[key] = value
        return result

    payload = json.loads(data, parse_constant=reject, parse_float=finite, object_pairs_hook=unique)
    if not isinstance(payload, dict):
        raise ValueError("Нужен объект JSON.")
    if not _depth_ok(payload):
        raise ValueError("Слишком глубокая вложенность JSON.")
    return payload


def _root(path: Path) -> Path:
    path = Path(path).absolute()
    if path.is_symlink() or not path.is_dir():
        raise ValueError("Каталог публикации отсутствует или является символической ссылкой.")
    return path.resolve(strict=True)


def _read_regular(root: Path, parts: tuple[str, ...]) -> bytes:
    # Открытие по дескрипторам закрывает подмену ссылки между проверкой и чтением.
    directory = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in parts[:-1]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
            os.close(directory)
            directory = child
        descriptor = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        with os.fdopen(descriptor, "rb") as source:
            if not stat.S_ISREG(os.fstat(source.fileno()).st_mode):
                raise ValueError("Публикация разрешена только для обычного файла.")
            return source.read()
    finally:
        os.close(directory)


def make_handler(
    web_dir: Path, out_dir: Path, assistant: Optional[Assistant] = None, report: Optional[Report] = None
):
    """Обработчики assistant и report подключаются отдельно; без них соответствующий API возвращает 503."""
    web_root, out_root = _root(web_dir), _root(out_dir)
    _read_regular(web_root, ("index.html",))

    class Handler(BaseHTTPRequestHandler):
        server_version = "FinanceWorkbench"
        sys_version = ""

        def setup(self) -> None:
            super().setup()
            self.connection.settimeout(5)

        def log_message(self, format: str, *args: object) -> None:
            # URL и текст запроса могут содержать сведения из расследования.
            return

        def _reply(self, status: int, body: bytes, content_type: str, extra: Optional[dict] = None) -> None:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            for name, value in (extra or {}).items():
                self.send_header(name, value)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header("X-Frame-Options", "DENY")
            self.send_header("Cross-Origin-Resource-Policy", "same-origin")
            self.send_header(
                "Content-Security-Policy",
                "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
                "img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-src 'self' blob:; "
                "object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
            )
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)

        def _json(self, status: int, payload: dict) -> None:
            self._reply(status, json.dumps(payload, ensure_ascii=False, allow_nan=False).encode("utf-8"), "application/json; charset=utf-8")

        def _report(self, payload: dict) -> None:
            """POST /api/report {gids: [строки цифр], mode} → PDF-справка от reports.render_pdf.

            Число счетов и неизвестные gid проверяет модуль отчётов (413 и 404 с русским текстом);
            здесь — только форма запроса: идентификаторы строками, иначе int64 уже потерян.
            """
            gids, mode = payload.get("gids"), payload.get("mode", "structural")
            valid = (
                set(payload) <= {"gids", "mode"}
                and isinstance(gids, list)
                and len(gids) >= 1
                and all(isinstance(g, str) and g.isdigit() and len(g) <= 20 for g in gids)
                and mode in REPORT_MODES
            )
            if not valid:
                self._json(400, {"error": "Нужен список gid строками цифр и режим structural, strict или same_day."})
                return
            if report is None:
                self._json(503, {"error": "Отчёт PDF пока недоступен: модуль отчётов не установлен."})
                return
            try:
                result = report({"gids": gids, "mode": mode})
                status = result.get("status")
                if status in REPORT_ERROR_STATUSES:
                    self._json(status, {"error": str(result.get("error", "Отчёт не построен."))[:200]})
                    return
                pdf, filename = result.get("pdf"), str(result.get("filename", ""))
                if status != 200 or not isinstance(pdf, (bytes, bytearray)) or not bytes(pdf).startswith(b"%PDF-"):
                    raise ValueError
            except Exception:
                # Текст исключения может содержать сведения расследования.
                self.send_error(500)
                return
            if not filename or not all(c.isascii() and (c.isalnum() or c in "._-") for c in filename):
                filename = "spravka.pdf"
            self._reply(200, bytes(pdf), "application/pdf", {"Content-Disposition": f'attachment; filename="{filename}"'})

        def send_error(self, code: int, message=None, explain=None) -> None:
            self._json(code, {"error": {
                400: "Некорректный запрос.", 403: "Доступ запрещён.",
                404: "Файл или маршрут не найден.", 405: "Метод не поддерживается.",
                413: "Запрос слишком большой.", 415: "Нужен запрос application/json.",
                431: "Заголовки запроса слишком большие.",
                500: "Не удалось обработать запрос.", 501: "Метод не поддерживается.",
                503: "Помощник пока недоступен. Локальный анализ работает без ключа API.",
            }.get(code, "Запрос отклонён.")})

        def _local_request(self) -> bool:
            # Проверка Host не позволяет чужому сайту использовать DNS-перепривязку.
            port_number = self.server.server_address[1]
            allowed = {f"127.0.0.1:{port_number}", f"localhost:{port_number}"}
            if port_number == 80:
                allowed.update({"127.0.0.1", "localhost"})
            hosts = self.headers.get_all("Host", [])
            origins = self.headers.get_all("Origin", [])
            if len(hosts) != 1 or hosts[0] not in allowed:
                self.send_error(403)
                return False
            if len(origins) > 1 or (origins and origins[0] != "http://" + hosts[0]):
                self.send_error(403)
                return False
            if self.headers.get("Sec-Fetch-Site") == "cross-site":
                self.send_error(403)
                return False
            return True

        def _path(self) -> Optional[str]:
            try:
                # Запрещён повторный разбор кодировки, обратные слеши и скрытые сегменты.
                if not self.path.startswith("/") or self.path.startswith("//"):
                    raise ValueError
                parsed = urlsplit(self.path)
                path = unquote(parsed.path, encoding="utf-8", errors="strict")
                if parsed.scheme or parsed.netloc or parsed.fragment:
                    raise ValueError
                if any(ord(c) < 32 or ord(c) == 127 for c in path) or "\\" in path or "%" in path:
                    raise ValueError
                if path != "/" and any(not p or p.startswith(".") for p in path[1:].split("/")):
                    raise ValueError
                return path
            except (ValueError, UnicodeError):
                self.send_error(404)
                return None

        def do_GET(self) -> None:
            if not self._local_request():
                return
            path = self._path()
            if path is None:
                return
            if path in {"/", "/index.html"}:
                root, parts, content_type = web_root, ("index.html",), "text/html; charset=utf-8"
            elif path.startswith("/out/") and path[5:] in ARTIFACTS:
                filename = path[5:]
                root, parts = out_root, (filename,)
                content_type = "application/json; charset=utf-8" if filename.endswith(".json") else "text/csv; charset=utf-8"
            elif path.startswith("/assets/") and Path(path).suffix in ASSET_TYPES:
                root, parts, content_type = web_root, tuple(path[1:].split("/")), ASSET_TYPES[Path(path).suffix]
            elif path in {"/favicon.ico", "/favicon.svg"}:
                root, parts, content_type = web_root, (path[1:],), ASSET_TYPES[Path(path).suffix]
            else:
                self.send_error(404)
                return
            try:
                body = _read_regular(root, parts)
            except (OSError, ValueError):
                self.send_error(404)
                return
            self._reply(200, body, content_type)

        do_HEAD = do_GET

        def do_POST(self) -> None:
            if not self._local_request():
                return
            path = self._path()
            if path is None:
                return
            if path not in {"/api/assistant", "/api/report"}:
                self.send_error(404)
                return
            lengths = self.headers.get_all("Content-Length", [])
            if self.headers.get("Transfer-Encoding") or len(lengths) != 1 or not lengths[0].isdigit():
                self.send_error(400)
                return
            if len(lengths[0]) > 6:
                self.send_error(413)
                return
            length = int(lengths[0])
            if length > MAX_BODY_BYTES:
                self.send_error(413)
                return
            if len(self.headers.get_all("Content-Type", [])) != 1 or self.headers.get_content_type() != "application/json":
                self.send_error(415)
                return
            try:
                data = self.rfile.read(length)
                if len(data) != length:
                    raise ValueError
                payload = _decode_request(data)
            except (ValueError, UnicodeError, OSError, RecursionError):
                self.send_error(400)
                return
            if path == "/api/report":
                self._report(payload)
                return
            if assistant is None:
                self.send_error(503)
                return
            try:
                answer = assistant(payload)
                if not isinstance(answer, dict):
                    raise ValueError
                self._json(200, answer)
            except Exception:
                # Текст исключения внешнего адаптера может содержать секреты.
                self.send_error(500)

    return Handler


def make_server(
    web_dir: Path, out_dir: Path, port: int = 8765, assistant: Optional[Assistant] = None,
    report: Optional[Report] = None,
) -> ThreadingHTTPServer:
    if not 0 <= port <= 65535:
        raise ValueError("Порт должен быть от 0 до 65535.")
    return ThreadingHTTPServer(("127.0.0.1", port), make_handler(web_dir, out_dir, assistant, report))


def build_services(out_dir: Path, env_file: Path) -> tuple[Optional[Assistant], Optional[Report], str]:
    """Помощник и отчёты поверх готового analysis.json; ключ API читается только здесь и не печатается."""
    try:
        analysis = json.loads(_read_regular(_root(out_dir), ("analysis.json",)).decode("utf-8"))
    except (OSError, ValueError):
        return None, None, "недоступен: нет out/analysis.json"
    assistant = report = None
    mode = "не установлен"
    try:
        from assistant import answer, load_config
    except ImportError:
        pass
    else:
        try:
            config = load_config(env_file if env_file.is_file() else None)
        except ValueError:
            config = load_config(None)
        key, model = config["api_key"], config["model"]

        def assistant(payload: dict) -> dict:
            return answer(payload.get("question"), payload.get("selection", []), analysis, api_key=key, model=model)

        mode = f"OpenAI ({model})" if key else "локальный разбор без ключа OpenAI"
    try:
        import reports
    except ImportError:
        pass
    else:
        def report(payload: dict) -> dict:
            try:
                pdf = reports.render_pdf(analysis, payload["gids"], mode=payload["mode"])
            except reports.ReportRequestError as exc:
                status = exc.status if exc.status in REPORT_ERROR_STATUSES else 400
                return {"status": status, "error": str(exc)}
            except ImportError:
                # ReportLab загружается лениво: без него проверка запроса работает, а вёрстка — нет.
                return {"status": 503, "error": "Отчёт PDF недоступен: не установлена библиотека reportlab (см. requirements.txt)."}
            return {"status": 200, "pdf": pdf, "filename": reports.report_filename(payload["gids"])}

    return assistant, report, mode


def main(argv=None) -> int:
    root = Path(__file__).resolve().parent

    class Parser(argparse.ArgumentParser):
        def error(self, message):
            self.exit(2, "Ошибка: неверные параметры запуска. См. --help.\n")

    parser = Parser(description="Локальный просмотр результатов анализа", add_help=False, usage="python serve.py [--web-dir каталог] [--out каталог] [--port порт]")
    parser._optionals.title = "Параметры"
    parser.add_argument("--help", "-h", action="help", help="Показать справку")
    parser.add_argument("--web-dir", type=Path, default=root / "web" / "dist", help="Каталог собранного интерфейса")
    parser.add_argument("--out", type=Path, default=root / "out", help="Каталог результатов анализа")
    parser.add_argument("--port", type=int, default=8765, help="Порт 127.0.0.1 (по умолчанию 8765)")
    args = parser.parse_args(argv)
    if not 1 <= args.port <= 65535:
        print("Ошибка: порт должен быть от 1 до 65535.", file=sys.stderr)
        return 2
    assistant, report, mode = build_services(args.out, root / ".env")
    try:
        with make_server(args.web_dir, args.out, args.port, assistant, report) as server:
            print(f"Просмотрщик: http://127.0.0.1:{args.port}", flush=True)
            print(f"Помощник: {mode}. Отчёт PDF: {'подключён' if report else 'модуль не установлен'}.", flush=True)
            server.serve_forever()
    except KeyboardInterrupt:
        return 0
    except (OSError, ValueError):
        print("Ошибка: не удалось открыть локальный сервер. Проверьте сборку web/dist, каталог out и свободный порт.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
