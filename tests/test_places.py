"""Saved places: persistence, dedupe, fuzzy lookup, navigation."""

from __future__ import annotations

from .helpers import ISFAHAN, KARAJ, TEHRAN, TempCase


class SaveTests(TempCase):
    def test_save_and_read_back(self):
        place, created = self.places.save("خونه", *TEHRAN, accuracy=9)
        self.assertTrue(created)
        self.assertEqual(place.name, "خونه")
        self.assertAlmostEqual(place.lat, TEHRAN[0])
        got = self.places.get("خونه")
        self.assertIsNotNone(got)
        self.assertEqual(got.id, place.id)

    def test_saving_the_same_name_updates_instead_of_duplicating(self):
        self.places.save("خونه", *TEHRAN)
        place, created = self.places.save("خونه", *KARAJ)
        self.assertFalse(created)
        self.assertEqual(len(self.places.all()), 1)
        self.assertAlmostEqual(place.lat, KARAJ[0])

    def test_normalisation_makes_home_and_khoone_the_same_key(self):
        self.places.save("خانه", *TEHRAN)
        _, created = self.places.save("خانه", *KARAJ)
        self.assertFalse(created)
        self.assertEqual(len(self.places.all()), 1)

    def test_empty_name_and_bad_coordinates_are_rejected(self):
        with self.assertRaises(ValueError):
            self.places.save("   ", *TEHRAN)
        with self.assertRaises(ValueError):
            self.places.save("x", 95.0, 51.0)
        with self.assertRaises(ValueError):
            self.places.save("x", 35.0, 400.0)

    def test_save_is_durable_across_store_instances(self):
        self.places.save("باشگاه", *TEHRAN)
        reopened = type(self.places)(db_path=self.db_path)
        self.assertIsNotNone(reopened.get("باشگاه"))


class LookupTests(TempCase):
    def setUp(self):
        super().setUp()
        self.places.save("خونه", *TEHRAN)
        self.places.save("محل کار", *KARAJ)
        self.places.save("باشگاه", *ISFAHAN)

    def test_exact_match(self):
        self.assertEqual(self.places.get("محل کار").name, "محل کار")

    def test_misspelling_still_resolves(self):
        got = self.places.get("خون")
        self.assertIsNotNone(got, "«خون» should still resolve to «خونه»")
        self.assertEqual(got.name, "خونه")

    def test_unknown_returns_none(self):
        self.assertIsNone(self.places.get("فرودگاه"))

    def test_suggest_names_returns_closest_first(self):
        sugg = self.places.suggest_names("خونه")
        self.assertEqual(sugg[0], "خونه")

    def test_aliases_resolve_to_the_place(self):
        self.assertTrue(self.places.add_alias("خونه", "منزل"))
        got = self.places.get("منزل")
        self.assertIsNotNone(got)
        self.assertEqual(got.name, "خونه")
        self.assertIn("منزل", got.aliases)

    def test_alias_for_unknown_place_returns_false(self):
        self.assertFalse(self.places.add_alias("فرودگاه", "x"))

    def test_visit_count_breaks_ties(self):
        for _ in range(4):
            self.places.touch("باشگاه")
        got = self.places.get("باشگاه")
        self.assertEqual(got.visits, 4)


class DeleteAndNavTests(TempCase):
    def test_delete(self):
        self.places.save("خونه", *TEHRAN)
        self.assertTrue(self.places.delete("خونه"))
        self.assertIsNone(self.places.get("خونه"))
        self.assertFalse(self.places.delete("خونه"))

    def test_route_to_computes_a_leg(self):
        self.places.save("کرج", *KARAJ)
        got = self.places.route_to("کرج", *TEHRAN)
        self.assertIsNotNone(got)
        place, leg = got
        self.assertEqual(place.name, "کرج")
        self.assertGreater(leg.metres, 25_000)
        self.assertTrue(leg.compass)

    def test_route_to_unknown_is_none(self):
        self.assertIsNone(self.places.route_to("ناکجا", *TEHRAN))

    def test_nearest_orders_by_distance(self):
        self.places.save("نزدیک", *TEHRAN)
        self.places.save("دور", *ISFAHAN)
        near = self.places.nearest(*TEHRAN, limit=2)
        self.assertEqual(near[0][0].name, "نزدیک")
        self.assertLess(near[0][1], near[1][1])

    def test_track_records_and_clears(self):
        self.places.record_track_point(*TEHRAN, accuracy=10)
        self.places.record_track_point(*KARAJ, accuracy=10)
        track = self.places.track()
        self.assertEqual(len(track), 2)
        self.assertEqual(self.places.clear_track(), 2)
        self.assertEqual(self.places.track(), [])


if __name__ == "__main__":
    import unittest

    unittest.main()
