"""Persian normalisation, fuzzy matching and geodesy."""

from __future__ import annotations

import unittest

from termuxapp.fuzzy import (best_match, combined, dice, jaro, jaro_winkler,
                             levenshtein, phonetic_key, similarity)
from termuxapp.geo import (accuracy_verdict, compass_fa, format_dms, haversine_m,
                           initial_bearing, maps_url, plan_route)
from termuxapp.normalize import (colloquial, ngrams, normalize, stem,
                                 stem_tokens, tokenize)


class NormalizeTests(unittest.TestCase):
    def test_arabic_letters_collapse_to_persian(self):
        self.assertEqual(normalize("كتاب"), "کتاب")
        self.assertEqual(normalize("علي"), "علی")

    def test_persian_and_arabic_digits_become_ascii(self):
        self.assertEqual(normalize("۱۲۳۴۵"), "12345")
        self.assertEqual(normalize("٩٨٧"), "987")

    def test_zwnj_becomes_a_space_so_tokens_split(self):
        self.assertEqual(normalize("می‌روم"), "می روم")
        self.assertEqual(tokenize("می‌روم"), ["می", "روم"])
        self.assertEqual(tokenize("خانه‌ی بزرگ"), ["خانه", "ی", "بزرگ"])

    def test_diacritics_are_stripped(self):
        self.assertEqual(normalize("مُحمَّد"), "محمد")

    def test_colloquial_forms_expand(self):
        self.assertIn("خانه", colloquial("خونه"))
        self.assertIn("ذخیره", colloquial("سیو"))
        self.assertIn("بروم", colloquial("برم"))

    def test_stopwords_are_dropped_by_default(self):
        self.assertNotIn("و", tokenize("خانه و مدرسه"))
        self.assertIn("و", tokenize("خانه و مدرسه", keep_stopwords=True))

    def test_stem_is_light_and_never_mangles_short_words(self):
        self.assertEqual(stem("خانه"), "خانه")
        self.assertEqual(len(stem("ab")), 2)
        self.assertTrue(stem("کتابها").startswith("کتاب"))

    def test_stem_tokens_runs_over_a_sentence(self):
        # "های" and "به" are stopwords, so three content words survive.
        self.assertEqual(len(stem_tokens("مسیر رفتن به باشگاه")), 3)

    def test_stopwords_include_the_common_persian_ones(self):
        # "شده"/"های"/"من" are grammatical, not searchable content.
        self.assertEqual(stem_tokens("خانه من بزرگ شده است"), ["خانه", "بزرگ"])

    def test_ngrams(self):
        self.assertEqual(ngrams("abc", 2), ["ab", "bc"])
        self.assertEqual(ngrams("a", 2), ["a"])

    def test_empty_input_is_safe(self):
        self.assertEqual(normalize(""), "")
        self.assertEqual(tokenize(""), [])
        self.assertEqual(ngrams(""), [])


class FuzzyTests(unittest.TestCase):
    def test_levenshtein_basics(self):
        self.assertEqual(levenshtein("kitten", "sitting"), 3)
        self.assertEqual(levenshtein("خانه", "خانه"), 0)
        self.assertEqual(levenshtein("", "abc"), 3)

    def test_levenshtein_cutoff_short_circuits(self):
        # With cutoff 1 the answer is only guaranteed to be >1, not exact.
        self.assertEqual(levenshtein("abcdef", "uvwxyz", cutoff=1), 2)

    def test_similarity_bounds(self):
        self.assertEqual(similarity("abc", "abc"), 1.0)
        self.assertEqual(similarity("", "abc"), 0.0)
        self.assertLess(similarity("خانه", "مدرسه"), 0.6)

    def test_jaro_and_winkler(self):
        self.assertGreater(jaro("martha", "marhta"), 0.9)
        self.assertGreaterEqual(jaro_winkler("martha", "marhta"), jaro("martha", "marhta"))
        self.assertEqual(jaro("", "x"), 0.0)

    def test_dice_is_order_forgiving(self):
        self.assertGreater(dice("تهران", "تهران"), 0.99)
        self.assertLess(dice("تهران", "شیراز"), 0.3)

    def test_phonetic_key_merges_homophones(self):
        # ز / ذ / ض / ظ all sound the same in Persian.
        self.assertEqual(phonetic_key("حساب"), phonetic_key("هساب"))
        self.assertEqual(phonetic_key("ذکر"), phonetic_key("زکر"))
        self.assertEqual(phonetic_key("قصد"), phonetic_key("غصد"))

    def test_combined_scores_homophone_misspelling_highly(self):
        # A spelling an edit distance alone would penalise by 2 edits.
        self.assertGreater(combined("حساب", "هساب"), 0.75)

    def test_combined_rejects_unrelated(self):
        self.assertLess(combined("خونه", "یخچال"), 0.35)

    def test_best_match_ranks_and_floors(self):
        got = best_match("خونه", ["خانه", "مدرسه", "باشگاه"], limit=3, floor=0.3)
        self.assertTrue(got)
        self.assertEqual(got[0][0], "خانه")
        self.assertTrue(all(score >= 0.3 for _, score in got))


class GeoTests(unittest.TestCase):
    def test_haversine_tehran_to_karaj_is_about_35km(self):
        # Straight line, not road distance: ~34.6 km.
        d = haversine_m(35.6997, 51.3379, 35.8327, 50.9915)
        self.assertGreater(d, 33_000)
        self.assertLess(d, 36_000)

    def test_haversine_same_point_is_zero(self):
        self.assertEqual(haversine_m(35.7, 51.4, 35.7, 51.4), 0.0)

    def test_haversine_symmetric(self):
        a = haversine_m(35.7, 51.4, 32.65, 51.66)
        b = haversine_m(32.65, 51.66, 35.7, 51.4)
        self.assertAlmostEqual(a, b, places=6)

    def test_bearing_north_and_east(self):
        self.assertAlmostEqual(initial_bearing(0, 0, 1, 0), 0.0, places=1)
        self.assertAlmostEqual(initial_bearing(0, 0, 0, 1), 90.0, places=1)
        self.assertAlmostEqual(initial_bearing(0, 0, -1, 0), 180.0, places=1)
        self.assertAlmostEqual(initial_bearing(0, 0, 0, -1), 270.0, places=1)

    def test_compass_labels(self):
        self.assertEqual(compass_fa(0), "شمال")
        self.assertEqual(compass_fa(90), "شرق")
        self.assertEqual(compass_fa(180), "جنوب")
        self.assertEqual(compass_fa(270), "غرب")
        self.assertEqual(compass_fa(45), "شمال‌شرقی")
        self.assertEqual(compass_fa(359), "شمال")

    def test_plan_route_produces_all_eta_modes(self):
        leg = plan_route(35.6997, 51.3379, 35.8327, 50.9915)
        self.assertEqual(set(leg.eta_seconds), {"walk", "bike", "drive"})
        self.assertLess(leg.eta_seconds["drive"], leg.eta_seconds["walk"])
        self.assertIn("کیلومتر", leg.distance_fa)
        self.assertIn("دقیقه", leg.eta_fa("walk"))

    def test_short_leg_reports_metres(self):
        leg = plan_route(35.7, 51.4, 35.7005, 51.4)
        self.assertIn("متر", leg.distance_fa)
        self.assertEqual(leg.eta_fa("walk"), "کمتر از یک دقیقه")

    def test_format_dms(self):
        text = format_dms(35.6997, "lat")
        self.assertTrue(text.startswith("35"))
        self.assertTrue(text.endswith("N"))
        self.assertTrue(format_dms(-51.5, "lon").endswith("W"))

    def test_maps_url_contains_coordinates(self):
        url = maps_url(35.6997, 51.3379)
        self.assertIn("35.699700", url)
        self.assertTrue(url.startswith("https://"))

    def test_accuracy_verdicts(self):
        self.assertEqual(accuracy_verdict(5)[0], "excellent")
        self.assertEqual(accuracy_verdict(20)[0], "good")
        self.assertEqual(accuracy_verdict(40)[0], "fair")
        self.assertEqual(accuracy_verdict(150)[0], "poor")
        self.assertEqual(accuracy_verdict(None)[0], "unknown")


if __name__ == "__main__":
    unittest.main()
