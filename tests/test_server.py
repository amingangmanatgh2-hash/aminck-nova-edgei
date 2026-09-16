"""The real HTTP server, exercised over a real socket."""

from __future__ import annotations

import json
import threading
import unittest
import urllib.error
import urllib.parse
import urllib.request

from termuxapp.assistant import Assistant
from termuxapp.knowledge import KnowledgeBase
from termuxapp.paths import CATALOG_PATH, ROOT
from termuxapp.server import Application, create_server

from .helpers import KARAJ, TEHRAN, FakeRunner, TempCase, fix_payload


class ServerCase(TempCase):
    """Boots the server on an ephemeral port for the duration of the test."""

    def setUp(self) -> None:
        super().setUp()
        self.gps, self.runner = self.gps_with(FakeRunner.ok(fix_payload(*TEHRAN, accuracy=7)))
        self.app = Application(
            gps=self.gps,
            places=self.places,
            kb=KnowledgeBase(),
        )
        self.app.assistant = Assistant(
            places=self.places, gps=self.gps, kb=self.app.kb,
            memory_dir=self.memory_dir, catalog_path=CATALOG_PATH,
        )
        self.httpd = create_server("127.0.0.1", 0, self.app)
        self.port = self.httpd.server_address[1]
        self.thread = threading.Thread(target=self.httpd.serve_forever,
                                       kwargs={"poll_interval": 0.05}, daemon=True)
        self.thread.start()
        self.addCleanup(self._shutdown)

    def _shutdown(self) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join(timeout=5)

    # ------------------------------------------------------------ http verbs

    def get(self, path: str) -> tuple[int, bytes, dict]:
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}{path}")
        return self._do(req)

    def post(self, path: str, payload: dict) -> tuple[int, bytes, dict]:
        req = urllib.request.Request(
            f"http://127.0.0.1:{self.port}{path}",
            data=json.dumps(payload).encode("utf-8"),
            headers={"content-type": "application/json"},
            method="POST",
        )
        return self._do(req)

    def delete(self, path: str) -> tuple[int, bytes, dict]:
        return self._do(urllib.request.Request(
            f"http://127.0.0.1:{self.port}{path}", method="DELETE"))

    @staticmethod
    def _do(req) -> tuple[int, bytes, dict]:
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                return resp.status, resp.read(), dict(resp.headers)
        except urllib.error.HTTPError as exc:
            return exc.code, exc.read(), dict(exc.headers)

    def jget(self, path: str) -> dict:
        _, body, _ = self.get(path)
        return json.loads(body.decode("utf-8"))

    def jpost(self, path: str, payload: dict) -> dict:
        _, body, _ = self.post(path, payload)
        return json.loads(body.decode("utf-8"))


class MetaTests(ServerCase):
    def test_healthz(self):
        status, body, _ = self.get("/healthz")
        self.assertEqual(status, 200)
        self.assertTrue(json.loads(body)["ok"])

    def test_index_is_served(self):
        status, body, headers = self.get("/")
        self.assertEqual(status, 200)
        self.assertIn("Nova Termux", body.decode("utf-8"))
        self.assertIn('dir="rtl"', body.decode("utf-8"))

    def test_security_headers_on_every_response(self):
        _, _, headers = self.get("/")
        self.assertEqual(headers.get("X-Frame-Options"), "DENY")
        self.assertEqual(headers.get("X-Content-Type-Options"), "nosniff")
        self.assertIn("frame-ancestors 'none'", headers.get("Content-Security-Policy", ""))
        self.assertEqual(headers.get("Referrer-Policy"), "no-referrer")

    def test_status_reports_the_real_folder_state(self):
        data = self.jget("/api/status")
        self.assertTrue(data["offline"])
        self.assertEqual(data["root"], str(ROOT))
        self.assertGreater(data["knowledge_entries"], 10)
        self.assertGreater(data["catalog_products"], 20)
        self.assertIn("gps", data)

    def test_unknown_api_route_is_404_json(self):
        status, body, _ = self.get("/api/nope")
        self.assertEqual(status, 404)
        self.assertEqual(json.loads(body)["error"], "no_such_endpoint")

    def test_unknown_static_route_is_404(self):
        status, _, _ = self.get("/definitely-not-here")
        self.assertEqual(status, 404)


class GpsApiTests(ServerCase):
    def test_gps_returns_a_fix(self):
        data = self.jget("/api/gps")
        self.assertTrue(data["ok"])
        self.assertAlmostEqual(data["fix"]["lat"], TEHRAN[0], places=3)
        self.assertIn("maps", data)

    def test_manual_fix(self):
        data = self.jpost("/api/gps/manual", {"lat": 35.8, "lon": 51.0})
        self.assertTrue(data["ok"])
        self.assertEqual(data["fix"]["source"], "manual")

    def test_manual_fix_rejects_out_of_range(self):
        status, body, _ = self.post("/api/gps/manual", {"lat": 999, "lon": 0})
        self.assertEqual(status, 400)
        self.assertEqual(json.loads(body)["error"], "out_of_range")

    def test_gps_status_endpoint(self):
        data = self.jget("/api/gps/status")
        self.assertIn("termux_api_installed", data)
        self.assertIn("hint_fa", data)

    def test_watch_starts_and_stops_when_the_add_on_is_present(self):
        # api_binary_available is patched True for the whole ServerCase, so
        # this exercises the success path, not the missing-add-on path.
        data = self.jpost("/api/gps/watch", {"action": "start"})
        self.assertTrue(data["ok"])
        self.assertTrue(data["watching"])
        stopped = self.jpost("/api/gps/watch", {"action": "stop"})
        self.assertFalse(stopped["watching"])


class PlacesApiTests(ServerCase):
    def test_save_list_delete_round_trip(self):
        saved = self.jpost("/api/places", {"name": "خونه"})
        self.assertTrue(saved["ok"])
        self.assertTrue(saved["created"])

        listing = self.jget("/api/places")
        self.assertEqual(listing["count"], 1)
        self.assertEqual(listing["places"][0]["name"], "خونه")

        status, body, _ = self.delete("/api/places/" + urllib.parse.quote("خونه"))
        self.assertEqual(status, 200)
        self.assertTrue(json.loads(body)["ok"])
        self.assertEqual(self.jget("/api/places")["count"], 0)

    def test_save_with_explicit_coordinates(self):
        data = self.jpost("/api/places", {"name": "کرج", "lat": KARAJ[0], "lon": KARAJ[1]})
        self.assertTrue(data["ok"])
        self.assertAlmostEqual(data["place"]["lat"], KARAJ[0])

    def test_save_requires_a_name(self):
        status, body, _ = self.post("/api/places", {})
        self.assertEqual(status, 400)
        self.assertEqual(json.loads(body)["error"], "missing_name")

    def test_delete_unknown_is_404(self):
        status, _, _ = self.delete("/api/places/" + urllib.parse.quote("ناکجا"))
        self.assertEqual(status, 404)

    def test_alias_endpoint(self):
        self.jpost("/api/places", {"name": "خونه"})
        status, body, _ = self.post("/api/places/" + urllib.parse.quote("خونه") + "/alias",
                                    {"alias": "منزل"})
        self.assertEqual(status, 200)
        self.assertTrue(json.loads(body)["ok"])
        places = self.jget("/api/places")["places"]
        self.assertIn("منزل", places[0]["aliases"])

    def test_route_endpoint(self):
        self.jpost("/api/places", {"name": "کرج", "lat": KARAJ[0], "lon": KARAJ[1]})
        data = self.jget("/api/route?to=" + urllib.parse.quote("کرج"))
        self.assertTrue(data["ok"])
        self.assertGreater(data["leg"]["metres"], 30_000)
        self.assertIn("compass", data["leg"])

    def test_route_without_destination_is_400(self):
        status, body, _ = self.get("/api/route")
        self.assertEqual(status, 400)
        self.assertEqual(json.loads(body)["error"], "missing_destination")

    def test_route_to_a_near_miss_still_resolves(self):
        # «خون» is close enough to «خونه» that fuzzy lookup should win rather
        # than report not-found.
        self.jpost("/api/places", {"name": "خونه"})
        data = self.jget("/api/route?to=" + urllib.parse.quote("خون"))
        self.assertTrue(data["ok"])
        self.assertEqual(data["place"]["name"], "خونه")

    def test_route_unknown_place_offers_candidates(self):
        self.jpost("/api/places", {"name": "خونه"})
        data = self.jget("/api/route?to=" + urllib.parse.quote("فرودگاه"))
        self.assertFalse(data["ok"])
        self.assertEqual(data["error"], "place_not_found")

    def test_nearest(self):
        self.jpost("/api/places", {"name": "خونه", "lat": TEHRAN[0], "lon": TEHRAN[1]})
        data = self.jget("/api/places/nearest")
        self.assertTrue(data["ok"])
        self.assertEqual(data["nearest"][0]["place"]["name"], "خونه")

    def test_track_endpoints(self):
        self.jget("/api/gps")  # records a point
        data = self.jget("/api/track")
        self.assertGreaterEqual(len(data["points"]), 1)
        status, body, _ = self.delete("/api/track")
        self.assertEqual(status, 200)
        self.assertGreaterEqual(json.loads(body)["deleted"], 1)


class AskApiTests(ServerCase):
    def test_ask_returns_a_structured_reply(self):
        data = self.jpost("/api/ask", {"text": "مکان‌های ذخیره شده"})
        self.assertEqual(data["intent"], "list_places")
        self.assertIn("text", data)
        self.assertIn("confidence", data)

    def test_ask_survives_garbage(self):
        data = self.jpost("/api/ask", {"text": "###@@@"})
        self.assertEqual(data["intent"], "unknown")

    def test_feedback_endpoint(self):
        data = self.jpost("/api/feedback", {"query": "x", "key": "y", "positive": True})
        self.assertTrue(data["ok"])


class CatalogAndDocsTests(ServerCase):
    def test_catalog_matches_the_exported_file(self):
        data = self.jget("/api/catalog")
        with open(CATALOG_PATH, encoding="utf-8") as fh:
            on_disk = json.load(fh)
        self.assertEqual(data["count"], on_disk["count"])
        self.assertEqual(data["count"], len(data["products"]))

    def test_knowledge_endpoint(self):
        data = self.jget("/api/knowledge")
        self.assertGreater(data["count"], 10)
        self.assertIn("رنک‌های سرور", data["titles"])


class FolderBrowserTests(ServerCase):
    def test_lists_the_project_root(self):
        data = self.jget("/api/files?path=")
        self.assertTrue(data["ok"])
        names = [e["name"] for e in data["entries"]]
        for expected in ("main.py", "termuxapp", "data", "README.md"):
            self.assertIn(expected, names)

    def test_dotfolders_and_node_modules_are_hidden(self):
        data = self.jget("/api/files?path=")
        names = [e["name"] for e in data["entries"]]
        self.assertNotIn(".git", names)
        self.assertNotIn("node_modules", names)

    def test_subdirectory_listing(self):
        data = self.jget("/api/files?path=termuxapp")
        names = [e["name"] for e in data["entries"]]
        self.assertIn("server.py", names)
        self.assertIn("assistant.py", names)

    def test_traversal_is_blocked(self):
        status, body, _ = self.get("/api/files?path=" + urllib.parse.quote("../../../etc"))
        self.assertEqual(status, 403)
        self.assertEqual(json.loads(body)["error"], "forbidden_path")

    def test_fs_view_blocks_traversal_too(self):
        status, _, _ = self.get("/fs/" + urllib.parse.quote("../../etc/passwd"))
        self.assertEqual(status, 403)

    def test_fs_html_view_renders(self):
        status, body, _ = self.get("/fs/")
        self.assertEqual(status, 200)
        self.assertIn("پوشه‌ی پروژه", body.decode("utf-8"))

    def test_fs_serves_a_real_file(self):
        status, body, _ = self.get("/fs/main.py")
        self.assertEqual(status, 200)
        self.assertIn("Nova Termux", body.decode("utf-8"))

    def test_docs_index_and_page(self):
        status, body, _ = self.get("/docs/")
        self.assertEqual(status, 200)
        self.assertIn("FEASIBILITY", body.decode("utf-8"))
        status, body, _ = self.get("/docs/FEASIBILITY.md")
        self.assertEqual(status, 200)
        self.assertIn("<h1>", body.decode("utf-8"))

    def test_docs_rejects_non_markdown(self):
        status, _, _ = self.get("/docs/nothing-here.md")
        self.assertEqual(status, 404)

    def test_public_assets_are_served(self):
        status, body, headers = self.get("/public/app.js")
        self.assertEqual(status, 200)
        self.assertIn("javascript", headers.get("Content-Type", ""))
        self.assertGreater(len(body), 1000)

    def test_static_app_assets(self):
        status, _, _ = self.get("/static/app.css")
        self.assertEqual(status, 200)
        status, _, _ = self.get("/static/app.js")
        self.assertEqual(status, 200)

    def test_post_to_static_is_405(self):
        status, body, _ = self.post("/static/app.js", {})
        self.assertEqual(status, 405)
        self.assertEqual(json.loads(body)["error"], "method_not_allowed")

    def test_oversized_body_is_rejected(self):
        req = urllib.request.Request(
            f"http://127.0.0.1:{self.port}/api/ask",
            data=b"x" * (300 * 1024),
            headers={"content-type": "application/json"},
            method="POST",
        )
        status, _, _ = self._do(req)
        self.assertEqual(status, 400)

    def test_malformed_json_is_400(self):
        req = urllib.request.Request(
            f"http://127.0.0.1:{self.port}/api/ask",
            data=b"{not json",
            headers={"content-type": "application/json"},
            method="POST",
        )
        status, body, _ = self._do(req)
        self.assertEqual(status, 400)
        self.assertIn("invalid json", json.loads(body).get("detail", ""))


class LanHelperTests(unittest.TestCase):
    def test_lan_addresses_returns_a_list(self):
        from termuxapp.server import lan_addresses

        self.assertIsInstance(lan_addresses(), list)


if __name__ == "__main__":
    unittest.main()
