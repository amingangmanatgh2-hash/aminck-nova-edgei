"""End-to-end assistant behaviour with a faked GPS and throwaway storage."""

from __future__ import annotations

import json

from termuxapp.assistant import Assistant
from termuxapp.gps import INSTALL_HINT_FA
from termuxapp.paths import CATALOG_PATH

from .helpers import ISFAHAN, KARAJ, TEHRAN, FakeRunner, TempCase, fix_payload


class AssistantCase(TempCase):
    """Assistant wired to a fake radio and the real shipped knowledge base."""

    def build(self, *gps_results, assume_api: bool = True) -> Assistant:
        self.gps, self.runner = self.gps_with(*gps_results, assume_api=assume_api)
        self.assistant = Assistant(
            places=self.places,
            gps=self.gps,
            kb=self.knowledge(),
            memory_dir=self.memory_dir,
            catalog_path=CATALOG_PATH,
        )
        return self.assistant

    def with_good_gps(self) -> Assistant:
        # Every fetch returns Tehran; the fake runner repeats the last result.
        return self.build(FakeRunner.ok(fix_payload(*TEHRAN, accuracy=8)))

    def with_dead_gps(self) -> Assistant:
        return self.build(FakeRunner.ok(""), FakeRunner.ok(""), FakeRunner.ok(""))


class SaveFlow(AssistantCase):
    def test_save_with_name_in_one_message(self):
        a = self.with_good_gps()
        reply = a.ask("اینجا رو سیو کن به اسم خونه")
        self.assertEqual(reply.intent, "save_place")
        self.assertEqual(reply.kind, "action")
        self.assertIn("ذخیره شد", reply.text)
        # Names are stored in canonical written form so «خونه» and «خانه» are
        # the same place rather than two pins. Lookup accepts either.
        self.assertEqual(reply.data["place"]["name"], "خانه")
        self.assertIsNotNone(self.places.get("خونه"))
        self.assertIsNotNone(self.places.get("خانه"))

    def test_save_without_name_asks_then_accepts_the_name(self):
        a = self.with_good_gps()
        first = a.ask("اینجا را ذخیره کن")
        self.assertEqual(first.kind, "question")
        self.assertIn("اسمش", first.text)
        second = a.ask("محل کار")
        self.assertEqual(second.intent, "save_place")
        self.assertEqual(second.kind, "action")
        self.assertEqual(second.data["place"]["name"], "محل کار")

    def test_when_gps_is_down_it_asks_for_coordinates_and_then_saves(self):
        """
        Regression: the pending action used to be cleared before the name was
        read back out, so this second step always lost the place name.
        """
        a = self.with_dead_gps()
        first = a.ask("اینجا رو سیو کن به اسم خونه")
        self.assertEqual(first.kind, "error")
        self.assertIn("مختصات", first.text)
        second = a.ask("35.6997 51.3379")
        self.assertEqual(second.kind, "action", second.text)
        self.assertEqual(second.data["place"]["name"], "خانه")
        self.assertAlmostEqual(second.data["place"]["lat"], 35.6997)

    def test_manual_coordinates_are_validated(self):
        a = self.with_dead_gps()
        a.ask("اینجا رو سیو کن به اسم خونه")
        reply = a.ask("999 999")
        self.assertEqual(reply.kind, "error")

    def test_resaving_moves_the_pin_and_says_updated(self):
        a = self.with_good_gps()
        a.ask("اینجا رو سیو کن به اسم خونه")
        # Second save comes from a different fix.
        a.gps.runner.queue.append(FakeRunner.ok(fix_payload(*KARAJ, accuracy=8)))
        a.gps.runner.queue.append(FakeRunner.ok(fix_payload(*KARAJ, accuracy=8)))
        reply = a.ask("خونه رو سیو کن")
        self.assertIn("به‌روزرسانی شد", reply.text)
        self.assertEqual(len(self.places.all()), 1)


class NavigateFlow(AssistantCase):
    def test_navigate_reports_direction_distance_and_eta(self):
        a = self.with_good_gps()
        self.places.save("کرج", *KARAJ)
        reply = a.ask("برم کرج")
        self.assertEqual(reply.intent, "navigate")
        self.assertEqual(reply.kind, "action")
        self.assertIn("جهت", reply.text)
        self.assertIn("کیلومتر", reply.text)
        self.assertIn("google.com/maps", reply.data["maps"])
        self.assertGreater(reply.data["leg"]["metres"], 30_000)

    def test_navigate_to_unknown_suggests_closest_names(self):
        a = self.with_good_gps()
        self.places.save("خونه", *TEHRAN)
        reply = a.ask("برم خون")
        self.assertIn("خونه", reply.text + "".join(reply.suggestions))

    def test_navigate_with_no_places_tells_you_to_save_one(self):
        a = self.with_good_gps()
        reply = a.ask("برم خونه")
        self.assertEqual(reply.kind, "not_found")
        self.assertIn("ذخیره", reply.text)

    def test_anaphora_resolves_to_the_last_place(self):
        a = self.with_good_gps()
        self.places.save("باشگاه", *ISFAHAN)
        a.ask("برم باشگاه")
        reply = a.ask("برم همونجا")
        self.assertEqual(reply.data.get("place_name"), "باشگاه")

    def test_navigate_without_a_fix_still_shows_the_saved_point(self):
        a = self.with_dead_gps()
        self.places.save("کرج", *KARAJ)
        reply = a.ask("برم کرج")
        self.assertEqual(reply.kind, "error")
        self.assertIn("35.83", reply.text)
        self.assertIn("موقعیت فعلی", reply.text)


class OtherIntents(AssistantCase):
    def test_list_places(self):
        a = self.with_good_gps()
        self.places.save("خونه", *TEHRAN)
        self.places.save("باشگاه", *ISFAHAN)
        reply = a.ask("مکان‌های ذخیره شده")
        self.assertEqual(reply.intent, "list_places")
        self.assertEqual(reply.data["count"], 2)

    def test_list_places_when_empty(self):
        a = self.with_good_gps()
        reply = a.ask("مکان‌های ذخیره شده")
        self.assertEqual(reply.kind, "not_found")

    def test_delete_place(self):
        a = self.with_good_gps()
        self.places.save("خونه", *TEHRAN)
        reply = a.ask("خونه رو پاک کن")
        self.assertEqual(reply.kind, "action")
        self.assertIsNone(self.places.get("خونه"))

    def test_delete_unknown_place(self):
        a = self.with_good_gps()
        reply = a.ask("فرودگاه رو پاک کن")
        self.assertEqual(reply.kind, "not_found")

    def test_where_am_i(self):
        a = self.with_good_gps()
        reply = a.ask("کجام؟")
        self.assertEqual(reply.intent, "where_am_i")
        self.assertIn("35.69", reply.text)
        self.assertEqual(reply.data["quality"], "excellent")

    def test_where_am_i_without_gps_is_an_honest_error(self):
        a = self.with_dead_gps()
        reply = a.ask("کجام؟")
        self.assertEqual(reply.kind, "error")
        self.assertNotIn("0.0", reply.text)

    def test_gps_status_explains_the_missing_add_on(self):
        a = self.build(FakeRunner.ok(""), assume_api=False)
        reply = a.ask("وضعیت جی پی اس")
        self.assertEqual(reply.intent, "gps_status")
        self.assertIn("Termux:API", reply.text)

    def test_nearest_place(self):
        a = self.with_good_gps()
        self.places.save("نزدیک", *TEHRAN)
        self.places.save("دور", *ISFAHAN)
        reply = a.ask("نزدیک ترین مکان کدومه")
        self.assertEqual(reply.data["nearest"][0]["name"], "نزدیک")

    def test_distance(self):
        a = self.with_good_gps()
        self.places.save("کرج", *KARAJ)
        reply = a.ask("فاصله تا کرج چقدره")
        self.assertEqual(reply.intent, "distance")
        self.assertGreater(reply.data["metres"], 30_000)

    def test_help_lists_the_real_commands(self):
        a = self.with_good_gps()
        reply = a.ask("کمک")
        for phrase in ("سیو کن", "برم", "مکان‌های ذخیره شده"):
            self.assertIn(phrase, reply.text)

    def test_greeting_reports_place_count(self):
        a = self.with_good_gps()
        self.places.save("خونه", *TEHRAN)
        reply = a.ask("سلام")
        self.assertIn("۱", reply.text)


class KnowledgeAndHonesty(AssistantCase):
    def test_ranks_question_is_answered_from_the_knowledge_base(self):
        a = self.with_good_gps()
        reply = a.ask("رنک‌ها چه چیزهایی هستند")
        self.assertIn("گاد", reply.text)
        self.assertTrue(reply.sources)
        self.assertIn("data/knowledge", reply.sources[0])

    def test_anticheat_question_quotes_the_measured_result(self):
        a = self.with_good_gps()
        reply = a.ask("نتیجه تست ضد تقلب چی شد")
        self.assertIn("۰٪", reply.text)

    def test_shop_lists_real_catalogue_entries(self):
        a = self.with_good_gps()
        reply = a.ask("فروشگاه چه چیزهایی دارد")
        self.assertEqual(reply.intent, "shop")
        self.assertGreater(reply.data["count"], 20)
        self.assertIn("رنک", reply.text)

    def test_price_question_finds_the_product(self):
        a = self.with_good_gps()
        reply = a.ask("قیمت رنک پرو")
        self.assertEqual(reply.intent, "price")
        self.assertIn("$", reply.text)

    def test_server_status_is_honest_about_being_offline(self):
        a = self.with_good_gps()
        reply = a.ask("وضعیت سرور چطوره")
        self.assertIn("آفلاین", reply.text)
        self.assertIn("نمی‌توانم", reply.text)

    def test_unknown_question_is_not_answered_with_an_invention(self):
        a = self.with_good_gps()
        reply = a.ask("آیا گیتار الکتریک از پیانو بهتر است")
        self.assertEqual(reply.kind, "not_found")
        self.assertIn("نمی‌دانم", reply.text)

    def test_empty_input_returns_help(self):
        a = self.with_good_gps()
        self.assertEqual(a.ask("").intent, "help")

    def test_feedback_shifts_ranking(self):
        a = self.with_good_gps()
        before = a.kb.search("ضد تقلب چطور کار می کند", limit=1)
        self.assertTrue(before)
        a.feedback("ضد تقلب چطور کار می کند", "anticheat-measured", True)
        self.assertEqual(a._feedback.get("anticheat-measured"), 1)

    def test_state_persists_between_instances(self):
        a = self.with_good_gps()
        a.ask("برم nowhere")
        self.assertGreaterEqual(int(a.state["turns"]), 1)
        raw = json.loads((self.memory_dir / "dialogue.json").read_text(encoding="utf-8"))
        self.assertEqual(raw["turns"], a.state["turns"])

    def test_reset_clears_memory_but_keeps_places(self):
        a = self.with_good_gps()
        self.places.save("خونه", *TEHRAN)
        a.ask("برم خونه")
        a.reset()
        self.assertEqual(a.state, {})
        self.assertIsNotNone(self.places.get("خونه"))


if __name__ == "__main__":
    import unittest

    unittest.main()
