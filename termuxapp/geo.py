"""
Offline geodesy. Pure maths, no network, no tiles.

Everything here is computed from two coordinates on the phone, which is why
"navigate to a saved place" still works with zero internet: we can tell you the
straight-line distance, the compass heading and a rough ETA, but we cannot
draw turn-by-turn streets — that would need a map provider.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

EARTH_RADIUS_M = 6_371_008.8  # mean radius, IUGG

# Walking ~4.8 km/h, city driving ~28 km/h, cycling ~15 km/h.
SPEED_MPS = {"walk": 1.33, "bike": 4.17, "drive": 7.78}

# 16-point compass, Persian labels ordered clockwise from north.
COMPASS_FA = [
    "شمال",
    "شمال‌شرقی",
    "شرق",
    "جنوب‌شرقی",
    "جنوب",
    "جنوب‌غربی",
    "غرب",
    "شمال‌غربی",
]

PERSIAN_DIGITS = "۰۱۲۳۴۵۶۷۸۹"


def to_persian_digits(text: str) -> str:
    return str(text).translate(str.maketrans("0123456789", PERSIAN_DIGITS))


def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance in metres."""
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlmb = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlmb / 2) ** 2
    return 2 * EARTH_RADIUS_M * math.asin(min(1.0, math.sqrt(a)))


def initial_bearing(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Forward azimuth in degrees, 0 = north, clockwise."""
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dlmb = math.radians(lon2 - lon1)
    y = math.sin(dlmb) * math.cos(p2)
    x = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dlmb)
    return (math.degrees(math.atan2(y, x)) + 360.0) % 360.0


def compass_fa(bearing: float) -> str:
    """Map a bearing onto the 8 Persian cardinal/ordinal names."""
    idx = int(((bearing % 360.0) + 22.5) // 45) % 8
    return COMPASS_FA[idx]


def compass_index8(bearing: float) -> int:
    return int(((bearing % 360.0) + 22.5) // 45) % 8


@dataclass(frozen=True)
class RouteLeg:
    """A straight-line leg from the current fix to a saved place."""

    metres: float
    bearing: float
    compass: str
    eta_seconds: dict[str, int]

    @property
    def distance_fa(self) -> str:
        if self.metres < 950:
            return f"{to_persian_digits(int(round(self.metres / 10.0) * 10))} متر"
        return f"{to_persian_digits(round(self.metres / 1000.0, 1))} کیلومتر"

    def eta_fa(self, mode: str = "walk") -> str:
        seconds = self.eta_seconds.get(mode, 0)
        if seconds < 60:
            # Rounding 40 s up to «۱ دقیقه» would overstate the trip; anything
            # under a minute is reported as such.
            return "کمتر از یک دقیقه"
        minutes = int(round(seconds / 60.0))
        if minutes < 60:
            return f"{to_persian_digits(minutes)} دقیقه"
        hours, mins = divmod(minutes, 60)
        if mins == 0:
            return f"{to_persian_digits(hours)} ساعت"
        return f"{to_persian_digits(hours)} ساعت و {to_persian_digits(mins)} دقیقه"


def plan_route(
    from_lat: float,
    from_lon: float,
    to_lat: float,
    to_lon: float,
) -> RouteLeg:
    metres = haversine_m(from_lat, from_lon, to_lat, to_lon)
    bearing = initial_bearing(from_lat, from_lon, to_lat, to_lon)
    return RouteLeg(
        metres=metres,
        bearing=bearing,
        compass=compass_fa(bearing),
        eta_seconds={mode: int(metres / mps) for mode, mps in SPEED_MPS.items()},
    )


def format_dms(value: float, axis: str) -> str:
    """35.6892, 'lat' -> 35°41′21″N (used for copy/paste into any map app)."""
    hemi = ("N" if value >= 0 else "S") if axis == "lat" else ("E" if value >= 0 else "W")
    value = abs(value)
    deg = int(value)
    minutes_full = (value - deg) * 60
    minutes = int(minutes_full)
    seconds = (minutes_full - minutes) * 60
    return f"{deg}\u00b0{minutes:02d}\u2032{seconds:04.1f}\u2033{hemi}"


def maps_url(lat: float, lon: float, label: str = "") -> str:
    """
    A link the phone can open in whatever map app is installed.

    This is the one deliberate external hand-off: we never fetch a map
    ourselves, we only hand the coordinates to an app the user already has.
    """
    q = f"{lat:.6f},{lon:.6f}"
    base = f"https://www.google.com/maps/dir/?api=1&destination={q}"
    return f"{base}&destination_place_id=&travelmode=walking" if not label else base


def accuracy_verdict(accuracy_m: float | None) -> tuple[str, str]:
    """
    Honest GPS quality label. Termux/Android accuracy is a 68% confidence
    radius in metres; indoors on a phone it is routinely 20-40 m.
    """
    if accuracy_m is None:
        return "unknown", "دقت نامشخص"
    if accuracy_m <= 10:
        return "excellent", f"دقت عالی ({to_persian_digits(int(round(accuracy_m)))} متر)"
    if accuracy_m <= 25:
        return "good", f"دقت خوب ({to_persian_digits(int(round(accuracy_m)))} متر)"
    if accuracy_m <= 60:
        return "fair", f"دقت متوسط ({to_persian_digits(int(round(accuracy_m)))} متر) — بهتر است کنار پنجره یا فضای باز باشید"
    return "poor", f"دقت ضعیف ({to_persian_digits(int(round(accuracy_m)))} متر) — این نقطه ممکن است ده‌ها متر خطا داشته باشد"
