"""F07: проверка публичной поверхности на временных, явно искусственных файлах."""

from __future__ import annotations

import http.client
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from types import SimpleNamespace


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("workbench_server", ROOT / "serve.py")
SERVER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SERVER)


class HandlerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="workbench-server-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.web = self.root / "web" / "dist"
        self.out = self.root / "out"
        (self.web / "assets").mkdir(parents=True)
        self.out.mkdir()
        (self.web / "index.html").write_text('<html lang="ru">Тестовый интерфейс</html>', encoding="utf-8")
        (self.web / "assets" / "app.js").write_text("export const value = 1;", encoding="utf-8")
        (self.web / "assets" / "app.css").write_text("body { color: black; }", encoding="utf-8")
        for filename in SERVER.ARTIFACTS:
            (self.out / filename).write_text('{"gid":"9007199254740993"}' if filename.endswith("json") else "gid\n9007199254740993\n", encoding="utf-8")
        # Контрольная строка не является ключом: её отсутствие проверяет утечку файлов.
        self.private = self.root / "private-marker.txt"
        self.private.write_text("НЕ_ПУБЛИКОВАТЬ", encoding="utf-8")
        self.assistant = None
        self.report = None
        self.importer = None
        self.options = None
        self.server = SimpleNamespace(server_address=("127.0.0.1", 8765), server_port=8765)

    def stop(self):
        return

    def request(self, path, method="GET", body=None, headers=None):
        body = (body or "").encode("utf-8")
        actual_headers = {"Host": "127.0.0.1:8765", "Content-Length": str(len(body)), **(headers or {})}
        request = (f"{method} {path} HTTP/1.1\r\n" + "".join(f"{key}: {value}\r\n" for key, value in actual_headers.items()) + "\r\n").encode() + body

        class MemoryConnection:
            def __init__(self):
                self.response = bytearray()

            def makefile(self, *args):
                return io.BytesIO(request)

            def sendall(self, data):
                self.response.extend(data)

            def settimeout(self, timeout):
                pass

        connection = MemoryConnection()
        SERVER.make_handler(self.web, self.out, self.assistant, self.report, self.importer, self.options)(connection, ("127.0.0.1", 1), self.server)
        head, response_body = bytes(connection.response).split(b"\r\n\r\n", 1)
        lines = head.decode().split("\r\n")
        return int(lines[0].split()[1]), dict(line.split(": ", 1) for line in lines[1:]), response_body

    def test_F07_handler_intended_files(self):
        for path in ["/", "/index.html", "/assets/app.js", "/assets/app.css", *["/out/" + f for f in SERVER.ARTIFACTS]]:
            with self.subTest(path=path):
                status, headers, body = self.request(path)
                self.assertEqual(status, 200)
                self.assertGreater(len(body), 0)
                self.assertEqual(headers["X-Content-Type-Options"], "nosniff")
                self.assertEqual(headers["Cache-Control"], "no-store")
                self.assertNotIn("Access-Control-Allow-Origin", headers)
                self.assertIn("connect-src 'self'", headers["Content-Security-Policy"])
        self.assertIn(b'"9007199254740993"', self.request("/out/analysis.json")[2])

    def test_F07_head_matches_get_without_body(self):
        status, headers, body = self.request("/out/analysis.json", method="HEAD")
        self.assertEqual(status, 200)
        self.assertEqual(body, b"")
        self.assertEqual(int(headers["Content-Length"]), len(self.request("/out/analysis.json")[2]))

    def test_F07_paths_and_private_artifacts_rejected(self):
        (self.out / "runtime-receipt.json").write_text("{}")
        (self.web / "assets" / "app.js.map").write_text("{}")
        (self.web / "assets" / ".hidden.js").write_text("НЕ_ПУБЛИКОВАТЬ")
        paths = [
            "/../private-marker.txt", "/%2e%2e/private-marker.txt", "/%252e%252e/private-marker.txt",
            "/assets/../index.html", "/assets/%2e%2e/index.html", "/assets/%5c..%5cprivate-marker.txt",
            "/assets/app.js%00", "/assets/.hidden.js", "/assets/%2ehidden.js", "/assets/app.js.map",
            "/.env", "/.git/config", "/serve.py", "/run.sh", "/README.md", "/data/nodes.parquet",
            "/out/", "/assets/", "/out/runtime-receipt.json", "/out/private-marker.txt",
            "/out/analysis.json/extra", "/out//analysis.json", "/missing", "/%ff",
        ]
        for path in paths:
            with self.subTest(path=path):
                status, _, body = self.request(path)
                self.assertEqual(status, 404)
                self.assertNotIn("НЕ_ПУБЛИКОВАТЬ".encode(), body)
                self.assertNotIn(str(self.root).encode(), body)

    def test_F07_symlink_files_directories_and_output_rejected(self):
        (self.web / "assets" / "leak.js").symlink_to(self.private)
        external = self.root / "external"
        external.mkdir()
        (external / "leak.js").write_text("НЕ_ПУБЛИКОВАТЬ")
        (self.web / "assets" / "linked").symlink_to(external, target_is_directory=True)
        artifact = self.out / "analysis.json"
        artifact.unlink()
        artifact.symlink_to(self.private)
        for path in ["/assets/leak.js", "/assets/linked/leak.js", "/out/analysis.json"]:
            self.assertEqual(self.request(path)[0], 404)
        (self.root / "linked-web").symlink_to(self.web, target_is_directory=True)
        with self.assertRaises(ValueError):
            SERVER.make_handler(self.root / "linked-web", self.out)

    def test_F07_special_files_rejected(self):
        os.mkfifo(self.web / "assets" / "pipe.js")
        self.assertEqual(self.request("/assets/pipe.js")[0], 404)

    def test_F07_foreign_host_origin_and_cross_site_rejected(self):
        for headers in [
            {"Host": "foreign.example"}, {"Host": "127.0.0.1:1"},
            {"Origin": "https://foreign.example"}, {"Origin": "null"},
            {"Sec-Fetch-Site": "cross-site"},
        ]:
            with self.subTest(headers=headers):
                self.assertEqual(self.request("/out/analysis.json", headers=headers)[0], 403)

    def test_F07_api_without_key_and_invalid_requests(self):
        self.assertEqual(self.request("/api/assistant", "POST", "{}", {"Content-Type": "application/json"})[0], 503)
        for body, content_type, expected in [
            ("[]", "application/json", 400), ("{", "application/json", 400),
            ('{"x":NaN}', "application/json", 400), ("{}", "text/plain", 415),
            ('{"x":1e999}', "application/json", 400),
            ('{"x":1,"x":2}', "application/json", 400),
            ('{"x":' + "[" * 1100 + "0" + "]" * 1100 + "}", "application/json", 400),
            # У помощника свой предел: шесть прошлых вопросов с историей занимают до 64 КиБ.
            ("x" * (SERVER.BODY_LIMITS["/api/assistant"] + 1), "application/json", 413),
        ]:
            with self.subTest(expected=expected, content_type=content_type):
                self.assertEqual(self.request("/api/assistant", "POST", body, {"Content-Type": content_type})[0], expected)
        self.assertEqual(self.request("/out/analysis.json", "POST", "{}")[0], 404)
        self.assertEqual(self.request("/out/analysis.json", "PUT", "{}")[0], 501)
        self.assertEqual(self.request("/api/assistant", "POST", "{}", {"Content-Type": "application/json", "Content-Length": "9" * 5000})[0], 413)

    def test_F07_adapter_errors_do_not_disclose_details(self):
        def broken(payload):
            raise ValueError("НЕ_ПУБЛИКОВАТЬ")

        self.assistant = broken
        status, _, body = self.request("/api/assistant", "POST", "{}", {"Content-Type": "application/json"})
        self.assertEqual(status, 500)
        self.assertNotIn("НЕ_ПУБЛИКОВАТЬ".encode(), body)

    def test_F07_optional_assistant_seam(self):
        self.assistant = lambda payload: {"received": payload}
        origin = f"http://127.0.0.1:{self.server.server_port}"
        status, _, body = self.request("/api/assistant", "POST", '{"gid":"9007199254740993"}', {"Content-Type": "application/json", "Origin": origin})
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["received"]["gid"], "9007199254740993")
        self.assertEqual(self.request("/api/assistant", "POST", "{}", {"Content-Type": "application/json", "Origin": "https://foreign.example"})[0], 403)

    def post_report(self, body):
        return self.request("/api/report", "POST", body, {"Content-Type": "application/json"})

    def test_F08_report_without_module_is_503_json(self):
        status, _, body = self.post_report('{"gids":["9007199254740993"]}')
        self.assertEqual(status, 503)
        self.assertIn("модуль отчётов", json.loads(body)["error"])

    def test_F08_report_returns_pdf_with_ascii_filename(self):
        seen = []
        self.report = lambda payload: seen.append(payload) or {"status": 200, "pdf": b"%PDF-1.7 test", "filename": "spravka-9007199254740993.pdf"}
        status, headers, body = self.post_report('{"gids":["9007199254740993"],"mode":"strict"}')
        self.assertEqual(status, 200)
        self.assertEqual(headers["Content-Type"], "application/pdf")
        self.assertEqual(headers["Content-Disposition"], 'attachment; filename="spravka-9007199254740993.pdf"')
        self.assertTrue(body.startswith(b"%PDF-"))
        self.assertEqual(seen, [{"gids": ["9007199254740993"], "mode": "strict"}])

    def test_F08_report_module_errors_pass_status_and_russian_text(self):
        for status in (400, 404, 413, 503):
            with self.subTest(status=status):
                self.report = lambda payload, s=status: {"status": s, "error": "Выбрано 30 счетов; в одной справке не больше 25"}
                code, _, body = self.post_report('{"gids":["9007199254740993"]}')
                self.assertEqual(code, status)
                self.assertIn("не больше 25", json.loads(body)["error"])

    def test_F08_report_rejects_numeric_ids_bad_mode_and_non_pdf(self):
        self.report = lambda payload: {"status": 200, "pdf": b"%PDF-1.7", "filename": "a.pdf"}
        for body in ('{"gids":[9007199254740993]}', '{"gids":[]}', '{"gids":["1"],"mode":"x"}', '{"gids":["1"],"extra":1}'):
            with self.subTest(body=body):
                self.assertEqual(self.post_report(body)[0], 400)
        self.report = lambda payload: {"status": 200, "pdf": b"not a pdf", "filename": "a.pdf"}
        self.assertEqual(self.post_report('{"gids":["1"]}')[0], 500)
        self.report = lambda payload: {"status": 200, "pdf": b"%PDF-1.7", "filename": "../../etc/x.pdf"}
        self.assertEqual(self.post_report('{"gids":["1"]}')[1]["Content-Disposition"], 'attachment; filename="spravka.pdf"')

    def test_F09_import_route_passes_raw_body_and_status(self):
        seen = []
        self.importer = lambda body: seen.append(body) or (422, {"ok": False, "error": "Файлы не прошли проверку"})
        status, _, body = self.request("/api/import", "POST", '{"files":{}}', {"Content-Type": "application/json"})
        self.assertEqual((status, json.loads(body)["error"]), (422, "Файлы не прошли проверку"))
        self.assertEqual(seen, [b'{"files":{}}'])
        self.importer = None
        self.assertEqual(self.request("/api/import", "POST", "{}", {"Content-Type": "application/json"})[0], 503)

    def test_F09_body_limits_are_per_route(self):
        self.assistant = lambda payload: {"ok": True}
        self.report = lambda payload: {"status": 200, "pdf": b"%PDF-1.7", "filename": "a.pdf"}
        history = json.dumps({"question": "x" * 20_000})
        self.assertEqual(self.request("/api/assistant", "POST", history, {"Content-Type": "application/json"})[0], 200)
        self.assertEqual(self.request("/api/report", "POST", history, {"Content-Type": "application/json"})[0], 413)
        self.assertEqual(self.request("/api/assistant", "POST", "{}", {"Content-Type": "application/json", "Content-Length": "70000"})[0], 413)

    def test_F09_assistant_options_route(self):
        self.assertEqual(self.request("/api/assistant/options")[0], 503)
        self.options = lambda: {"defaults": {"model": "m", "effort": "low"}}
        status, _, body = self.request("/api/assistant/options")
        self.assertEqual((status, json.loads(body)["defaults"]["model"]), (200, "m"))

    def test_F09_import_swaps_the_snapshot_only_on_success(self):
        (self.out / "analysis.json").write_text('{"version": 1}', encoding="utf-8")
        services = SERVER.Services(self.out, self.root / "missing.env")
        self.assertEqual(services.analysis, {"version": 1})

        def succeed(body, out_dir):
            (Path(out_dir) / "analysis.json").write_text('{"version": 2}', encoding="utf-8")
            return 200, {"ok": True}

        services._import = succeed
        self.assertEqual(services.import_request(b"{}")[0], 200)
        self.assertEqual(services.analysis, {"version": 2})
        services._import = lambda body, out_dir: (422, {"ok": False, "error": "нет"})
        self.assertEqual(services.import_request(b"{}")[0], 422)
        self.assertEqual(services.analysis, {"version": 2})

    def test_F09_assistant_without_analysis_is_503(self):
        (self.out / "analysis.json").unlink()
        services = SERVER.Services(self.out, self.root / "missing.env")
        services._answer = lambda *args, **kwargs: {"never": True}
        self.assistant = services.assistant
        status, _, body = self.request("/api/assistant", "POST", '{"question":"q"}', {"Content-Type": "application/json"})
        self.assertEqual(status, 503)
        self.assertIn("нет analysis.json", json.loads(body)["error"])

    def test_F07_cli_missing_build_fails_without_path_leak(self):
        result = subprocess.run([sys.executable, "-B", str(ROOT / "serve.py"), "--web-dir", str(self.root / "missing"), "--out", str(self.out)], capture_output=True, text=True, timeout=5)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Ошибка", result.stderr)
        self.assertNotIn("Traceback", result.stderr)


class SocketTests(unittest.TestCase):
    def test_F07_real_loopback_http(self):
        with tempfile.TemporaryDirectory(prefix="workbench-http-") as temporary:
            root = Path(temporary)
            (root / "index.html").write_text("<html>Проверка HTTP</html>", encoding="utf-8")
            (root / "analysis.json").write_text("{}")
            with SERVER.make_server(root, root, 0) as server:
                self.assertEqual(server.server_address[0], "127.0.0.1")
                thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
                thread.start()
                try:
                    connection = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=3)
                    try:
                        connection.request("GET", "/out/analysis.json")
                        response = connection.getresponse()
                        self.assertEqual(response.status, 200)
                        self.assertEqual(response.read(), b"{}")
                    finally:
                        connection.close()
                finally:
                    server.shutdown()
                    thread.join(timeout=2)


if __name__ == "__main__":
    unittest.main()
