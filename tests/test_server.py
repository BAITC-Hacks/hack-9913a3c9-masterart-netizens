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
        SERVER.make_handler(self.web, self.out, self.assistant)(connection, ("127.0.0.1", 1), self.server)
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
            ("x" * (SERVER.MAX_BODY_BYTES + 1), "application/json", 413),
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
