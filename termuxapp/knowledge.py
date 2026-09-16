"""
Offline knowledge base: file-backed documents + a BM25 index.

Documents live in ``data/knowledge/*.json`` so the user can add their own
answers without touching code. Nothing is fetched at runtime — this is the
"AI" that keeps working on a phone with no SIM and no Wi-Fi.
"""

from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass, field
from pathlib import Path

from .normalize import stem_tokens, tokenize
from .paths import KB_DIR


@dataclass
class KnowledgeEntry:
    id: str
    title: str
    body: str
    keywords: list[str] = field(default_factory=list)
    tags: list[str] = field(default_factory=list)
    answers: list[str] = field(default_factory=list)
    priority: int = 0
    source: str = ""

    def best_answer(self) -> str:
        if self.answers:
            return self.answers[0]
        return self.body


def _read_json_file(path: Path) -> list[dict]:
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []
    if isinstance(raw, dict):
        raw = raw.get("entries", [])
    return [e for e in raw if isinstance(e, dict)]


class KnowledgeBase:
    """Inverted index over the JSON knowledge folder."""

    # BM25 tuning. k1/b are the standard defaults; they are not claimed to be
    # optimal for Persian, just sane and stable across the test corpus.
    K1 = 1.5
    B = 0.75

    def __init__(self, directory: Path | None = None) -> None:
        self.directory = directory or KB_DIR
        self.entries: list[KnowledgeEntry] = []
        self._df: dict[str, int] = {}
        self._doc_tokens: list[list[str]] = []
        self._avg_len = 0.0
        self._by_id: dict[str, KnowledgeEntry] = {}
        self.reload()

    # ------------------------------------------------------------------ loading

    def reload(self) -> int:
        self.entries = []
        files = sorted(self.directory.glob("*.json")) if self.directory.is_dir() else []
        for path in files:
            for raw in _read_json_file(path):
                entry = self._coerce(raw, path.name)
                if entry:
                    self.entries.append(entry)
        self._build_index()
        return len(self.entries)

    @staticmethod
    def _coerce(raw: dict, source: str) -> KnowledgeEntry | None:
        title = str(raw.get("title") or "").strip()
        eid = str(raw.get("id") or "").strip()
        if not title and not eid:
            return None
        eid = eid or re.sub(r"\W+", "-", title.lower()).strip("-") or f"kb-{len(raw)}"
        return KnowledgeEntry(
            id=eid,
            title=title,
            body=str(raw.get("body") or ""),
            keywords=[str(k) for k in raw.get("keywords", []) if str(k).strip()],
            tags=[str(t) for t in raw.get("tags", []) if str(t).strip()],
            answers=[str(a) for a in raw.get("answers", []) if str(a).strip()],
            priority=int(raw.get("priority", 0) or 0),
            source=source,
        )

    def _build_index(self) -> None:
        self._by_id = {e.id: e for e in self.entries}
        self._df = {}
        self._doc_tokens = []
        for entry in self.entries:
            # Keywords and title are indexed repeatedly on purpose: a term the
            # author flagged as a keyword should outweigh incidental body text.
            toks = (
                stem_tokens(entry.title) * 3
                + [stem_tokens(k)[0] for k in entry.keywords if stem_tokens(k)] * 2
                + stem_tokens(" ".join(entry.tags))
                + stem_tokens(entry.body)
            )
            toks = [t for t in toks if t]
            self._doc_tokens.append(toks)
            for term in set(toks):
                self._df[term] = self._df.get(term, 0) + 1
        total = sum(len(t) for t in self._doc_tokens)
        self._avg_len = (total / len(self._doc_tokens)) if self._doc_tokens else 0.0

    # ------------------------------------------------------------------- search

    def get(self, entry_id: str) -> KnowledgeEntry | None:
        return self._by_id.get(entry_id)

    def search(self, query: str, limit: int = 5) -> list[tuple[KnowledgeEntry, float]]:
        if not self._doc_tokens:
            return []
        q_terms = stem_tokens(query)
        if not q_terms:
            return []
        n_docs = len(self._doc_tokens)
        scores: dict[int, float] = {}
        for term in q_terms:
            df = self._df.get(term, 0)
            if df == 0:
                continue
            idf = math.log(1 + (n_docs - df + 0.5) / (df + 0.5))
            for idx, doc in enumerate(self._doc_tokens):
                tf = doc.count(term)
                if tf == 0:
                    continue
                denom = tf + self.K1 * (1 - self.B + self.B * len(doc) / max(1.0, self._avg_len))
                scores[idx] = scores.get(idx, 0.0) + idf * (tf * (self.K1 + 1)) / denom
        if not scores:
            return []
        ranked = sorted(scores.items(), key=lambda kv: -kv[1])
        out: list[tuple[KnowledgeEntry, float]] = []
        for idx, score in ranked[:limit]:
            entry = self.entries[idx]
            # Author priority is a tie-breaker, capped so it cannot dominate.
            out.append((entry, round(score + min(entry.priority, 3) * 0.05, 6)))
        return out

    def titles(self) -> list[str]:
        return [e.title for e in self.entries]

    def __len__(self) -> int:
        return len(self.entries)


def tokenize_for_match(text: str) -> list[str]:
    """Convenience re-export used by the assistant's keyword scorer."""
    return tokenize(text)
