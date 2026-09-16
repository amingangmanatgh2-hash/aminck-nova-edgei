"""Knowledge base, markdown renderer, path safety, catalogue sync, CLI."""

from __future__ import annotations

import json
import unittest

from termuxapp.knowledge import KnowledgeBase
from termuxapp.markdown import render
from termuxapp.paths import ROOT, human_size, safe_resolve
from termuxapp.places import PlaceStore


class KnowledgeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.kb = KnowledgeBase()

    def test_shipped_knowledge_base_loads(self):
        self.assertGreater(len(self.kb), 15, "data/knowledge/*.json did not load")

    def test_every_entry_has_a_usable_answer(self):
        for entry in self.kb.entries:
            self.assertTrue(entry.id)
            self.assertTrue(entry.best_answer().strip(), entry.id)

    def test_search_finds_the_right_entry(self):
        top = self.kb.search("رنک‌های سرور چه چیزهایی هستند", limit=1)
        self.assertTrue(top)
        self.assertEqual(top[0][0].id, "ranks-overview")

    def test_search_finds_anticheat(self):
        top = self.kb.search("ضد تقلب چطور کار می کند", limit=1)
        self.assertTrue(top)
        self.assertIn("anticheat", top[0][0].id)

    def test_search_ranks_are_descending(self):
        results = self.kb.search("جی پی اس ترموکس", limit=5)
        scores = [score for _, score in results]
        self.assertEqual(scores, sorted(scores, reverse=True))

    def test_gibberish_returns_nothing(self):
        self.assertEqual(self.kb.search("zzzz qqqq xxxx", limit=3), [])

    def test_empty_query_returns_nothing(self):
        self.assertEqual(self.kb.search("", limit=3), [])

    def test_missing_directory_is_safe(self):
        empty = KnowledgeBase(directory=ROOT / "no-such-folder")
        self.assertEqual(len(empty), 0)
        self.assertEqual(empty.search("anything"), [])

    def test_malformed_json_file_is_skipped_not_fatal(self):
        import tempfile
        from pathlib import Path

        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / "bad.json").write_text("{not json", encoding="utf-8")
            (Path(tmp) / "good.json").write_text(
                json.dumps({"entries": [{"id": "x", "title": "عنوان", "body": "متن"}]}),
                encoding="utf-8",
            )
            kb = KnowledgeBase(directory=Path(tmp))
            self.assertEqual(len(kb), 1)
            self.assertTrue(kb.search("عنوان"))


class MarkdownTests(unittest.TestCase):
    def test_renders_the_shipped_readme_without_raising(self):
        html = render((ROOT / "README.md").read_text(encoding="utf-8"))
        self.assertIn("<h1>", html)

    def test_renders_the_feasibility_study(self):
        html = render((ROOT / "docs/FEASIBILITY.md").read_text(encoding="utf-8"))
        self.assertIn("<table>", html)
        self.assertIn("</table>", html)

    def test_html_in_source_is_escaped_not_executed(self):
        out = render("سلام <script>alert(1)</script>")
        self.assertNotIn("<script>", out)
        self.assertIn("&lt;script&gt;", out)

    def test_headings_lists_code_and_links(self):
        out = render(
            "# عنوان\n\n- مورد یک\n- مورد دو\n\n1. اول\n2. دوم\n\n"
            "```python\nprint('hi')\n```\n\n[لینک](https://example.com)\n\n"
            "**پررنگ** و `کد`\n\n> نقل قول\n\n---\n"
        )
        self.assertIn("<h1>عنوان</h1>", out)
        self.assertIn("<ul>", out)
        self.assertIn("<ol>", out)
        self.assertIn("<pre><code>", out)
        self.assertIn('href="https://example.com"', out)
        self.assertIn("<strong>پررنگ</strong>", out)
        self.assertIn("<code>کد</code>", out)
        self.assertIn("<blockquote>", out)
        self.assertIn("<hr>", out)

    def test_unterminated_code_fence_is_still_shown(self):
        out = render("```js\nlet x = 1;")
        self.assertIn("let x = 1;", out)

    def test_empty_input(self):
        self.assertEqual(render(""), "")


class PathSafetyTests(unittest.TestCase):
    def test_relative_paths_resolve_inside_root(self):
        self.assertEqual(safe_resolve("README.md"), (ROOT / "README.md").resolve())

    def test_dotdot_that_escapes_is_refused(self):
        with self.assertRaises(PermissionError):
            safe_resolve("../../etc/passwd")

    def test_absolute_path_outside_root_is_refused(self):
        with self.assertRaises(PermissionError):
            safe_resolve("/etc/passwd")

    def test_absolute_path_inside_root_is_allowed(self):
        self.assertEqual(safe_resolve(str(ROOT / "README.md")).name, "README.md")

    def test_human_size(self):
        self.assertEqual(human_size(512), "512 B")
        self.assertTrue(human_size(2048).endswith("KB"))


class CatalogSyncTests(unittest.TestCase):
    """The Python side reads data/catalog.json; it must match the TS source."""

    def setUp(self):
        with open(ROOT / "data/catalog.json", encoding="utf-8") as fh:
            self.catalog = json.load(fh)

    def test_shape(self):
        self.assertEqual(self.catalog["count"], len(self.catalog["products"]))
        self.assertIn("ranks", self.catalog)

    def test_six_ranks_are_present(self):
        self.assertEqual(
            set(self.catalog["ranks"]),
            {"free", "noob", "normal", "pro", "god", "ultragod"},
        )

    def test_every_product_has_a_persian_title_and_a_price(self):
        for product in self.catalog["products"]:
            self.assertTrue(product["title_fa"], product["sku"])
            self.assertGreaterEqual(product["price_usd"], 0)
            self.assertIsInstance(product["price_usd"], int)  # cents, not float

    def test_free_rank_is_visible_before_auth(self):
        free = [p for p in self.catalog["products"] if p["sku"] == "rank-free"]
        self.assertEqual(len(free), 1)
        self.assertTrue(free[0]["visible_before_auth"])
        self.assertEqual(free[0]["price_usd"], 0)

    def test_in_sync_with_the_typescript_catalogue(self):
        """
        Runs the real exporter in --check mode when its toolchain is available.

        The exporter needs both node and esbuild (from node_modules). On a
        phone neither exists, and a skipped sync check is reported as skipped
        rather than quietly counted as passing.
        """
        import shutil
        import subprocess

        node = shutil.which("node")
        if not node:
            self.skipTest("node not installed; cannot verify catalogue sync")
        if not (ROOT / "node_modules" / "esbuild").is_dir():
            self.skipTest("node_modules/esbuild missing; run `npm install` first")
        proc = subprocess.run(
            [node, "scripts/export-catalog.mjs", "--check"],
            cwd=str(ROOT), capture_output=True, text=True, timeout=120, check=False,
        )
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertIn("in sync", proc.stdout)


class StoreSmokeTests(unittest.TestCase):
    def test_schema_is_created_on_a_fresh_database(self):
        import sqlite3
        import tempfile
        from pathlib import Path

        with tempfile.TemporaryDirectory() as tmp:
            store = PlaceStore(db_path=Path(tmp) / "fresh.db")
            store.save("خونه", 35.7, 51.4)
            conn = sqlite3.connect(str(Path(tmp) / "fresh.db"))
            tables = {r[0] for r in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table'")}
            self.assertIn("places", tables)
            self.assertIn("place_aliases", tables)
            self.assertIn("gps_track", tables)


if __name__ == "__main__":
    unittest.main()
