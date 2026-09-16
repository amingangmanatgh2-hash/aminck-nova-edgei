"""Shared fixtures: a fake Termux:API runner and throwaway storage."""

from __future__ import annotations

import json
import tempfile
import unittest
import unittest.mock as mock
from pathlib import Path

from termuxapp.gps import GpsProvider
from termuxapp.knowledge import KnowledgeBase
from termuxapp.places import PlaceStore

TEHRAN = (35.6997, 51.3379)
KARAJ = (35.8327, 50.9915)
ISFAHAN = (32.6539, 51.6660)


def fix_payload(lat: float, lon: float, accuracy: float = 12.0,
                provider: str = "gps", **extra) -> str:
    data = {
        "latitude": lat,
        "longitude": lon,
        "altitude": 1180.0,
        "accuracy": accuracy,
        "verticalAccuracy": 3.0,
        "bearing": 0.0,
        "speed": 0.0,
        "elapsedMs": 1234,
        "provider": provider,
    }
    data.update(extra)
    return json.dumps(data)


class FakeRunner:
    """
    Stands in for ``termux-location``.

    Records every argv it was called with and returns a queued result, so the
    parsing/error branches in gps.py are exercised exactly as on the phone.
    """

    def __init__(self, *results: tuple[int, str, str]) -> None:
        self.queue = list(results)
        self.calls: list[list[str]] = []

    def __call__(self, argv: list[str], timeout: float) -> tuple[int, str, str]:
        self.calls.append(list(argv))
        if self.queue:
            return self.queue.pop(0)
        return (0, fix_payload(*TEHRAN), "")

    @staticmethod
    def ok(payload: str) -> tuple[int, str, str]:
        return (0, payload, "")

    @staticmethod
    def fail(stderr: str = "boom", code: int = 1) -> tuple[int, str, str]:
        return (code, "", stderr)


class TempCase(unittest.TestCase):
    """Gives each test its own DB, memory dir and (optionally) fake Termux."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        base = Path(self._tmp.name)
        self.db_path = base / "nova.db"
        self.memory_dir = base / "memory"
        self.memory_dir.mkdir()
        self.cache_path = base / "last_fix.json"
        self.places = PlaceStore(db_path=self.db_path)

    def gps_with(self, *results: tuple[int, str, str], assume_api: bool = True) -> tuple[GpsProvider, FakeRunner]:
        runner = FakeRunner(*results)
        gps = GpsProvider(runner=runner, cache_path=self.cache_path)
        if assume_api:
            patcher = mock.patch("termuxapp.gps.api_binary_available", return_value=True)
            patcher.start()
            self.addCleanup(patcher.stop)
        return gps, runner

    def knowledge(self) -> KnowledgeBase:
        """The real shipped knowledge base, not a fixture."""
        return KnowledgeBase()
