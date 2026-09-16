"""Intent recognition on real Persian phrasing, including typos."""

from __future__ import annotations

import unittest

from termuxapp.intents import classify, intent_descriptions


def top(text: str) -> str:
    matches = classify(text)
    return matches[0].intent if matches else "unknown"


def slot(text: str, name: str) -> str:
    matches = classify(text)
    return matches[0].slots.get(name, "") if matches else ""


class IntentTests(unittest.TestCase):
    def test_save_place_with_explicit_name(self):
        self.assertEqual(top("اینجا رو سیو کن به اسم خونه"), "save_place")
        self.assertEqual(slot("اینجا رو سیو کن به اسم خونه", "name"), "خانه")

    def test_save_place_other_wording(self):
        self.assertEqual(top("موقعیت من را ذخیره کن به نام محل کار"), "save_place")
        self.assertIn("محل کار", slot("موقعیت من را ذخیره کن به نام محل کار", "name"))

    def test_save_place_bare_asks_for_a_name(self):
        # No name captured: the rule must still fire but with lower confidence,
        # so the assistant asks instead of inventing a name.
        matches = classify("اینجا را ذخیره کن")
        self.assertTrue(matches)
        self.assertEqual(matches[0].intent, "save_place")

    def test_navigate(self):
        self.assertEqual(top("برم خونه"), "navigate")
        self.assertEqual(slot("برم خونه", "destination"), "خانه")
        self.assertEqual(top("چطور برم محل کار"), "navigate")
        self.assertEqual(top("مسیر باشگاه"), "navigate")

    def test_where_am_i_variants(self):
        for text in ("کجام؟", "الان کجام", "موقعیت من کجاست", "مختصات من"):
            self.assertEqual(top(text), "where_am_i", text)

    def test_list_places(self):
        self.assertEqual(top("مکان‌های ذخیره شده"), "list_places")
        self.assertEqual(top("لیست مکان ها"), "list_places")

    def test_delete_place(self):
        self.assertEqual(top("خونه رو پاک کن"), "delete_place")
        self.assertEqual(slot("خونه رو پاک کن", "name"), "خانه")

    def test_distance(self):
        self.assertEqual(top("فاصله تا باشگاه چقدره"), "distance")
        self.assertIn("باشگاه", slot("فاصله تا باشگاه چقدره", "destination"))

    def test_nearest(self):
        self.assertEqual(top("نزدیک ترین مکان کدومه"), "nearest_place")

    def test_gps_status(self):
        self.assertEqual(top("وضعیت جی پی اس چطوره"), "gps_status")
        self.assertEqual(top("gps کار میکنه؟"), "gps_status")

    def test_platform_intents(self):
        self.assertEqual(top("وضعیت سرور چطوره"), "server_status")
        self.assertEqual(top("گیم مودها چیا هستن"), "gamemodes")
        self.assertEqual(top("فروشگاه رو نشون بده"), "shop")
        self.assertEqual(top("رنک گاد چه مزیتی داره"), "rank")
        self.assertEqual(top("قیمت رنک پرو چنده"), "price")
        self.assertEqual(top("تخفیف دارید؟"), "discount")
        self.assertEqual(top("انتی چیت چطور کار میکنه"), "anticheat")
        self.assertEqual(top("کد دعوت دارم؟"), "referral")

    def test_social_and_meta(self):
        self.assertEqual(top("سلام"), "greeting")
        self.assertEqual(top("ممنون"), "thanks")
        self.assertEqual(top("کمک"), "help")
        self.assertEqual(top("بله"), "confirm_yes")
        self.assertEqual(top("نه"), "confirm_no")

    def test_track(self):
        self.assertEqual(top("مسیر طی شده رو نشون بده"), "track")

    def test_time(self):
        self.assertEqual(top("ساعت چند است"), "time")

    def test_gibberish_is_not_forced_into_an_intent(self):
        matches = classify("qwertyuiop zxcvbnm")
        self.assertEqual(matches, [])

    def test_empty_input(self):
        self.assertEqual(classify(""), [])
        self.assertEqual(classify("   "), [])

    def test_confidence_prefers_slot_capturing_rules(self):
        matches = classify("برم خونه")
        self.assertGreater(matches[0].confidence, 0.5)

    def test_descriptions_cover_every_rule(self):
        descs = intent_descriptions()
        self.assertGreater(len(descs), 15)
        self.assertTrue(all(d["description"] for d in descs))


if __name__ == "__main__":
    unittest.main()
