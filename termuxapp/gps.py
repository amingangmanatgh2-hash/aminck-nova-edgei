"""
Real GPS through Termux:API.

Direct answer to "does it get GPS?": yes, but not from Python. Android does not
hand location to an ordinary process. Termux exposes it through the *Termux:API*
add-on app plus the ``termux-api`` package; we shell out to ``termux-location``
and parse its JSON. So the honest chain is:

    Termux:API app installed -> `pkg install termux-api` -> Android location
    permission granted -> `termux-location -p gps -r once` -> JSON -> us.

Any link can be missing. Every failure mode returns a machine-readable reason
plus a Persian hint the UI shows, instead of silently reporting 0,0.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import threading
import time
from dataclasses import asdict, dataclass, field
from typing import Callable, Optional

from .geo import accuracy_verdict
from .paths import LAST_FIX_PATH, ensure_dirs

Runner = Callable[[list[str], float], tuple[int, str, str]]

# Sentinel so `cached_fix()` can distinguish "use the default age limit" from
# "ignore age" (None). A plain None default cannot express both.
_USE_DEFAULT = object()


def _default_runner(argv: list[str], timeout: float) -> tuple[int, str, str]:
    try:
        proc = subprocess.run(
            argv,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
    except FileNotFoundError:
        return 127, "", f"command not found: {argv[0]}"
    except subprocess.TimeoutExpired:
        return 124, "", f"timed out after {timeout}s"
    except OSError as exc:  # pragma: no cover - platform specific
        return 1, "", str(exc)
    return proc.returncode, proc.stdout or "", proc.stderr or ""


def is_termux() -> bool:
    """Termux sets PREFIX under /data/data/com.termux (or the newer path)."""
    prefix = os.environ.get("PREFIX", "")
    if "com.termux" in prefix:
        return True
    return "com.termux" in os.environ.get("HOME", "")


def api_binary_available(binary: str = "termux-location") -> bool:
    return shutil.which(binary) is not None


INSTALL_HINT_FA = (
    "برای گرفتن جی‌پی‌اس باید افزونه‌ی Termux:API نصب باشد:\n"
    "۱) برنامه‌ی «Termux:API» را از F-Droid نصب کنید (نسخه‌ی گوگل‌پلی با ترموکس جدید کار نمی‌کند).\n"
    "۲) داخل ترموکس: pkg install termux-api\n"
    "۳) اجازه‌ی مکان را به Termux و Termux:API بدهید (Location permission) و جی‌پی‌اس گوشی را روشن کنید."
)


@dataclass
class GpsFix:
    lat: float
    lon: float
    accuracy: float | None = None
    altitude: float | None = None
    bearing: float | None = None
    speed: float | None = None
    provider: str = "gps"
    taken_at: float = field(default_factory=time.time)
    source: str = "gps"          # gps | network | cache | manual
    elapsed_ms: int | None = None

    def age_seconds(self) -> float:
        return max(0.0, time.time() - self.taken_at)

    def age_fa(self) -> str:
        from .geo import to_persian_digits

        age = self.age_seconds()
        if age < 60:
            return "همین الان"
        if age < 3600:
            return f"{to_persian_digits(int(age // 60))} دقیقه پیش"
        if age < 86400:
            return f"{to_persian_digits(int(age // 3600))} ساعت پیش"
        return f"{to_persian_digits(int(age // 86400))} روز پیش"

    def quality(self) -> tuple[str, str]:
        return accuracy_verdict(self.accuracy)

    def to_dict(self) -> dict:
        d = asdict(self)
        quality, quality_fa = self.quality()
        d["quality"] = quality
        d["quality_fa"] = quality_fa
        d["age_fa"] = self.age_fa()
        return d


class GpsError(RuntimeError):
    def __init__(self, reason: str, hint_fa: str, code: int | None = None) -> None:
        super().__init__(reason)
        self.reason = reason
        self.hint_fa = hint_fa
        self.code = code


class GpsProvider:
    """
    Wraps ``termux-location`` with caching, timeouts and typed failures.

    ``runner`` is injectable so the whole module is unit-testable on a laptop
    (or in CI) where no Android radio exists. Tests feed it recorded
    termux-location output; the parsing and error handling are the same code
    that runs on the phone.
    """

    def __init__(self, runner: Runner | None = None,
                 cache_path=None,
                 max_cache_age_s: float = 6 * 3600) -> None:
        self.runner = runner or _default_runner
        self.cache_path = cache_path or LAST_FIX_PATH
        self.max_cache_age_s = max_cache_age_s
        self._lock = threading.Lock()
        self._watcher: threading.Thread | None = None
        self._watch_stop = threading.Event()
        self._live: GpsFix | None = None
        self._watch_errors: list[str] = []

    # ------------------------------------------------------------------- probes

    def status(self) -> dict:
        """Everything the UI needs to explain *why* GPS may be unavailable."""
        cached = self.cached_fix(max_age_s=None)
        return {
            "is_termux": is_termux(),
            "termux_api_installed": api_binary_available(),
            "prefix": os.environ.get("PREFIX", ""),
            "hint_fa": None if api_binary_available() else INSTALL_HINT_FA,
            "cached_fix": cached.to_dict() if cached else None,
            "watching": self.is_watching(),
            "watch_errors": list(self._watch_errors[-5:]),
        }

    # --------------------------------------------------------------------- fix

    def fetch(self, provider: str = "gps", request: str = "once",
              timeout: float = 25.0) -> GpsFix:
        if not api_binary_available():
            raise GpsError("termux_api_missing", INSTALL_HINT_FA, 127)
        argv = ["termux-location", "-p", provider, "-r", request]
        code, out, err = self.runner(argv, timeout)
        return self._parse(code, out, err, provider, request)

    def _parse(self, code: int, out: str, err: str, provider: str,
               request: str) -> GpsFix:
        text = (out or "").strip()
        if request == "updates":
            # Streaming mode: take the last complete JSON object seen.
            lines = [ln for ln in text.splitlines() if ln.strip().startswith("{")]
            text = lines[-1].strip() if lines else ""
        if not text:
            raise GpsError(
                "empty_response",
                "جی‌پی‌اس پاسخی نداد. جی‌پی‌اس گوشی روشن است؟ اجازه‌ی مکان داده شده؟ "
                "یک بار بیرون فضای بسته امتحان کنید.",
                code,
            )
        try:
            data = json.loads(text.splitlines()[0])
        except json.JSONDecodeError as exc:
            raise GpsError("bad_json", f"پاسخ جی‌پی‌اس خوانده نشد: {exc}", code) from exc

        if isinstance(data, dict) and data.get("error"):
            raise GpsError(self._classify(str(data["error"])), str(data["error"]), code)
        try:
            lat = float(data["latitude"])
            lon = float(data["longitude"])
        except (KeyError, TypeError, ValueError) as exc:
            raise GpsError("bad_payload", f"پاسخ جی‌پی‌اس latitude/longitude نداشت: {exc}",
                           code) from exc
        if lat == 0.0 and lon == 0.0:
            # Android's "no fix yet" sentinel. Pretending this is a location
            # would put the user in the Gulf of Guinea.
            raise GpsError(
                "no_fix",
                "جی‌پی‌اس هنوز قفل نشده (۰,۰ برگرداند). چند لحظه در فضای باز بمانید.",
                code,
            )

        fix = GpsFix(
            lat=lat,
            lon=lon,
            accuracy=_num(data.get("accuracy")),
            altitude=_num(data.get("altitude")),
            bearing=_num(data.get("bearing")),
            speed=_num(data.get("speed")),
            provider=str(data.get("provider") or provider),
            elapsed_ms=int(data["elapsedMs"]) if str(data.get("elapsedMs", "")).isdigit() else None,
            source=provider,
        )
        self.save(fix)
        return fix

    @staticmethod
    def _classify(message: str) -> str:
        low = message.lower()
        if "permission" in low or "allow" in low:
            return "permission_denied"
        if "disabled" in low or "off" in low:
            return "location_disabled"
        if "timeout" in low:
            return "timeout"
        if "not installed" in low or "not found" in low:
            return "termux_api_missing"
        return "provider_error"

    # ------------------------------------------------------------------- cache

    def save(self, fix: GpsFix) -> None:
        ensure_dirs()
        with self._lock:
            try:
                self.cache_path.parent.mkdir(parents=True, exist_ok=True)
                self.cache_path.write_text(
                    json.dumps(asdict(fix), ensure_ascii=False, indent=2),
                    encoding="utf-8",
                )
            except OSError:
                pass  # a read-only folder must not break location display

    def cached_fix(self, max_age_s: float | None = _USE_DEFAULT) -> GpsFix | None:
        """
        Last known fix.

        ``max_age_s`` omitted  -> use the instance default (6 h)
        ``max_age_s=None``     -> ignore age entirely (used by the status panel)
        ``max_age_s=60``       -> only if younger than 60 s
        """
        try:
            data = json.loads(self.cache_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return None
        try:
            fix = GpsFix(**{k: v for k, v in data.items() if k in GpsFix.__dataclass_fields__})
        except TypeError:
            return None
        limit = self.max_cache_age_s if max_age_s is _USE_DEFAULT else max_age_s
        if limit is not None and fix.age_seconds() > limit:
            return None
        fix.source = "cache"
        return fix

    def manual_fix(self, lat: float, lon: float, accuracy: float | None = None) -> GpsFix:
        """Fallback when hardware GPS is unavailable: the user types coordinates."""
        if not (-90.0 <= lat <= 90.0) or not (-180.0 <= lon <= 180.0):
            raise GpsError("out_of_range", "مختصات نامعتبر است.", 0)
        fix = GpsFix(lat=lat, lon=lon, accuracy=accuracy, provider="manual", source="manual")
        self.save(fix)
        return fix

    # ------------------------------------------------------------ resolution

    def resolve(self, provider: str = "gps", timeout: float = 25.0,
                allow_cache: bool = True) -> tuple[GpsFix, list[str]]:
        """
        Best-effort location with a fallback ladder and a log of what failed.

        Order: requested provider -> network provider -> recent cache. The
        `notes` list is shown to the user so a cached fix is never mistaken
        for a fresh one.
        """
        notes: list[str] = []
        attempts = [provider] + ([p for p in ("gps", "network") if p != provider])
        for provider in attempts:
            try:
                fix = self.fetch(provider=provider, timeout=timeout)
                notes.append(f"موقعیت تازه از {provider}")
                with self._lock:
                    self._live = fix
                return fix, notes
            except GpsError as exc:
                notes.append(f"{provider}: {exc.hint_fa if exc.reason != 'no_fix' else 'قفل نشد'}")
        if allow_cache:
            cached = self.cached_fix()
            if cached:
                notes.append(f"از حافظه: {cached.age_fa()}")
                return cached, notes
        raise GpsError(
            "no_location",
            "هیچ موقعیتی پیدا نشد. " + (notes[-1] if notes else INSTALL_HINT_FA),
        )

    # ----------------------------------------------------------------- watcher

    def start_watch(self, provider: str = "gps", interval_s: float = 15.0) -> bool:
        """
        Keep a background thread refreshing the fix.

        Uses repeated ``-r once`` calls rather than ``-r updates`` because the
        streaming form needs a long-lived pipe that Android kills aggressively;
        polling is boring and survives screen-off far better.
        """
        if self.is_watching():
            return True
        if not api_binary_available():
            return False
        self._watch_stop.clear()
        self._watch_errors = []

        def loop() -> None:
            while not self._watch_stop.is_set():
                try:
                    fix = self.fetch(provider=provider, request="once", timeout=25.0)
                    with self._lock:
                        self._live = fix
                except GpsError as exc:
                    self._watch_errors.append(f"{time.strftime('%H:%M:%S')} {exc.reason}")
                self._watch_stop.wait(interval_s)

        self._watcher = threading.Thread(target=loop, name="gps-watch", daemon=True)
        self._watcher.start()
        return True

    def stop_watch(self) -> None:
        self._watch_stop.set()
        self._watcher = None

    def is_watching(self) -> bool:
        return bool(self._watcher and self._watcher.is_alive())

    def live(self) -> Optional[GpsFix]:
        with self._lock:
            return self._live


def _num(value) -> float | None:
    try:
        return None if value is None else float(value)
    except (TypeError, ValueError):
        return None


_default: GpsProvider | None = None


def provider() -> GpsProvider:
    global _default
    if _default is None:
        _default = GpsProvider()
    return _default
