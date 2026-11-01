"""Fake GitHub Releases API for verifying the update checker.

Reads the scenario from dist/_gh-mode.txt on every request so one process can
serve all cases:
    newer | same | dev | 404 | notag
"""

import json
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

MODE_FILE = Path(__file__).resolve().parent.parent / "dist" / "_gh-mode.txt"

ASSETS = [
    {
        "name": "KimiGateway-1.1.0-share.zip",
        "browser_download_url": "http://127.0.0.1:8898/dl/share.zip",
        "size": 160000,
    },
    {
        "name": "KimiGateway-1.1.0-portable.zip",
        "browser_download_url": "http://127.0.0.1:8898/dl/portable.zip",
        "size": 35000000,
    },
]


def scenario(mode):
    if mode == "same":
        return 200, {"tag_name": "v1.0.0", "html_url": "https://example.test/1.0.0", "body": "", "assets": []}
    if mode == "404":
        return 404, {"message": "Not Found"}
    if mode == "notag":
        return 200, {"html_url": "https://example.test/x", "body": "no tag here", "assets": []}
    if mode == "dev":
        return 200, {
            "tag_name": "v1.2.0-beta.1",
            "html_url": "https://example.test/beta",
            "body": "beta notes",
            "assets": [ASSETS[0]],
        }
    return 200, {
        "tag_name": "v1.1.0",
        "html_url": "https://github.com/lukeyancn/kimi-gateway/releases/tag/v1.1.0",
        "name": "v1.1.0",
        "body": "## 更新内容\n\n- 新增成本统计\n- 修复托盘重启\n",
        "assets": ASSETS,
    }


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path.endswith("/releases/latest"):
            mode = MODE_FILE.read_text().strip() if MODE_FILE.exists() else "newer"
            code, data = scenario(mode)
            body = json.dumps(data).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if self.path.startswith("/dl/"):
            payload = b"PK\x05\x06" + b"\x00" * 200
            self.send_response(200)
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return
        self.send_response(404)
        self.end_headers()

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    HTTPServer(("127.0.0.1", 8898), Handler).serve_forever()
