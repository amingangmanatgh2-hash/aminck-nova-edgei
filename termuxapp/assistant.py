"""
The offline assistant: intents + retrieval + dialogue state, no network.

Design rules this file obeys:

* Never invent data. If there is no GPS fix, no saved place, or no live server
  connection, the reply says so and offers the next real action.
* Every answer carries a confidence and, when confidence is middling, the
  alternatives it beat — so a wrong guess is one tap away from being right.
* Unknown input is answered with «نمی‌دانم» plus the closest matches, not with
  a confident-sounding fabrication.
"""

from __future__ import annotations

import json
import re
import subprocess
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path

from . import fuzzy
from .geo import maps_url, plan_route, to_persian_digits
from .gps import GpsError, GpsFix, GpsProvider
from .intents import classify
from .knowledge import KnowledgeBase
from .normalize import normalize
from .paths import CATALOG_PATH, MEMORY_DIR, ROOT, ensure_dirs
from .places import Place, PlaceStore

HERE_WORDS = frozenset({
    "اینجا", "این جا", "این مکان", "این موقعیت",
    "مکان من", "موقعیت من", "لوکیشن من", "جای من",
    "مکان", "موقعیت", "لوکیشن", "جا", "نقطه",
})

HELP_FA = """این دستیار کاملاً آفلاین است و همه‌چیز را از همین پوشه می‌خواند.

مکان:
• «اینجا رو سیو کن به اسم خونه»
• «برم خونه» / «مسیر محل کار»
• «فاصله تا باشگاه چقدره»
• «مکان‌های ذخیره شده»
• «کجام؟»
• «نزدیک‌ترین مکان»
• «خونه رو پاک کن»

پرسش:
• هر سؤال دیگری بپرسی از پایگاه دانش همین پوشه جواب می‌دهم: رنک‌ها،
  قیمت‌ها، تخفیف، ضد تقلب، گیم‌مودها، وضعیت سرور.

نکته: برای جی‌پی‌اس باید افزونه‌ی Termux:API نصب باشد."""


@dataclass
class Reply:
    text: str
    intent: str = "unknown"
    confidence: float = 0.0
    kind: str = "info"          # info | action | question | error | not_found
    data: dict = field(default_factory=dict)
    suggestions: list[str] = field(default_factory=list)
    sources: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return asdict(self)


class Assistant:
    def __init__(
        self,
        places: PlaceStore | None = None,
        gps: GpsProvider | None = None,
        kb: KnowledgeBase | None = None,
        memory_dir: Path | None = None,
        catalog_path: Path | None = None,
    ) -> None:
        ensure_dirs()
        self.places = places or PlaceStore()
        self.gps = gps or GpsProvider()
        self.kb = kb if kb is not None else KnowledgeBase()
        self.memory_dir = memory_dir or MEMORY_DIR
        self.state_path = self.memory_dir / "dialogue.json"
        # Derived from memory_dir so a test (or a second profile) cannot read
        # or write another instance's feedback history.
        self.feedback_path = self.memory_dir / "feedback.jsonl"
        self.queries_path = self.memory_dir / "queries.jsonl"
        self.catalog_path = catalog_path or CATALOG_PATH
        self.state = self._load_state()
        self._feedback = self._load_feedback()

    # ------------------------------------------------------------- state mgmt

    def _load_feedback(self) -> dict[str, int]:
        scores: dict[str, int] = {}
        try:
            for line in self.feedback_path.read_text(encoding="utf-8").splitlines():
                rec = json.loads(line)
                key = rec.get("key", "")
                if key:
                    scores[key] = scores.get(key, 0) + int(rec.get("delta", 0))
        except (OSError, json.JSONDecodeError):
            pass
        return scores

    def _load_state(self) -> dict:
        try:
            return json.loads(self.state_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return {}

    def _save_state(self) -> None:
        self.memory_dir.mkdir(parents=True, exist_ok=True)
        try:
            self.state_path.write_text(
                json.dumps(self.state, ensure_ascii=False, indent=2), encoding="utf-8"
            )
        except OSError:
            pass

    def reset(self) -> None:
        self.state = {}
        self._save_state()

    def _log(self, path: Path, record: dict) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        try:
            with path.open("a", encoding="utf-8") as fh:
                fh.write(json.dumps(record, ensure_ascii=False) + "\n")
        except OSError:
            pass

    def feedback(self, query: str, answer_key: str, positive: bool) -> None:
        delta = 1 if positive else -1
        key = f"{answer_key}"
        self._feedback[key] = self._feedback.get(key, 0) + delta
        self._log(self.feedback_path, {"t": time.time(), "q": query, "key": key, "delta": delta})

    # ------------------------------------------------------------------- main

    def ask(self, text: str) -> Reply:
        text = (text or "").strip()
        if not text:
            return Reply(HELP_FA, intent="help", kind="info", confidence=1.0)

        self.state["turns"] = int(self.state.get("turns", 0)) + 1
        matches = classify(text)
        pending = self.state.get("pending")

        # A pending question outranks the classifier: after «اینجا رو سیو کن»
        # with no name, the next message *is* the name, not a new intent.
        if pending and not matches:
            reply = self._handle_pending(pending, text)
        elif matches:
            reply = self._dispatch(matches[0], matches[1:3], text)
        elif pending:
            reply = self._handle_pending(pending, text)
        else:
            reply = self._fallback(text)

        self.state["last_intent"] = reply.intent
        if reply.data.get("place_name"):
            self.state["last_place"] = reply.data["place_name"]
        self._save_state()
        self._log(self.queries_path, {
            "t": time.time(), "q": text, "intent": reply.intent,
            "confidence": reply.confidence, "kind": reply.kind,
        })
        return reply

    # -------------------------------------------------------------- dispatch

    def _dispatch(self, top, alternates, raw: str) -> Reply:
        handler = getattr(self, f"_i_{top.intent}", None)
        if handler is None:
            return self._fallback(raw)
        reply = handler(top, raw)
        if reply.intent == "unknown":
            return self._fallback(raw)
        if not reply.suggestions:
            reply.suggestions = self._suggestions_for(top.intent)
        return reply

    @staticmethod
    def _suggestions_for(intent: str) -> list[str]:
        return {
            "save_place": ["مکان‌های ذخیره شده", "کجام؟"],
            "navigate": ["مکان‌های ذخیره شده", "نزدیک‌ترین مکان"],
            "list_places": ["کجام؟", "اینجا رو سیو کن به اسم …"],
            "where_am_i": ["مکان‌های ذخیره شده", "وضعیت جی‌پی‌اس"],
            "distance": ["برم همونجا", "نزدیک‌ترین مکان"],
            "unknown": ["مکان‌های ذخیره شده", "کمک"],
        }.get(intent, ["مکان‌های ذخیره شده", "کمک"])

    def _handle_pending(self, pending: dict, text: str) -> Reply:
        """
        Resume an interrupted action. The pending dict is passed through rather
        than re-read from state, because it is cleared here — an earlier version
        popped it and then tried to read the name back out of `self.state`,
        which always came back empty.
        """
        action = pending.get("action")
        self.state.pop("pending", None)
        if action == "ask_place_name":
            return self._i_save_place_named(text)
        if action == "ask_manual_coords":
            return self._i_manual_coords(text, pending.get("name", ""))
        if action == "ask_place_name_delete":
            return self._i_delete_place_named(text)
        return Reply("متوجه نشدم؛ دوباره بگو.", kind="question", confidence=0.2)

    # ------------------------------------------------------------ place ops

    def _current_fix(self) -> tuple[GpsFix | None, list[str]]:
        live = self.gps.live()
        if live and live.age_seconds() < 120:
            return live, ["موقعیت زنده"]
        try:
            return self.gps.resolve()
        except GpsError as exc:
            return None, [exc.hint_fa]

    def _i_save_place(self, match, raw: str) -> Reply:
        name = match.slots.get("name", "")
        # «اینجا را ذخیره کن» captures «اینجا» as the slot. That is a
        # demonstrative, not a name — saving a place literally called «اینجا»
        # would be worse than asking.
        if normalize(name) in HERE_WORDS:
            name = ""
        if not name:
            self.state["pending"] = {"action": "ask_place_name"}
            self._save_state()
            return Reply(
                "باشه، اسمش رو بگو. مثلاً: «خونه» یا «محل کار».",
                intent="save_place", confidence=0.7, kind="question",
            )
        return self._i_save_place_named(name)

    def _i_save_place_named(self, name: str) -> Reply:
        name = (name or "").strip(" .،!?؟")
        if not name or len(name) > 60:
            return Reply("اسم نامعتبر است؛ یک اسم کوتاه بگو.",
                         intent="save_place", kind="question", confidence=0.2)
        fix, notes = self._current_fix()
        if fix is None:
            self.state["pending"] = {"action": "ask_manual_coords", "name": name}
            self._save_state()
            return Reply(
                f"جی‌پی‌اس در دسترس نیست، پس نمی‌توانم «{name}» را از موقعیت فعلی ذخیره کنم.\n"
                + (notes[0] if notes else "")
                + "\n\nاگر مختصات را داری بفرست تا دستی ذخیره کنم، مثلاً: 35.6997 51.3379",
                intent="save_place", kind="error", confidence=0.8,
                data={"name": name, "notes": notes},
                suggestions=["وضعیت جی‌پی‌اس"],
            )
        place, created = self.places.save(
            name, fix.lat, fix.lon, accuracy=fix.accuracy,
            note=f"source={fix.source}",
        )
        self.places.record_track_point(fix.lat, fix.lon, fix.accuracy)
        quality, quality_fa = fix.quality()
        verb = "ذخیره شد" if created else "به‌روزرسانی شد"
        return Reply(
            f"✅ «{place.name}» {verb}.\n"
            f"مختصات: {to_persian_digits(round(place.lat, 6))}, "
            f"{to_persian_digits(round(place.lon, 6))}\n"
            f"{quality_fa} • منبع: {fix.source} • {fix.age_fa()}\n"
            f"از این به بعد بگو «برم {place.name}».",
            intent="save_place", confidence=0.95, kind="action",
            data={"place": place.to_dict(), "place_name": place.name,
                  "created": created, "notes": notes},
            suggestions=[f"برم {place.name}", "مکان‌های ذخیره شده"],
        )

    def _i_manual_coords(self, text: str, name: str = "") -> Reply:
        name = (name or "").strip(" .،!?؟")
        nums = re.findall(r"-?\d+\.?\d*", text.replace("،", "."))
        if len(nums) < 2 or not name:
            return Reply("دو عدد لازم دارم، مثلاً: 35.6997 51.3379",
                         intent="save_place", kind="question", confidence=0.3)
        lat, lon = float(nums[0]), float(nums[1])
        try:
            fix = self.gps.manual_fix(lat, lon)
        except GpsError as exc:
            return Reply(exc.hint_fa, intent="save_place", kind="error", confidence=0.9)
        place, created = self.places.save(name, fix.lat, fix.lon, note="manual")
        return Reply(
            f"✅ «{place.name}» دستی ذخیره شد ({to_persian_digits(round(lat, 6))}, "
            f"{to_persian_digits(round(lon, 6))}).\nدقت: دستی — خودت وارد کردی.",
            intent="save_place", kind="action", confidence=0.9,
            data={"place": place.to_dict(), "place_name": place.name, "created": created},
            suggestions=[f"برم {place.name}"],
        )

    def _resolve_destination(self, text: str) -> Place | None:
        target = text.strip()
        if normalize(target) in ("همونجا", "همانجا", "همون", "همان", "همون مکان"):
            last = self.state.get("last_place")
            if last:
                return self.places.get(last)
        return self.places.get(target)

    def _i_navigate(self, match, raw: str) -> Reply:
        dest = match.slots.get("destination", "")
        if not dest:
            return Reply("به کجا؟ مثلاً بگو «برم خونه».", intent="navigate",
                         kind="question", confidence=0.4)
        place = self._resolve_destination(dest)
        if place is None:
            sugg = self.places.suggest_names(dest)
            if not self.places.all():
                return Reply(
                    "هنوز هیچ مکانی ذخیره نکرده‌ای. اول جایی که هستی را ذخیره کن:\n"
                    "«اینجا رو سیو کن به اسم خونه»",
                    intent="navigate", kind="not_found", confidence=0.9,
                    suggestions=["اینجا رو سیو کن به اسم خونه"],
                )
            lines = "\n".join(f"• {s}" for s in sugg) or "• —"
            return Reply(
                f"مکانی به اسم «{dest}» پیدا نکردم. شاید منظورت این بود:\n{lines}",
                intent="navigate", kind="not_found", confidence=0.75,
                data={"query": dest, "candidates": sugg},
                suggestions=sugg or ["مکان‌های ذخیره شده"],
            )
        self.places.touch(place.name)
        fix, notes = self._current_fix()
        link = maps_url(place.lat, place.lon)
        if fix is None:
            return Reply(
                f"«{place.name}» ذخیره داری:\n"
                f"مختصات: {to_persian_digits(round(place.lat, 6))}, "
                f"{to_persian_digits(round(place.lon, 6))}\n"
                f"نقشه: {link}\n\n"
                f"ولی موقعیت فعلی‌ات را ندارم، پس جهت و فاصله را نمی‌توانم بگویم.\n{notes[0]}",
                intent="navigate", confidence=0.7, kind="error",
                data={"place": place.to_dict(), "place_name": place.name,
                      "maps": link, "notes": notes},
                suggestions=["وضعیت جی‌پی‌اس", "مکان‌های ذخیره شده"],
            )
        leg = plan_route(fix.lat, fix.lon, place.lat, place.lon)
        return Reply(
            f"🧭 به سمت «{place.name}»\n"
            f"جهت: {leg.compass} ({to_persian_digits(int(round(leg.bearing)))}°)\n"
            f"فاصله‌ی مستقیم: {leg.distance_fa}\n"
            f"تخمین: پیاده {leg.eta_fa('walk')} • دوچرخه {leg.eta_fa('bike')} • "
            f"ماشین {leg.eta_fa('drive')}\n"
            f"نقشه: {link}\n\n"
            f"(فاصله خط مستقیم است، نه مسیر خیابان — نقشه‌ی آفلاین نداریم.)",
            intent="navigate", confidence=0.93, kind="action",
            data={"place": place.to_dict(), "place_name": place.name,
                  "leg": {"metres": round(leg.metres, 1), "bearing": round(leg.bearing, 1),
                          "compass": leg.compass, "eta": leg.eta_seconds},
                  "maps": link},
            suggestions=["نزدیک‌ترین مکان", "مکان‌های ذخیره شده"],
        )

    def _i_delete_place(self, match, raw: str) -> Reply:
        name = match.slots.get("name", "")
        if not name:
            self.state["pending"] = {"action": "ask_place_name_delete"}
            self._save_state()
            return Reply("کدام مکان را پاک کنم؟", intent="delete_place",
                         kind="question", confidence=0.5)
        return self._i_delete_place_named(name)

    def _i_delete_place_named(self, name: str) -> Reply:
        place = self.places.get(name)
        if place is None:
            return Reply(f"مکانی به اسم «{name}» ندارم.", intent="delete_place",
                         kind="not_found", confidence=0.8,
                         suggestions=self.places.suggest_names(name))
        self.places.delete(place.name)
        return Reply(f"🗑 «{place.name}» پاک شد.", intent="delete_place",
                     kind="action", confidence=0.95,
                     data={"place_name": place.name},
                     suggestions=["مکان‌های ذخیره شده"])

    def _i_list_places(self, match, raw: str) -> Reply:
        places = self.places.all()
        if not places:
            return Reply(
                "هنوز مکانی ذخیره نشده. برو جایی که می‌خواهی نگه داری و بگو:\n"
                "«اینجا رو سیو کن به اسم خونه»",
                intent="list_places", kind="not_found", confidence=0.95,
                suggestions=["اینجا رو سیو کن به اسم خونه"],
            )
        lines = []
        for p in places:
            alias = f" ({'، '.join(p.aliases)})" if p.aliases else ""
            visits = f" • {to_persian_digits(p.visits)} بار" if p.visits else ""
            lines.append(
                f"• {p.name}{alias} — {to_persian_digits(round(p.lat, 5))}, "
                f"{to_persian_digits(round(p.lon, 5))}{visits}"
            )
        return Reply(
            f"{to_persian_digits(len(places))} مکان ذخیره شده:\n" + "\n".join(lines),
            intent="list_places", confidence=0.97, kind="info",
            data={"places": [p.to_dict() for p in places], "count": len(places)},
            suggestions=[f"برم {places[0].name}"],
        )

    def _i_where_am_i(self, match, raw: str) -> Reply:
        fix, notes = self._current_fix()
        if fix is None:
            return Reply(
                "موقعیتت را نمی‌دانم.\n" + (notes[0] if notes else ""),
                intent="where_am_i", kind="error", confidence=0.9,
                data={"notes": notes}, suggestions=["وضعیت جی‌پی‌اس"],
            )
        quality, quality_fa = fix.quality()
        nearby = self.places.nearest(fix.lat, fix.lon, limit=1)
        near_txt = ""
        if nearby:
            p, metres = nearby[0]
            near_txt = f"\nنزدیک‌ترین مکان ذخیره‌شده: {p.name} " \
                       f"({to_persian_digits(int(round(metres)))} متر)"
        return Reply(
            f"📍 تو اینجایی:\n"
            f"{to_persian_digits(round(fix.lat, 6))}, {to_persian_digits(round(fix.lon, 6))}\n"
            f"{quality_fa} • منبع: {fix.source} • {fix.age_fa()}{near_txt}\n"
            f"نقشه: {maps_url(fix.lat, fix.lon)}",
            intent="where_am_i", confidence=0.94, kind="info",
            data={"fix": fix.to_dict(), "quality": quality,
                  "maps": maps_url(fix.lat, fix.lon)},
            suggestions=["اینجا رو سیو کن به اسم …", "نزدیک‌ترین مکان"],
        )

    def _i_distance(self, match, raw: str) -> Reply:
        dest = match.slots.get("destination", "")
        place = self._resolve_destination(dest) if dest else None
        if place is None:
            return Reply(
                f"«{dest}» را در مکان‌های ذخیره‌شده پیدا نکردم.",
                intent="distance", kind="not_found", confidence=0.7,
                suggestions=self.places.suggest_names(dest) or ["مکان‌های ذخیره شده"],
            )
        fix, notes = self._current_fix()
        if fix is None:
            return Reply("موقعیت فعلی‌ات را ندارم، پس فاصله را نمی‌توانم حساب کنم.\n"
                         + (notes[0] if notes else ""),
                         intent="distance", kind="error", confidence=0.7,
                         suggestions=["وضعیت جی‌پی‌اس"])
        leg = plan_route(fix.lat, fix.lon, place.lat, place.lon)
        return Reply(
            f"تا «{place.name}» {leg.distance_fa} است ({leg.compass}). "
            f"پیاده حدود {leg.eta_fa('walk')}.",
            intent="distance", confidence=0.93, kind="info",
            data={"place": place.to_dict(), "place_name": place.name,
                  "metres": round(leg.metres, 1)},
            suggestions=[f"برم {place.name}"],
        )

    def _i_nearest_place(self, match, raw: str) -> Reply:
        fix, notes = self._current_fix()
        if fix is None:
            return Reply("بدون موقعیت فعلی نمی‌توانم بگویم کدام نزدیک‌تر است.\n"
                         + (notes[0] if notes else ""),
                         intent="nearest_place", kind="error", confidence=0.7,
                         suggestions=["وضعیت جی‌پی‌اس"])
        near = self.places.nearest(fix.lat, fix.lon, limit=3)
        if not near:
            return Reply("هنوز مکانی ذخیره نکرده‌ای.", intent="nearest_place",
                         kind="not_found", confidence=0.9,
                         suggestions=["اینجا رو سیو کن به اسم خونه"])
        lines = [
            f"• {p.name} — {to_persian_digits(int(round(m)))} متر" for p, m in near
        ]
        return Reply(
            "نزدیک‌ترین مکان‌های ذخیره‌شده:\n" + "\n".join(lines),
            intent="nearest_place", confidence=0.93, kind="info",
            data={"nearest": [{"name": p.name, "metres": round(m, 1)} for p, m in near]},
            suggestions=[f"برم {near[0][0].name}"],
        )

    def _i_gps_status(self, match, raw: str) -> Reply:
        st = self.gps.status()
        termux = "بله، ترموکس است" if st["is_termux"] else "این محیط ترموکس نیست"
        api = "نصب است" if st["termux_api_installed"] else "نصب نیست"
        cached = st["cached_fix"]
        cached_txt = (
            f"\nآخرین موقعیت کش‌شده: {to_persian_digits(round(cached['lat'], 6))}, "
            f"{to_persian_digits(round(cached['lon'], 6))}"
            if cached else "\nموقعیت کش‌شده‌ای ندارم"
        )
        return Reply(
            f"🛰 وضعیت جی‌پی‌اس\nترموکس: {termux}\nTermux:API: {api}{cached_txt}\n"
            + (st["hint_fa"] or "جی‌پی‌اس آماده است؛ بگو «کجام؟»."),
            intent="gps_status", confidence=0.9, kind="info", data=st,
            suggestions=["کجام؟", "اینجا رو سیو کن به اسم خونه"],
        )

    def _i_track(self, match, raw: str) -> Reply:
        if "پاک" in normalize(raw) or "حذف" in normalize(raw):
            n = self.places.clear_track()
            return Reply(f"{to_persian_digits(n)} نقطه‌ی مسیر پاک شد.",
                         intent="track", kind="action", confidence=0.9)
        track = self.places.track(limit=50)
        if not track:
            return Reply("هنوز نقطه‌ای ثبت نشده. هر بار که «کجام؟» یا «سیو کن» "
                         "بگویی یک نقطه ثبت می‌شود.", intent="track",
                         kind="not_found", confidence=0.9)
        first, last = track[0], track[-1]
        from .geo import haversine_m

        span = haversine_m(first["lat"], first["lon"], last["lat"], last["lon"])
        return Reply(
            f"{to_persian_digits(len(track))} نقطه‌ی مسیر ثبت شده. "
            f"فاصله‌ی خطی ابتدا تا انتها: {to_persian_digits(int(round(span)))} متر.",
            intent="track", kind="info", confidence=0.85,
            data={"points": len(track), "metres": round(span, 1)},
            suggestions=["مسیر طی شده رو پاک کن"],
        )

    def _i_set_alias(self, match, raw: str) -> Reply:
        name = match.slots.get("name", "")
        alias = match.slots.get("alias", "")
        if not name or not alias:
            return Reply("نتوانستم بفهمم برای کدام مکان و با چه نام دیگری.",
                         intent="set_alias", kind="question", confidence=0.3)
        if not self.places.add_alias(name, alias):
            return Reply(f"مکان «{name}» پیدا نشد.", intent="set_alias",
                         kind="not_found", confidence=0.7,
                         suggestions=self.places.suggest_names(name))
        place = self.places.get(name)
        return Reply(
            f"✅ «{alias}» به عنوان نام دیگر «{place.name if place else name}» ثبت شد.",
            intent="set_alias", kind="action", confidence=0.9,
            data={"place_name": name, "alias": alias},
        )

    # ----------------------------------------------------------- misc/system

    def _i_time(self, match, raw: str) -> Reply:
        now = time.localtime()
        return Reply(
            f"🕒 {to_persian_digits(time.strftime('%H:%M:%S', now))} — "
            f"{to_persian_digits(time.strftime('%Y/%m/%d', now))} (ساعت گوشی، منطقه‌ی زمانی محلی)",
            intent="time", kind="info", confidence=0.95,
        )

    def _i_battery(self, match, raw: str) -> Reply:
        try:
            proc = subprocess.run(["termux-battery-status"], capture_output=True,
                                  text=True, timeout=8, check=False)
            data = json.loads(proc.stdout)
        except Exception:
            return Reply(
                "برای خواندن باتری هم Termux:API لازم است (termux-battery-status).",
                intent="battery", kind="error", confidence=0.8,
            )
        pct = data.get("percentage")
        pct_txt = f"{to_persian_digits(int(pct * 100))}٪" if isinstance(pct, float) else str(pct)
        return Reply(
            f"🔋 {pct_txt} — وضعیت: {data.get('status', '?')} • منبع: {data.get('plugged', '?')}",
            intent="battery", kind="info", confidence=0.9, data=data,
        )

    def _i_files(self, match, raw: str) -> Reply:
        entries = sorted(p for p in ROOT.iterdir() if not p.name.startswith("."))
        dirs = [p.name for p in entries if p.is_dir()]
        files = [p.name for p in entries if p.is_file()]
        return Reply(
            f"پوشه‌ی پروژه {to_persian_digits(len(entries))} قلم دارد.\n"
            f"پوشه‌ها: {', '.join(dirs) or '—'}\nفایل‌ها: {', '.join(files) or '—'}\n"
            f"برای دیدن همه‌چیز در مرورگر: /fs/",
            intent="files", kind="info", confidence=0.9,
            data={"dirs": dirs, "files": files},
        )

    def _i_greeting(self, match, raw: str) -> Reply:
        n = len(self.places.all())
        return Reply(
            f"سلام! 👋 آفلاین و آماده‌ام. {to_persian_digits(n)} مکان ذخیره‌شده داری.\n"
            "می‌توانی جایی که هستی را سیو کنی یا سؤال بپرسی.",
            intent="greeting", kind="info", confidence=0.9,
            suggestions=["کجام؟", "مکان‌های ذخیره شده", "کمک"],
        )

    def _i_thanks(self, match, raw: str) -> Reply:
        return Reply("قربانت! 🙂 کار دیگری داری؟", intent="thanks",
                     kind="info", confidence=0.9,
                     suggestions=["مکان‌های ذخیره شده", "کمک"])

    def _i_help(self, match, raw: str) -> Reply:
        return Reply(HELP_FA, intent="help", kind="info", confidence=0.95)

    def _i_confirm_yes(self, match, raw: str) -> Reply:
        pending = self.state.get("pending")
        if pending:
            return self._handle_pending(pending, raw)
        return Reply("چیزی در انتظار تایید نیست. چه کاری انجام دهم؟",
                     intent="confirm_yes", kind="question", confidence=0.4)

    def _i_confirm_no(self, match, raw: str) -> Reply:
        self.state.pop("pending", None)
        self._save_state()
        return Reply("باشه، لغو شد.", intent="confirm_no", kind="info", confidence=0.9)

    # ------------------------------------------------------ platform intents

    def _catalog(self) -> list[dict]:
        try:
            data = json.loads(self.catalog_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return []
        return data.get("products", []) if isinstance(data, dict) else []

    def _i_server_status(self, match, raw: str) -> Reply:
        return Reply(
            "سرور ماینکرفت روی کلودفلر میزبانی می‌شود و این دستیار آفلاین است، "
            "پس وضعیت *زنده* را نمی‌توانم بگیرم.\n"
            "برای وضعیت واقعی: صفحه‌ی `/api/servers` روی دامنه‌ی خودت، یا بخش "
            "«سرور» در همین وب‌اپ وقتی اینترنت داری.\n"
            "این یک محدودیت واقعی است، نه باگ.",
            intent="server_status", kind="info", confidence=0.8,
            sources=["docs/FEASIBILITY.md"],
            suggestions=["گیم‌مودها", "رنک‌ها"],
        )

    def _i_gamemodes(self, match, raw: str) -> Reply:
        return self._kb_or_catalog(raw, "gamemodes", "گیم‌مودها")

    def _i_shop(self, match, raw: str) -> Reply:
        products = self._catalog()
        if not products:
            return self._kb_or_catalog(raw, "shop", "فروشگاه")
        kinds: dict[str, list[dict]] = {}
        for p in products:
            kinds.setdefault(p.get("kind", "?"), []).append(p)
        lines = []
        for kind, items in kinds.items():
            lines.append(f"▸ {kind} ({to_persian_digits(len(items))})")
            for item in items[:4]:
                price = item.get("price_usd", 0)
                lines.append(
                    f"   • {item.get('title_fa', item.get('sku'))} — "
                    f"{to_persian_digits(f'${price / 100:.2f}')}"
                )
            if len(items) > 4:
                lines.append(f"   … و {to_persian_digits(len(items) - 4)} مورد دیگر")
        return Reply(
            f"🛒 {to_persian_digits(len(products))} محصول در کاتالوگ (قیمت به دلار):\n"
            + "\n".join(lines)
            + "\n\n(قیمت نهایی با موتور تخفیف روی سرور حساب می‌شود.)",
            intent="shop", kind="info", confidence=0.88,
            data={"count": len(products), "products": products[:20]},
            sources=["data/catalog.json"],
            suggestions=["رنک‌ها", "تخفیف"],
        )

    def _i_rank(self, match, raw: str) -> Reply:
        return self._kb_or_catalog(raw, "rank", "رنک‌ها")

    def _i_price(self, match, raw: str) -> Reply:
        products = self._catalog()
        if not products:
            return self._kb_or_catalog(raw, "price", "قیمت‌ها")
        words = [w for w in normalize(raw).split() if len(w) > 1]
        best, best_s = None, 0.0
        for product in products:
            title_tokens = [
                tok for tok in normalize(product.get("title_fa", "")).split() if len(tok) > 1
            ]
            if not title_tokens:
                continue
            # Fraction of the product's own title that the question covers.
            # Scoring a single word against a long title string always came
            # out near zero, so nothing ever matched.
            hits = sum(
                1 for tok in title_tokens
                if any(fuzzy.combined(tok, w) >= 0.75 for w in words)
            )
            score = hits / len(title_tokens)
            if score > best_s:
                best, best_s = product, score
        if best is None or best_s < 0.5:
            return self._i_shop(match, raw)
        price = best.get("price_usd", 0)
        return Reply(
            f"«{best.get('title_fa', best.get('sku'))}» — "
            f"{to_persian_digits(f'${price / 100:.2f}')}",
            intent="price", kind="info", confidence=0.8,
            data={"product": best}, sources=["data/catalog.json"],
        )

    def _i_discount(self, match, raw: str) -> Reply:
        return self._kb_or_catalog(raw, "discount", "تخفیف")

    def _i_anticheat(self, match, raw: str) -> Reply:
        return self._kb_or_catalog(raw, "anticheat", "ضد تقلب")

    def _i_referral(self, match, raw: str) -> Reply:
        return self._kb_or_catalog(raw, "referral", "دعوت دوستان")

    # ---------------------------------------------------------------- fallback

    def _kb_or_catalog(self, raw: str, intent: str, topic: str) -> Reply:
        results = self.kb.search(raw, limit=3)
        if not results:
            return Reply(
                f"در پایگاه دانش آفلاین چیزی درباره‌ی «{topic}» ندارم.",
                intent=intent, kind="not_found", confidence=0.4,
                suggestions=["کمک"],
            )
        entry, score = results[0]
        boost = self._feedback.get(entry.id, 0) * 0.02
        alts = [e.title for e, _ in results[1:]]
        return Reply(
            entry.best_answer(),
            intent=intent, kind="info", confidence=round(min(0.9, score * 0.25 + boost), 4),
            data={"entry_id": entry.id, "score": score},
            suggestions=alts[:3], sources=[f"data/knowledge/{entry.source}"],
        )

    def _fallback(self, raw: str) -> Reply:
        results = self.kb.search(raw, limit=3)
        if results:
            entry, score = results[0]
            boost = self._feedback.get(entry.id, 0) * 0.02
            adj = score * 0.25 + boost
            if adj >= 0.30:
                alts = [e.title for e, _ in results[1:]]
                hedge = "" if adj >= 0.55 else "\n\n(مطمئن نیستم منظورت این بود.)"
                return Reply(
                    entry.best_answer() + hedge,
                    intent="kb", kind="info", confidence=round(min(adj, 0.95), 4),
                    data={"entry_id": entry.id, "score": round(score, 4)},
                    suggestions=alts[:3], sources=[f"data/knowledge/{entry.source}"],
                )
        places = self.places.find(raw, limit=3, floor=0.35)
        if places:
            return Reply(
                f"منظورت مکان «{places[0].name}» بود؟",
                intent="unknown", kind="question", confidence=0.45,
                data={"candidates": [p.name for p in places]},
                suggestions=[f"برم {places[0].name}"]
                + [f"برم {p.name}" for p in places[1:3]],
            )
        return Reply(
            "نمی‌دانم. 🤷 این دستیار آفلاین است و فقط از پایگاه دانش همین پوشه "
            "و مکان‌های ذخیره‌شده جواب می‌دهد؛ چیزی از خودش نمی‌سازد.\n"
            "«کمک» را بگو تا ببینی چه کارهایی بلدم.",
            intent="unknown", kind="not_found", confidence=0.1,
            suggestions=["کمک", "مکان‌های ذخیره شده"],
        )
