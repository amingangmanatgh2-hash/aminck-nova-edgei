"""
Intent recognition for Persian, rule-based and fully offline.

Each rule is a list of regexes run over the *expanded* normalised text (see
``normalize.colloquial``), so «برم خونه» and «بروم به خانه» hit the same rule.
Rules are declarative on purpose: adding a phrase is a one-line data change,
not a parser change, which is how this stays maintainable without a model.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from .normalize import colloquial, compact, normalize

# Greedy, bounded. A lazy quantifier here captured exactly one character
# whenever the slot sat at the end of a pattern, because nothing forced it to
# grow. Greedy + backtracking gives the longest match the rest can still use.
_PLACE_NAME = r"(?P<name>[\w\u0600-\u06ff][\w\u0600-\u06ff\s]{0,40})"
_DEST = r"(?P<destination>[\w\u0600-\u06ff][\w\u0600-\u06ff\s]{0,40})"


@dataclass
class IntentRule:
    id: str
    patterns: list[str] = field(default_factory=list)
    keywords: list[str] = field(default_factory=list)
    priority: float = 1.0
    confidence: float = 0.9
    description: str = ""

    def compile(self) -> "IntentRule":
        self._compiled = [re.compile(p) for p in self.patterns]
        return self


@dataclass
class IntentMatch:
    intent: str
    confidence: float
    slots: dict[str, str] = field(default_factory=dict)
    matched: str = ""


# Question particles that trail a slot: «فاصله تا باشگاه چقدره» must yield
# "باشگاه", not "باشگاه چقدر".
_SLOT_STOP = frozenset({
    "چقدر", "چقدره", "کجا", "کجاست", "چطور", "چگونه", "چیست", "چیه",
    "چند", "چرا", "کدام", "کدوم", "چیا", "است", "هست", "بود", "شد",
})


def _clean_slot(value: str | None) -> str:
    if not value:
        return ""
    from .normalize import STOPWORDS

    words = [w for w in value.strip().split(" ") if w]
    kept: list[str] = []
    for word in words:
        if word in _SLOT_STOP:
            break
        if word in STOPWORDS:
            continue
        kept.append(word)
    return " ".join(kept).strip(" .،!?؟")


GAMEMODE_WORDS = (
    "بدوارز|بد ورز|bedwars|اسکای ?وارز|skywars|سوروایوال ?گیمز|سرگردانی|"
    "تی ?ان ?تی ?ران|tnt ?run|موردر|قاتل|murder|پارکور|parkour|"
    "بیلد ?بتل|build ?battle|اسپلیف|spleef|بریج|پل|the ?bridge|"
    "یو ?اچ ?سی|uhc|زامبی|zombie|کیت ?پی ?وی ?پی|kitpvp|دوئل|duel|"
    "فکشن|faction"
)

RANK_WORDS = "رایگان|نوب|معمولی|پرو|گاد|الترا ?گاد|free|noob|pro|god|ultra"

RULES: list[IntentRule] = [
    # ------------------------------------------------------------ place: save
    IntentRule(
        "save_place",
        # One named group per pattern: `re` refuses to reuse a group name, so
        # the alternations are split into separate rules instead.
        patterns=[
            rf"(?:به|با)\s*(?:اسم|نام)\s*{_PLACE_NAME}.*?(?:ذخیره|ثبت|سیو|save)",
            rf"(?:ذخیره|ثبت|سیو|save).*?(?:به|با)\s*(?:اسم|نام)\s*{_PLACE_NAME}",
            rf"{_PLACE_NAME}\s*را?\s*(?:صدا\s*کن|به\s*نام\s*کن|بنام)",
            rf"(?:ذخیره|ثبت|سیو|save)\s*(?:کن|کنید|بکن)\s*"
            rf"(?:به\s*(?:اسم|نام)\s*)?{_PLACE_NAME}",
            rf"{_PLACE_NAME}\s*را?\s*(?:ذخیره|ثبت|سیو)\s*(?:کن)?",
            r"(?:این\s*جا|اینجا|مکان\s*من|موقعیت\s*من|لوکیشن\s*من)\s*را?\s*"
            r"(?:ذخیره|ثبت|سیو)",
        ],
        keywords=["ذخیره مکان", "سیو کردن جا", "ثبت موقعیت"],
        priority=1.35,
        description="ذخیره‌ی مکان فعلی با یک نام",
    ),
    # -------------------------------------------------------- place: navigate
    IntentRule(
        "navigate",
        patterns=[
            rf"(?:چطور|چگونه)?\s*(?:بروم|برو|برسم|رفتن)\s*(?:به|تا|سوی)?\s*{_DEST}",
            rf"(?:مسیر|راه|راهنمای\s*رفتن|جهت)\s*(?:به|تا)?\s*{_DEST}",
            rf"{_DEST}\s*(?:کجاست|چطور\s*بروم)",
            rf"(?:ببرم|ببر)\s*به\s*{_DEST}",
        ],
        keywords=["مسیر", "رفتن به", "جهت"],
        priority=1.2,
        description="رفتن به یک مکان ذخیره‌شده",
    ),
    # --------------------------------------------------------- place: delete
    IntentRule(
        "delete_place",
        patterns=[
            rf"{_PLACE_NAME}\s*را?\s*(?:پاک|حذف|بردار)\s*(?:کن)?",
            rf"(?:پاک|حذف)\s*(?:کردن)?\s*مکان\s*{_PLACE_NAME}",
        ],
        keywords=["حذف مکان", "پاک کردن جا"],
        priority=1.15,
        description="حذف یک مکان ذخیره‌شده",
    ),
    # ---------------------------------------------------------- place: alias
    IntentRule(
        "set_alias",
        patterns=[
            rf"(?:برای\s*)?{_PLACE_NAME}\s*(?:نام\s*دیگر|اسم\s*دیگر|مستعار)\s*"
            r"(?:بگذار|بذار|ثبت\s*کن)\s*(?:به\s*(?:اسم|نام))?\s*(?P<alias>[\w\u0600-\u06ff\s]{1,30})",
        ],
        priority=1.05,
        description="افزودن نام مستعار به یک مکان",
    ),
    # ------------------------------------------------------------ place: list
    IntentRule(
        "list_places",
        patterns=[
            r"(?:مکان|محل|جا)\s*(?:ها|های)\s*(?:ی)?\s*(?:ذخیره|ثبت|سیو)",
            r"(?:لیست|فهرست|نمایش)\s*(?:مکان|محل|جا)(?:\s*ها)?",
            r"چه\s*(?:مکان|جا|محل)(?:هایی|هایی)\s*(?:ذخیره|دارم|سیو)",
            r"کجاها\s*را?\s*(?:ذخیره|سیو)",
            r"همه\s*مکان(?:\s*ها)?",
        ],
        keywords=["مکان های ذخیره شده", "لیست مکان ها"],
        priority=1.5,
        description="فهرست مکان‌های ذخیره‌شده",
    ),
    # ------------------------------------------------------- where am I / gps
    IntentRule(
        "where_am_i",
        patterns=[
            r"کجا\s*هستم",
            r"(?:الان\s*)?موقعیت\s*من",
            r"مختصات\s*من",
            r"(?:من\s*)?کجام",
            r"لوکیشن\s*من",
        ],
        keywords=["موقعیت فعلی", "مختصات"],
        priority=1.3,
        description="موقعیت فعلی",
    ),
    IntentRule(
        "gps_status",
        patterns=[
            r"جی\s*پی\s*اس",
            r"gps",
            r"مکان\s*یاب",
            r"(?:وضعیت|حالت)\s*(?:موقعیت|جی\s*پی\s*اس)",
        ],
        priority=1.0,
        description="وضعیت سخت‌افزار جی‌پی‌اس",
    ),
    IntentRule(
        "distance",
        patterns=[
            rf"فاصله(?:ی)?\s*(?:من\s*)?(?:تا|به)\s*{_DEST}",
            rf"چقدر\s*(?:تا|به)\s*{_DEST}\s*(?:فاصله|راه|دور)?",
            rf"{_DEST}\s*چقدر\s*(?:دور|نزدیک|فاصله)",
        ],
        priority=1.15,
        description="فاصله تا یک مکان",
    ),
    IntentRule(
        "nearest_place",
        patterns=[
            r"نزدیک\s*ترین\s*(?:مکان|جا|محل)",
            r"کدام\s*(?:مکان|جا)\s*نزدیک",
        ],
        priority=1.1,
        description="نزدیک‌ترین مکان ذخیره‌شده",
    ),
    # ------------------------------------------------------------------ track
    IntentRule(
        "track",
        patterns=[
            r"(?:مسیر\s*طی\s*شده|رد\s*پا|ترک|تاریخچه\s*مکان|مسیری\s*که\s*رفتم)",
            r"(?:پاک\s*کردن|حذف)\s*(?:مسیر\s*طی\s*شده|ترک|رد\s*پا)",
        ],
        # Above `navigate`: "مسیر طی شده" contains the word "مسیر", which the
        # navigate rule also matches.
        priority=1.3,
        description="تاریخچه‌ی موقعیت",
    ),
    # ------------------------------------------------------------- platform
    IntentRule(
        "server_status",
        patterns=[
            r"وضعیت\s*سرور",
            r"سرور\s*(?:روشن|بالا|انلاین|آنلاین|فعال)\s*(?:است|هست)?",
            r"چند\s*(?:نفر|بازیکن)\s*(?:انلاین|آنلاین|داخل)",
        ],
        keywords=["وضعیت سرور", "سرور آنلاین"],
        priority=1.15,
        description="وضعیت سرور ماینکرفت",
    ),
    IntentRule(
        "gamemodes",
        patterns=[
            rf"(?:گیم\s*مود|حالت\s*بازی)(?:ها)?(?:ی)?\s*(?:چه|چی|لیست)?\s*(?:{GAMEMODE_WORDS})?",
            rf"({GAMEMODE_WORDS})\s*(?:چیه|چیست|چطور|چند\s*نفر)",
        ],
        priority=1.05,
        description="حالت‌های بازی",
    ),
    IntentRule(
        "shop",
        patterns=[
            r"فروشگاه",
            r"خرید",
            r"محصول(?:ات|ها)?",
            r"چی\s*(?:می‌?فروشی|دارید)",
        ],
        priority=1.05,
        description="فروشگاه",
    ),
    IntentRule(
        "rank",
        patterns=[
            rf"رنک\s*(?:{RANK_WORDS})?",
            rf"(?:{RANK_WORDS})\s*(?:رنک|چه\s*مزیتی|چیه|چقدر)",
            r"(?:ارتقا|بالا\s*رفتن)\s*رنک",
        ],
        priority=1.05,
        description="رنک‌ها",
    ),
    IntentRule(
        "price",
        patterns=[
            r"قیمت",
            r"چند\s*(?:دلار|تومان|ریال)",
            r"هزینه",
        ],
        priority=1.15,
        description="قیمت‌ها",
    ),
    IntentRule(
        "discount",
        patterns=[
            r"تخفیف",
            r"ارزان\s*تر",
            r"حراج",
        ],
        priority=1.0,
        description="تخفیف‌ها",
    ),
    IntentRule(
        "anticheat",
        patterns=[
            r"انتی\s*چیت",
            r"ضد\s*تقلب",
            r"چیت(?:ر)?",
            r"بن\s*شدن",
        ],
        priority=1.0,
        description="سامانه‌ی ضد تقلب",
    ),
    IntentRule(
        "referral",
        patterns=[
            r"رفرال",
            r"دعوت\s*دوستان",
            r"کد\s*دعوت",
        ],
        priority=0.9,
        description="سیستم دعوت",
    ),
    # ------------------------------------------------------------------ misc
    IntentRule(
        "time",
        patterns=[r"ساعت\s*چند", r"تاریخ\s*(?:امروز|چند)", r"امروز\s*چندم"],
        priority=1.0,
        description="ساعت و تاریخ",
    ),
    IntentRule(
        "battery",
        patterns=[r"باتری", r"شارژ\s*گوشی"],
        priority=0.9,
        description="باتری",
    ),
    IntentRule(
        "files",
        patterns=[
            r"(?:فایل|پوشه)(?:ها)?(?:ی)?\s*(?:پروژه|اینجا)",
            r"چه\s*فایل\s*هایی",
            r"لیست\s*فایل",
        ],
        priority=0.9,
        description="فایل‌های پوشه",
    ),
    IntentRule(
        "confirm_yes",
        patterns=[r"^(?:بله|اره|آره|بلی|ok|باشه|حتما|تایید)$"],
        priority=1.4,
        description="تایید",
    ),
    IntentRule(
        "confirm_no",
        patterns=[r"^(?:نه|خیر|لغو|کنسل|no|بی\s*خیال)$"],
        priority=1.4,
        description="رد",
    ),
    IntentRule(
        "thanks",
        patterns=[r"ممنون", r"مرسی", r"تشکر", r"دمت\s*گرم", r"سپاس", r"thanks"],
        priority=0.85,
        description="تشکر",
    ),
    IntentRule(
        "greeting",
        patterns=[r"^سلام", r"^درود", r"صبح\s*بخیر", r"شب\s*بخیر", r"خسته\s*نباشی", r"^hi$", r"^hello$"],
        priority=0.85,
        description="سلام و احوالپرسی",
    ),
    IntentRule(
        "help",
        patterns=[
            r"^کمک", r"راهنما", r"چه\s*کار(?:هایی)?\s*(?:می\s*کنی|بلدی)",
            r"چیکار\s*می\s*کنی", r"دستورات",
        ],
        priority=0.95,
        description="راهنما",
    ),
]

_COMPILED: list[IntentRule] = [r.compile() for r in RULES]


def classify(text: str) -> list[IntentMatch]:
    """All rules that fire, best first. Never raises on weird input."""
    if not text or not text.strip():
        return []
    expanded = colloquial(text)
    plain = normalize(text)
    # Third form: ZWNJ removed rather than replaced by a space, so compound
    # words written with a half-space («مکان‌های») still match.
    collapsed = compact(text)
    forms = (expanded, plain, collapsed)
    out: list[IntentMatch] = []
    for rule in _COMPILED:
        best_conf = 0.0
        best_slots: dict[str, str] = {}
        best_text = ""
        for pattern in getattr(rule, "_compiled", []):
            for candidate in forms:
                m = pattern.search(candidate)
                if not m:
                    continue
                # Filter AFTER cleaning: a group that matched only stopwords
                # cleans to "" and must not count as a captured slot.
                slots = {}
                for key, value in m.groupdict().items():
                    cleaned = _clean_slot(value or "")
                    if cleaned:
                        slots[key] = cleaned
                # A rule that captured the slot it needs is more trustworthy
                # than one that matched the shape but came back empty.
                conf = rule.confidence * rule.priority
                if slots:
                    conf += 0.06
                elif _requires_slot(rule.id):
                    conf -= 0.28
                if conf > best_conf:
                    best_conf, best_slots, best_text = conf, slots, candidate
        if best_conf > 0:
            out.append(
                IntentMatch(
                    intent=rule.id,
                    # Raw ranking score, deliberately uncapped: `priority` is
                    # what separates competing rules, and clamping it to 0.99
                    # made every strong rule tie.
                    confidence=round(best_conf, 4),
                    slots=best_slots,
                    matched=best_text[:80],
                )
            )
    out.sort(key=lambda m: -m.confidence)
    return out


_SLOT_REQUIRED = {"save_place", "navigate", "delete_place", "distance", "set_alias"}


def _requires_slot(intent: str) -> bool:
    return intent in _SLOT_REQUIRED


def intent_descriptions() -> list[dict]:
    return [
        {"id": r.id, "description": r.description, "priority": r.priority}
        for r in RULES
    ]
