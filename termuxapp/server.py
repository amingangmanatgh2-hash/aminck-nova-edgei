"""
Localhost HTTP server. Everything it serves comes from this folder.

Scope decisions, stated plainly:

* Default bind is 127.0.0.1. A phone browser hitting ``localhost:8000`` does
  not need the LAN, and a server that answers GPS coordinates for anyone on
  the Wi-Fi would be a bad default. ``--host 0.0.0.0`` opts in explicitly.
* Same-origin only: no CORS headers, so a random web page the phone visits
  cannot silently query your location.
* Every user-supplied path goes through ``paths.safe_resolve``.
* The ``/fs/`` browser reads the whole folder, because that is exactly what
  was asked for — but it never follows a path out of the project root.
"""

from __future__ import annotations

import json
import mimetypes
import socket
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlparse

from . import __version__
from .assistant import Assistant
from .geo import maps_url, plan_route, to_persian_digits
from .gps import GpsError, GpsProvider
from .knowledge import KnowledgeBase
from .markdown import page, render
from .paths import (CATALOG_PATH, DOCS_DIR, PUBLIC_DIR, ROOT, WEB_DIR,
                    human_size, safe_resolve)
from .places import PlaceStore

CSP = (
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; "
    "script-src 'self'; connect-src 'self'; frame-ancestors 'none'; "
    "base-uri 'none'; form-action 'self'"
)

_TEXT_TYPES = {
    ".md": "text/markdown; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".jsonc": "application/json; charset=utf-8",
    ".ts": "text/plain; charset=utf-8",
    ".py": "text/plain; charset=utf-8",
    ".mjs": "text/plain; charset=utf-8",
    ".java": "text/plain; charset=utf-8",
    ".sql": "text/plain; charset=utf-8",
    ".yml": "text/plain; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
}

MAX_BODY = 256 * 1024  # 256 KB: nothing legitimate here is bigger


class Application:
    """Shared services. One instance per server, reused across requests."""

    def __init__(self, gps: GpsProvider | None = None,
                 places: PlaceStore | None = None,
                 kb: KnowledgeBase | None = None,
                 assistant: Assistant | None = None) -> None:
        self.gps = gps or GpsProvider()
        self.places = places or PlaceStore()
        self.kb = kb if kb is not None else KnowledgeBase()
        self.assistant = assistant or Assistant(places=self.places, gps=self.gps, kb=self.kb)

    # ------------------------------------------------------------------ meta

    def status(self) -> dict:
        gps_status = self.gps.status()
        return {
            "version": __version__,
            "root": str(ROOT),
            "offline": True,
            "gps": gps_status,
            "places_count": len(self.places.all()),
            "knowledge_entries": len(self.kb),
            "catalog_products": self._catalog_count(),
            "assistant_turns": int(self.assistant.state.get("turns", 0)),
        }

    @staticmethod
    def _catalog_count() -> int:
        try:
            return int(json.loads(CATALOG_PATH.read_text(encoding="utf-8")).get("count", 0))
        except (OSError, json.JSONDecodeError, ValueError):
            return 0

    def catalog(self) -> dict:
        try:
            return json.loads(CATALOG_PATH.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return {"count": 0, "products": [], "error": "data/catalog.json not found"}

    # ------------------------------------------------------------------- gps

    def current_fix(self, provider: str = "gps", timeout: float = 25.0,
                    allow_cache: bool = True) -> dict:
        try:
            fix, notes = self.gps.resolve(provider=provider, timeout=timeout,
                                          allow_cache=allow_cache)
            self.places.record_track_point(fix.lat, fix.lon, fix.accuracy)
            return {"ok": True, "fix": fix.to_dict(), "notes": notes,
                    "maps": maps_url(fix.lat, fix.lon)}
        except GpsError as exc:
            return {"ok": False, "error": exc.reason, "hint_fa": exc.hint_fa}

    def route(self, destination: str) -> dict:
        place = self.places.get(destination)
        if place is None:
            return {"ok": False, "error": "place_not_found",
                    "candidates": self.places.suggest_names(destination)}
        live = self.gps.live()
        fix = live if live and live.age_seconds() < 120 else self.gps.cached_fix()
        if fix is None:
            # No live fix and nothing cached: try the radio once rather than
            # reporting "no location" for a request that could have succeeded.
            try:
                fix, _ = self.gps.resolve(timeout=15.0)
            except GpsError:
                fix = None
        data = {"ok": True, "place": place.to_dict(), "maps": maps_url(place.lat, place.lon)}
        if fix is None:
            data["error"] = "no_current_location"
            data["hint_fa"] = "مکان ذخیره‌شده را داری، ولی موقعیت فعلی‌ات را نه."
            return data
        leg = plan_route(fix.lat, fix.lon, place.lat, place.lon)
        data["leg"] = {
            "metres": round(leg.metres, 1),
            "bearing": round(leg.bearing, 1),
            "compass": leg.compass,
            "distance_fa": leg.distance_fa,
            "eta": leg.eta_seconds,
        }
        data["from"] = fix.to_dict()
        return data

    # ---------------------------------------------------------------- folder

    def list_dir(self, relative: str = "") -> dict:
        target = safe_resolve(relative or ".")
        if not target.is_dir():
            return {"ok": False, "error": "not_a_directory", "path": relative}
        entries = []
        for child in sorted(target.iterdir(), key=lambda p: (p.is_file(), p.name.lower())):
            if child.name.startswith(".") or child.name in ("node_modules", ".git"):
                continue
            try:
                stat = child.stat()
            except OSError:
                continue
            entries.append({
                "name": child.name,
                "path": child.relative_to(ROOT).as_posix(),
                "is_dir": child.is_dir(),
                "size": 0 if child.is_dir() else stat.st_size,
                "size_fa": "—" if child.is_dir() else human_size(stat.st_size),
                "mtime": stat.st_mtime,
            })
        return {
            "ok": True,
            "path": target.relative_to(ROOT).as_posix() if target != ROOT else "",
            "entries": entries,
        }

    def docs_index(self) -> list[dict]:
        out = []
        for path in sorted(DOCS_DIR.glob("*.md")) if DOCS_DIR.is_dir() else []:
            out.append({"name": path.stem, "path": path.name,
                        "size_fa": human_size(path.stat().st_size)})
        readme = ROOT / "README.md"
        if readme.is_file():
            out.insert(0, {"name": "README", "path": "../README.md",
                           "size_fa": human_size(readme.stat().st_size)})
        return out


class Handler(BaseHTTPRequestHandler):
    server_version = "NovaTermux/" + __version__
    protocol_version = "HTTP/1.1"
    app: Application  # injected by create_server

    # ------------------------------------------------------------- plumbing

    def log_message(self, fmt: str, *args) -> None:  # quieter, still useful
        print(f"[{self.log_date_time_string()}] {fmt % args}")

    def _send(self, status: int, body: bytes, content_type: str,
              extra: dict[str, str] | None = None) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Security-Policy", CSP)
        for key, value in (extra or {}).items():
            self.send_header(key, value)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, status: int, payload: dict | list) -> None:
        self._send(status, json.dumps(payload, ensure_ascii=False).encode("utf-8"),
                   "application/json; charset=utf-8")

    def _html(self, status: int, html_text: str) -> None:
        self._send(status, html_text.encode("utf-8"), "text/html; charset=utf-8")

    def _error_json(self, status: int, error: str, **extra) -> None:
        self._json(status, {"ok": False, "error": error, **extra})

    def _body(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return {}
        if length > MAX_BODY:
            raise ValueError("body too large")
        raw = self.rfile.read(length)
        try:
            data = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ValueError(f"invalid json: {exc}") from exc
        return data if isinstance(data, dict) else {"value": data}

    # -------------------------------------------------------------- routing

    def do_GET(self) -> None:  # noqa: N802
        self._handle("GET")

    def do_HEAD(self) -> None:  # noqa: N802
        self._handle("HEAD")

    def do_POST(self) -> None:  # noqa: N802
        self._handle("POST")

    def do_DELETE(self) -> None:  # noqa: N802
        self._handle("DELETE")

    def _handle(self, method: str) -> None:
        parsed = urlparse(self.path)
        path = unquote(parsed.path)
        query = {k: v[0] for k, v in parse_qs(parsed.query).items()}
        try:
            if path.startswith("/api/"):
                self._api(method, path, query)
            elif method in ("GET", "HEAD"):
                self._static(path, query)
            else:
                self._error_json(405, "method_not_allowed")
        except PermissionError as exc:
            self._error_json(403, "forbidden_path", detail=str(exc))
        except GpsError as exc:
            # Bad input to the GPS layer is a client error, not a server fault.
            self._json(400, {"ok": False, "error": exc.reason, "hint_fa": exc.hint_fa})
        except (ValueError, KeyError, TypeError) as exc:
            self._error_json(400, "bad_request", detail=str(exc))
        except Exception as exc:  # never leak a traceback to the browser
            self._error_json(500, "internal_error", detail=type(exc).__name__)

    # ------------------------------------------------------------------- api

    def _api(self, method: str, path: str, query: dict[str, str]) -> None:
        app = self.app

        if method == "GET":
            if path == "/api/status":
                return self._json(200, app.status())
            if path == "/api/gps":
                timeout = min(float(query.get("timeout", "25")), 60.0)
                return self._json(200, app.current_fix(
                    provider=query.get("provider", "gps"),
                    timeout=timeout,
                    allow_cache=query.get("cache", "1") != "0",
                ))
            if path == "/api/gps/status":
                return self._json(200, app.gps.status())
            if path == "/api/places":
                places = app.places.all()
                return self._json(200, {"ok": True, "count": len(places),
                                        "places": [p.to_dict() for p in places]})
            if path == "/api/places/nearest":
                res = app.current_fix(timeout=float(query.get("timeout", "25")))
                if not res.get("ok"):
                    return self._json(200, res)
                near = app.places.nearest(res["fix"]["lat"], res["fix"]["lon"], limit=5)
                return self._json(200, {"ok": True, "nearest": [
                    {"place": p.to_dict(), "metres": round(m, 1)} for p, m in near
                ]})
            if path == "/api/route":
                dest = query.get("to", "")
                if not dest:
                    return self._error_json(400, "missing_destination")
                return self._json(200, app.route(dest))
            if path == "/api/track":
                return self._json(200, {"ok": True, "points": app.places.track(limit=200)})
            if path == "/api/catalog":
                return self._json(200, app.catalog())
            if path == "/api/knowledge":
                return self._json(200, {"ok": True, "count": len(app.kb),
                                        "titles": app.kb.titles()})
            if path == "/api/files":
                return self._json(200, app.list_dir(query.get("path", "")))
            return self._error_json(404, "no_such_endpoint", path=path)

        if method == "POST":
            body = self._body()
            if path == "/api/ask":
                text = str(body.get("text", ""))[:1000]
                reply = app.assistant.ask(text)
                return self._json(200, reply.to_dict())
            if path == "/api/feedback":
                app.assistant.feedback(
                    str(body.get("query", "")),
                    str(body.get("key", "")),
                    bool(body.get("positive", True)),
                )
                return self._json(200, {"ok": True})
            if path == "/api/gps/manual":
                fix = app.gps.manual_fix(float(body["lat"]), float(body["lon"]),
                                         _opt_float(body.get("accuracy")))
                return self._json(200, {"ok": True, "fix": fix.to_dict()})
            if path == "/api/gps/watch":
                if str(body.get("action", "start")) == "stop":
                    app.gps.stop_watch()
                    return self._json(200, {"ok": True, "watching": False})
                started = app.gps.start_watch(interval_s=float(body.get("interval", "15")))
                return self._json(200, {"ok": started, "watching": started,
                                        "hint_fa": None if started else
                                        "Termux:API نصب نیست، پس پایش زنده ممکن نیست."})
            if path == "/api/places":
                name = str(body.get("name", "")).strip()
                if not name:
                    return self._error_json(400, "missing_name")
                if "lat" in body and "lon" in body:
                    lat, lon = float(body["lat"]), float(body["lon"])
                else:
                    res = app.current_fix()
                    if not res.get("ok"):
                        return self._json(200, {"ok": False, **res,
                                                "error": "no_location",
                                                "hint_fa": res.get("hint_fa")})
                    lat, lon = res["fix"]["lat"], res["fix"]["lon"]
                place, created = app.places.save(
                    name, lat, lon,
                    accuracy=_opt_float(body.get("accuracy")),
                    note=str(body.get("note", "")),
                    tags=body.get("tags", []) or [],
                    aliases=body.get("aliases", []) or [],
                )
                return self._json(200, {"ok": True, "created": created,
                                        "place": place.to_dict()})
            if path.startswith("/api/places/") and path.endswith("/alias"):
                name = unquote(path.split("/")[3])
                if not app.places.add_alias(name, str(body.get("alias", ""))):
                    return self._error_json(404, "place_not_found")
                return self._json(200, {"ok": True})
            return self._error_json(404, "no_such_endpoint", path=path)

        if method == "DELETE":
            if path.startswith("/api/places/"):
                name = unquote(path.split("/")[3])
                if not app.places.delete(name):
                    return self._error_json(404, "place_not_found")
                return self._json(200, {"ok": True, "deleted": name})
            if path == "/api/track":
                return self._json(200, {"ok": True, "deleted": app.places.clear_track()})
            return self._error_json(404, "no_such_endpoint", path=path)

        self._error_json(405, "method_not_allowed")

    # ---------------------------------------------------------------- static

    def _static(self, path: str, query: dict[str, str]) -> None:
        if path in ("/", "/index.html"):
            return self._file(WEB_DIR / "index.html", "text/html; charset=utf-8")

        if path.startswith("/fs"):
            return self._folder_view(path[len("/fs"):].lstrip("/") or "")

        if path.startswith("/docs"):
            return self._docs_view(path[len("/docs"):].lstrip("/") or "")

        if path == "/healthz":
            return self._json(200, {"ok": True, "service": "nova-termux"})

        if path.startswith("/public/"):
            return self._file(PUBLIC_DIR / path[len("/public/"):], None)

        if path.startswith("/static/"):
            return self._file(WEB_DIR / path[len("/static/"):], None)

        return self._error_json(404, "not_found", path=path)

    def _file(self, target, content_type: str | None) -> None:
        try:
            resolved = safe_resolve(target)
        except PermissionError as exc:
            return self._error_json(403, "forbidden_path", detail=str(exc))
        if not resolved.is_file():
            return self._error_json(404, "file_not_found")
        ctype = content_type or _TEXT_TYPES.get(resolved.suffix.lower()) \
            or mimetypes.guess_type(resolved.name)[0] or "application/octet-stream"
        data = resolved.read_bytes()
        self._send(200, data, ctype)

    def _folder_view(self, relative: str) -> None:
        try:
            target = safe_resolve(relative or ".")
        except PermissionError as exc:
            return self._error_json(403, "forbidden_path", detail=str(exc))
        # /fs/<file> serves the file; /fs/<dir> renders a listing.
        if target.is_file():
            return self._file(target, None)
        listing = self.app.list_dir(relative)
        if not listing.get("ok"):
            return self._error_json(404, "not_a_directory", path=relative)
        rows = []
        if listing["path"]:
            rows.append('<tr><td colspan="3"><a href="/fs/'
                        + _parent(listing["path"]) + '">.. (بالاتر)</a></td></tr>')
        for entry in listing["entries"]:
            href = f"/fs/{entry['path']}"
            icon = "📁" if entry["is_dir"] else "📄"
            rows.append(
                f'<tr><td><a href="{href}">{icon} {_esc(entry["name"])}</a></td>'
                f'<td>{_esc(entry["size_fa"])}</td></tr>'
            )
        body = (
            f"<h1>پوشه‌ی پروژه</h1><p><code>{_esc(listing['path'] or '/')}</code></p>"
            "<table><thead><tr><th>نام</th><th>اندازه</th></tr></thead><tbody>"
            + "".join(rows) + "</tbody></table>"
        )
        self._html(200, page("فایل‌ها", body))

    def _docs_view(self, name: str) -> None:
        if not name:
            rows = "".join(
                f'<tr><td><a href="/docs/{d["path"]}">{_esc(d["name"])}</a></td>'
                f'<td>{_esc(d["size_fa"])}</td></tr>'
                for d in self.app.docs_index()
            )
            self._html(200, page("مستندات",
                                 "<h1>مستندات</h1><table><tbody>" + rows + "</tbody></table>"))
            return
        target = safe_resolve((DOCS_DIR / name) if not name.startswith("../")
                              else (DOCS_DIR / name))
        if not target.is_file() or target.suffix.lower() != ".md":
            return self._error_json(404, "doc_not_found")
        self._html(200, page(target.stem, render(target.read_text(encoding="utf-8"))))


def _opt_float(value) -> float | None:
    try:
        return None if value is None else float(value)
    except (TypeError, ValueError):
        return None


def _parent(path: str) -> str:
    parts = [p for p in path.split("/") if p]
    return "/".join(parts[:-1])


def _esc(text: str) -> str:
    import html as _html

    return _html.escape(str(text), quote=True)


def create_server(host: str = "127.0.0.1", port: int = 8000,
                  app: Application | None = None) -> ThreadingHTTPServer:
    application = app or Application()

    class BoundHandler(Handler):
        pass

    BoundHandler.app = application
    httpd = ThreadingHTTPServer((host, port), BoundHandler)
    httpd.daemon_threads = True
    return httpd


def lan_addresses() -> list[str]:
    """Best-effort LAN IPs, so the Termux banner can print a usable URL."""
    found: list[str] = []
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.connect(("8.8.8.8", 80))
        found.append(sock.getsockname()[0])
        sock.close()
    except OSError:
        pass
    return found
