"""
Persian-aware text normalisation.

This is the single biggest quality lever for the offline assistant: if "خونه"
and "خانه" and "خونِه" do not collapse to the same token, no amount of ranking
saves you. Everything downstream (search, intents, fuzzy matching) consumes
the output of :func:`normalize` / :func:`tokenize`.
"""

from __future__ import annotations

import re
import unicodedata

# Arabic forms -> their Persian equivalents (users type both, especially on
# Android keyboards that default to an Arabic layout).
_CHAR_MAP = {
    "\u0643": "\u06a9",  # ك -> ک
    "\u0649": "\u06cc",  # ى -> ی
    "\u064a": "\u06cc",  # ي -> ی
    "\u0622": "\u0627",  # آ -> ا
    "\u0623": "\u0627",  # أ -> ا
    "\u0625": "\u0627",  # إ -> ا
    "\u0624": "\u0648",  # ؤ -> و
    "\u0626": "\u06cc",  # ئ -> ی
    "\u0629": "\u0647",  # ة -> ه
    "\u0671": "\u0627",  # ٱ -> ا
    "\u200c": " ",       # ZWNJ -> space (نیم‌فاصله)
    "\u200f": "",        # RLM
    "\u200e": "",        # LRM
    "\u0640": "",        # tatweel ـ
}

# Arabic diacritics + Quranic marks: strip, they never carry meaning here.
_DIACRITICS = re.compile("[\u064b-\u0652\u0670\u0653-\u0655\u06d6-\u06ed]")

# Persian digits -> ASCII. Done BEFORE anything else so regex \d works.
_DIGITS = str.maketrans("\u06f0\u06f1\u06f2\u06f3\u06f4\u06f5\u06f6\u06f7\u06f8\u06f9"
                        "\u0660\u0661\u0662\u0663\u0664\u0665\u0666\u0667\u0668\u0669",
                        "0123456789" * 2)

# Spoken/colloquial Persian -> written form. Hand-curated; these are the ones
# that actually show up in chat-style input.
_COLLOQUIAL = {
    "خونه": "خانه",
    "خونم": "خانه ام",
    "میرم": "می روم",
    "برم": "بروم",
    "چطور": "چطور",
    "کجاست": "کجا است",
    "چیه": "چیست",
    "چقدره": "چقدر است",
    "چنده": "چند است",
    "هستش": "هست",
    "رو": "را",
    "مو": "را",
    "امروزه": "امروز",
    "میخوام": "می خواهم",
    "میخام": "می خواهم",
    "خوبه": "خوب است",
    "باشه": "باشد",
    "سیوش": "ذخیره اش",
    "سیو": "ذخیره",
    "لوکیشن": "موقعیت",
    "مکانم": "مکان ام",
}

STOPWORDS = frozenset(
    """
    و یا اما ولی که چون اگر تا وقتی هنگام این آن ها های هایی یک دو سه
    من تو او ما شما آنها ایشون اینها آنهای
    در به از با برای روی زیر بالا بین درباره را
    است هست بودند بود شد شده کند کرد
    که آیا هم هر هیچ چیزی چیزی
    the a an of and or to in for on with is are was were be been
    """.split()
)

_WORD_RE = re.compile(r"[\w\u0600-\u06ff]+", re.UNICODE)


def normalize(text: str) -> str:
    """Canonical comparable form: ASCII digits, unified letters, no marks."""
    if not text:
        return ""
    text = unicodedata.normalize("NFKC", str(text))
    text = text.translate(_DIGITS)
    text = _DIACRITICS.sub("", text)
    text = text.translate(str.maketrans(_CHAR_MAP))
    text = text.lower()
    text = re.sub(r"\s+", " ", text).strip()
    return text


_COMPACT_MAP = {**_CHAR_MAP, "\u200c": ""}


def compact(text: str) -> str:
    """
    Like :func:`normalize`, but the ZWNJ is *removed* instead of becoming a
    space.

    Both forms are needed. `normalize` turns «مکان‌های» into «مکان های», which
    is right for tokenising and search. But a regex written for the compound
    word then fails, so intent matching also tries this collapsed form.
    """
    if not text:
        return ""
    text = unicodedata.normalize("NFKC", str(text))
    text = text.translate(_DIGITS)
    text = _DIACRITICS.sub("", text)
    text = text.translate(str.maketrans(_COMPACT_MAP))
    text = text.lower()
    return re.sub(r"\s+", " ", text).strip()


def colloquial(text: str) -> str:
    """Expand common spoken forms after normalisation."""
    norm = normalize(text)
    return " ".join(_COLLOQUIAL.get(tok, tok) for tok in norm.split(" "))


def tokenize(text: str, keep_stopwords: bool = False) -> list[str]:
    norm = colloquial(text)
    toks = _WORD_RE.findall(norm)
    if keep_stopwords:
        return toks
    return [t for t in toks if t not in STOPWORDS]


# ---------------------------------------------------------------- light stemmer

_SUFFIXES = (
    "هایی", "هایشان", "هایم", "هایمان",
    "ها", "ات", "ان", "هاست",
    "ترین", "تر",
    "شان", "مان", "اش", "ام",
)

_PREFIXES = ("نمی", "می", "ن", "بی", "با")


def stem(word: str) -> str:
    """
    Deliberately *light* Persian stemmer.

    A heavy stemmer (Porter-style) mangles Persian: it merges "خانه" with
    "خانو" and destroys place names. We only strip unambiguous inflection, and
    never below 3 characters.
    """
    w = normalize(word)
    if len(w) <= 3:
        return w
    changed = True
    while changed and len(w) > 3:
        changed = False
        for suf in _SUFFIXES:
            if w.endswith(suf) and len(w) - len(suf) >= 3:
                w = w[: -len(suf)]
                changed = True
                break
    for pre in _PREFIXES:
        if w.startswith(pre) and len(w) - len(pre) >= 3:
            return w[len(pre):]
    return w


def stem_tokens(text: str) -> list[str]:
    return [stem(t) for t in tokenize(text)]


def ngrams(text: str, n: int = 2) -> list[str]:
    """Character n-grams of the normalised, space-stripped form."""
    compact = normalize(text).replace(" ", "")
    if len(compact) < n:
        return [compact] if compact else []
    return [compact[i: i + n] for i in range(len(compact) - n + 1)]
