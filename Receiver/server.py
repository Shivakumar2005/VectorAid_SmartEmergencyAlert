"""
Dashboard server.

Server-Sent Events for the live stream (one-way, standard library only, and
the browser reconnects on its own), plus a small JSON API for setting and
clearing the destination.
"""

import json
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

import config

HERE = os.path.dirname(os.path.abspath(__file__))

# Injected by receiver.py before the server starts.
STATE_PROVIDER = lambda: {}
SET_DESTINATION = lambda lat, lon: {"error": "not wired"}
CLEAR_DESTINATION = lambda: {"ok": True}
SEARCH = lambda query: []


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        pass

    # ------------------------------------------------------------ helpers --
    def _json(self, obj, status=200):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    # ----------------------------------------------------------------- GET --
    def do_GET(self):
        path = self.path.split("?")[0]
        if path in ("/", "/index.html"):
            self._serve_file("dashboard.html", "text/html; charset=utf-8")
        elif path == "/api/state":
            self._json(STATE_PROVIDER())
        elif path == "/api/stream":
            self._stream()
        elif path == "/api/search":
            query = parse_qs(urlparse(self.path).query).get("q", [""])[0]
            try:
                self._json({"results": SEARCH(query)})
            except Exception as exc:
                self._json({"error": str(exc), "results": []}, 502)
        else:
            self.send_error(404)

    def _serve_file(self, name, content_type):
        try:
            with open(os.path.join(HERE, name), "rb") as fh:
                body = fh.read()
        except OSError:
            self.send_error(500, "%s missing" % name)
            return
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        # Never let the browser keep an old copy of the dashboard.
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _stream(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.end_headers()
        interval = 1.0 / config.PUSH_HZ
        try:
            while True:
                payload = json.dumps(STATE_PROVIDER())
                self.wfile.write(b"data: " + payload.encode("utf-8") + b"\n\n")
                self.wfile.flush()
                time.sleep(interval)
        except (BrokenPipeError, ConnectionResetError):
            pass

    # ---------------------------------------------------------------- POST --
    def do_POST(self):
        path = self.path.split("?")[0]
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b"{}"

        try:
            body = json.loads(raw or b"{}")
        except ValueError:
            self._json({"error": "invalid JSON"}, 400)
            return

        if path == "/api/destination":
            try:
                lat = float(body["lat"])
                lon = float(body["lon"])
            except (KeyError, TypeError, ValueError):
                self._json({"error": "lat and lon required"}, 400)
                return
            try:
                self._json(SET_DESTINATION(lat, lon))
            except Exception as exc:
                self._json({"error": str(exc)}, 500)

        elif path == "/api/destination/clear":
            self._json(CLEAR_DESTINATION())

        else:
            self.send_error(404)


def serve_forever():
    httpd = ThreadingHTTPServer((config.HTTP_HOST, config.HTTP_PORT), Handler)
    threading.Thread(target=httpd.serve_forever, daemon=True,
                     name="http").start()
    return httpd 