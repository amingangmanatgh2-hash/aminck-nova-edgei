"""
String similarity with a Persian phonetic layer.

Why a phonetic key at all: Persian has six letters that are pronounced
identically but spelled differently (ز/ذ/ض/ظ, س/ث/ص, ه/ح, غ/ق). Someone typing
a place name from memory writes "حضرت" or "حزرت" and both must match. A plain
edit-distance treats those as three edits; collapsing them to a consonant
skeleton treats them as zero.
"""

from __future__ import annotations

from .normalize import ngrams, normalize

# Homophone classes -> one representative letter.
_PHONETIC = {
    "ز": "ز", "ذ": "ز", "ض": "ز", "ظ": "ز",
    "س": "س", "ث": "س", "ص": "س",
    "ت": "ت", "ط": "ت",
    "ه": "ه", "ح": "ه",
    "غ": "ق", "ق": "ق",
    "ا": "ا", "آ": "ا", "ع": "ا", "ء": "ا", "أ": "ا", "إ": "ا", "ٱ": "ا",
    "ی": "ی", "ئ": "ی",
    "ک": "ک", "گ": "ک",
    "ب": "ب", "پ": "ب",
    "ج": "ج", "چ": "ج",
    "د": "د",
    "ف": "ف",
    "خ": "خ",
    "ش": "ش",
    "ر": "ر",
    "ل": "ل",
    "م": "م",
    "ن": "ن",
    "و": "و",
}
_VOWELS = frozenset("اویائه" + "aeiou")


def phonetic_key(word: str) -> str:
    """Consonant skeleton: homophones merged, vowels dropped."""
    out: list[str] = []
    for ch in normalize(word):
        mapped = _PHONETIC.get(ch)
        if mapped is None:
            continue  # digits, latin, punctuation
        if mapped in _VOWELS and out:
            continue
        out.append(mapped)
    return "".join(out)


def levenshtein(a: str, b: str, cutoff: int | None = None) -> int:
    """
    Classic edit distance with an optional early cutoff.

    The cutoff matters on a phone: comparing a query against 200 knowledge
    titles without it is O(len(a)*len(b)) every time, and we would be doing it
    hundreds of times per request.
    """
    a, b = normalize(a), normalize(b)
    if a == b:
        return 0
    la, lb = len(a), len(b)
    if cutoff is not None and abs(la - lb) > cutoff:
        return cutoff + 1
    if la == 0:
        return lb
    if lb == 0:
        return la

    prev = list(range(lb + 1))
    for i in range(1, la + 1):
        cur = [i] + [0] * lb
        best = cur[0]
        ca = a[i - 1]
        for j in range(1, lb + 1):
            cost = 0 if ca == b[j - 1] else 1
            cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
            if cur[j] < best:
                best = cur[j]
        if cutoff is not None and best > cutoff:
            return cutoff + 1
        prev = cur
    return prev[lb]


def similarity(a: str, b: str) -> float:
    """Normalised 0..1 similarity (1 - dist/maxlen)."""
    a, b = normalize(a), normalize(b)
    if not a and not b:
        return 1.0
    if not a or not b:
        return 0.0
    dist = levenshtein(a, b)
    return 1.0 - dist / max(len(a), len(b))


def jaro(a: str, b: str) -> float:
    a, b = normalize(a), normalize(b)
    if a == b:
        return 1.0
    la, lb = len(a), len(b)
    if la == 0 or lb == 0:
        return 0.0
    window = max(la, lb) // 2 - 1
    if window < 0:
        window = 0
    a_match = [False] * la
    b_match = [False] * lb
    matches = 0
    for i in range(la):
        lo = max(0, i - window)
        hi = min(i + window + 1, lb)
        for j in range(lo, hi):
            if b_match[j] or a[i] != b[j]:
                continue
            a_match[i] = b_match[j] = True
            matches += 1
            break
    if matches == 0:
        return 0.0
    transpositions = 0
    k = 0
    for i in range(la):
        if not a_match[i]:
            continue
        while not b_match[k]:
            k += 1
        if a[i] != b[k]:
            transpositions += 1
        k += 1
    transpositions //= 2
    m = matches
    return (m / la + m / lb + (m - transpositions) / m) / 3.0


def jaro_winkler(a: str, b: str, prefix_weight: float = 0.1) -> float:
    j = jaro(a, b)
    if j < 0.7:
        return j
    a_n, b_n = normalize(a), normalize(b)
    prefix = 0
    for x, y in zip(a_n[:4], b_n[:4]):
        if x != y:
            break
        prefix += 1
    return j + prefix * prefix_weight * (1 - j)


def dice(a: str, b: str, n: int = 2) -> float:
    """Sørensen–Dice over character n-grams; good for word-order swaps."""
    ga, gb = ngrams(a, n), ngrams(b, n)
    if not ga or not gb:
        return 0.0
    from collections import Counter

    ca, cb = Counter(ga), Counter(gb)
    overlap = sum((ca & cb).values())
    return 2 * overlap / (len(ga) + len(gb))


def combined(a: str, b: str) -> float:
    """
    The score the assistant actually ranks on.

    Weighted blend: exact/near-exact edits matter most, but the phonetic key
    rescues homophone misspellings that edit distance alone would reject.
    """
    a_n, b_n = normalize(a), normalize(b)
    if a_n == b_n:
        return 1.0
    edit = similarity(a_n, b_n)
    jw = jaro_winkler(a_n, b_n)
    dg = dice(a_n, b_n)
    pa, pb = phonetic_key(a_n), phonetic_key(b_n)
    phon = 1.0 if pa and pa == pb else similarity(pa, pb) * 0.92
    return round(0.34 * edit + 0.22 * jw + 0.20 * dg + 0.24 * phon, 6)


def best_match(query: str, candidates: list[str], limit: int = 3,
               floor: float = 0.35) -> list[tuple[str, float]]:
    """Top-*limit* candidates above *floor*, descending."""
    scored = [(c, combined(query, c)) for c in candidates]
    scored = [s for s in scored if s[1] >= floor]
    scored.sort(key=lambda x: (-x[1], x[0]))
    return scored[:limit]
