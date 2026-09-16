"""GPS through a faked termux-location: every failure branch is exercised."""

from __future__ import annotations

import json
import time

from termuxapp.gps import INSTALL_HINT_FA, GpsError, GpsFix

from .helpers import TEHRAN, FakeRunner, TempCase, fix_payload


class FetchTests(TempCase):
    def test_parses_a_good_fix_and_caches_it(self):
        gps, runner = self.gps_with(FakeRunner.ok(fix_payload(*TEHRAN, accuracy=8)))
        fix = gps.fetch(provider="gps")
        self.assertAlmostEqual(fix.lat, TEHRAN[0])
        self.assertAlmostEqual(fix.lon, TEHRAN[1])
        self.assertEqual(fix.accuracy, 8.0)
        self.assertEqual(runner.calls[0], ["termux-location", "-p", "gps", "-r", "once"])
        self.assertTrue(self.cache_path.exists())

    def test_missing_termux_api_is_reported_not_faked(self):
        gps, _ = self.gps_with(assume_api=False)
        with self.assertRaises(GpsError) as ctx:
            gps.fetch()
        self.assertEqual(ctx.exception.reason, "termux_api_missing")
        self.assertEqual(ctx.exception.hint_fa, INSTALL_HINT_FA)

    def test_empty_output_is_an_error(self):
        gps, _ = self.gps_with(FakeRunner.ok(""))
        with self.assertRaises(GpsError) as ctx:
            gps.fetch()
        self.assertEqual(ctx.exception.reason, "empty_response")

    def test_permission_error_is_classified(self):
        payload = json.dumps({"error": "Location permission not granted"})
        gps, _ = self.gps_with(FakeRunner.ok(payload))
        with self.assertRaises(GpsError) as ctx:
            gps.fetch()
        self.assertEqual(ctx.exception.reason, "permission_denied")

    def test_zero_zero_is_treated_as_no_fix_not_as_a_location(self):
        # Android's "not locked yet" sentinel would otherwise land the user in
        # the Gulf of Guinea.
        gps, _ = self.gps_with(FakeRunner.ok(fix_payload(0.0, 0.0)))
        with self.assertRaises(GpsError) as ctx:
            gps.fetch()
        self.assertEqual(ctx.exception.reason, "no_fix")

    def test_malformed_json_is_an_error(self):
        gps, _ = self.gps_with(FakeRunner.ok("{not json"))
        with self.assertRaises(GpsError) as ctx:
            gps.fetch()
        self.assertEqual(ctx.exception.reason, "bad_json")

    def test_payload_without_coordinates_is_an_error(self):
        gps, _ = self.gps_with(FakeRunner.ok(json.dumps({"accuracy": 5})))
        with self.assertRaises(GpsError) as ctx:
            gps.fetch()
        self.assertEqual(ctx.exception.reason, "bad_payload")

    def test_updates_stream_takes_the_last_complete_object(self):
        stream = "\n".join([
            fix_payload(35.0, 51.0),
            fix_payload(35.5, 51.5),
            fix_payload(35.6997, 51.3379),
        ])
        gps, _ = self.gps_with(FakeRunner.ok(stream))
        fix = gps.fetch(request="updates")
        self.assertAlmostEqual(fix.lat, 35.6997)


class CacheAndManualTests(TempCase):
    def test_cached_fix_round_trip(self):
        gps, _ = self.gps_with()
        self.assertIsNone(gps.cached_fix())
        gps.save(GpsFix(lat=35.1, lon=51.1, accuracy=9, source="gps"))
        got = gps.cached_fix()
        self.assertIsNotNone(got)
        self.assertAlmostEqual(got.lat, 35.1)
        self.assertEqual(got.source, "cache")

    def test_stale_cache_is_rejected_by_age(self):
        gps, _ = self.gps_with()
        gps.save(GpsFix(lat=1.0, lon=1.0, taken_at=time.time() - 10 ** 6))
        self.assertIsNone(gps.cached_fix())
        self.assertIsNotNone(gps.cached_fix(max_age_s=None))

    def test_corrupt_cache_file_does_not_crash(self):
        self.cache_path.write_text("{oops", encoding="utf-8")
        gps, _ = self.gps_with()
        self.assertIsNone(gps.cached_fix())

    def test_manual_fix_is_validated(self):
        gps, _ = self.gps_with()
        fix = gps.manual_fix(35.7, 51.4)
        self.assertEqual(fix.source, "manual")
        with self.assertRaises(GpsError):
            gps.manual_fix(95.0, 51.0)
        with self.assertRaises(GpsError):
            gps.manual_fix(35.0, -200.0)

    def test_age_fa_is_human_readable(self):
        fresh = GpsFix(lat=0, lon=0)
        self.assertEqual(fresh.age_fa(), "همین الان")
        old = GpsFix(lat=0, lon=0, taken_at=time.time() - 3 * 3600)
        self.assertIn("ساعت", old.age_fa())


class ResolveTests(TempCase):
    def test_falls_back_from_gps_to_network(self):
        gps, runner = self.gps_with(
            FakeRunner.ok(json.dumps({"error": "gps unavailable"})),
            FakeRunner.ok(fix_payload(35.8327, 50.9915, provider="network")),
        )
        fix, notes = gps.resolve(provider="gps")
        self.assertEqual(fix.provider, "network")
        self.assertEqual(len(runner.calls), 2)
        self.assertTrue(any("network" in n for n in notes))

    def test_falls_back_to_cache_when_hardware_fails(self):
        gps, _ = self.gps_with()
        gps.save(GpsFix(lat=35.7, lon=51.4, accuracy=20))
        gps, _ = self.gps_with(FakeRunner.ok(""), FakeRunner.ok(""), FakeRunner.ok(""))
        fix, notes = gps.resolve()
        self.assertEqual(fix.source, "cache")
        self.assertTrue(notes)

    def test_raises_when_nothing_is_available(self):
        gps, _ = self.gps_with(FakeRunner.ok(""), FakeRunner.ok(""), FakeRunner.ok(""))
        with self.assertRaises(GpsError) as ctx:
            gps.resolve(allow_cache=True)
        self.assertEqual(ctx.exception.reason, "no_location")

    def test_status_explains_the_environment(self):
        gps, _ = self.gps_with(assume_api=False)
        st = gps.status()
        self.assertIn("is_termux", st)
        self.assertFalse(st["termux_api_installed"])
        self.assertEqual(st["hint_fa"], INSTALL_HINT_FA)

    def test_watch_requires_termux_api(self):
        gps, _ = self.gps_with(assume_api=False)
        self.assertFalse(gps.start_watch())
        self.assertFalse(gps.is_watching())


if __name__ == "__main__":
    import unittest

    unittest.main()
