"""
Saved places — the feature the user actually asked for.

The point is *persistence*, not measurement: you stand somewhere, say
«اینجا رو سیو کن به اسم خونه», and from then on «برم خونه» resolves to that
point without you ever repeating coordinates. Distance and heading are
computed only as a consequence of having saved something.

Storage is SQLite inside ``data/`` (stdlib ``sqlite3``), so nothing leaves the
phone and nothing needs a server.
"""

from __future__ import annotations

import json
import sqlite3
import threading
import time
from dataclasses import dataclass, field
from typing import Iterable

from .fuzzy import best_match, combined
from .geo import RouteLeg, plan_route
from .normalize import normalize
from .paths import DB_PATH, ensure_dirs

SCHEMA = """
CREATE TABLE IF NOT EXISTS places (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT NOT NULL,
    name_norm       TEXT NOT NULL UNIQUE,
    lat             REAL NOT NULL,
    lon             REAL NOT NULL,
    accuracy        REAL,
    note            TEXT DEFAULT '',
    tags            TEXT DEFAULT '[]',
    created_at      REAL NOT NULL,
    updated_at      REAL NOT NULL,
    visits          INTEGER NOT NULL DEFAULT 0,
    last_visited_at REAL
);
CREATE INDEX IF NOT EXISTS idx_places_name_norm ON places(name_norm);

CREATE TABLE IF NOT EXISTS place_aliases (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    place_id    INTEGER NOT NULL REFERENCES places(id) ON DELETE CASCADE,
    alias       TEXT NOT NULL,
    alias_norm  TEXT NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS idx_alias_place ON place_aliases(place_id);

CREATE TABLE IF NOT EXISTS gps_track (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    lat        REAL NOT NULL,
    lon        REAL NOT NULL,
    accuracy   REAL,
    taken_at   REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_track_taken ON gps_track(taken_at);
"""


@dataclass
class Place:
    id: int
    name: str
    name_norm: str
    lat: float
    lon: float
    accuracy: float | None = None
    note: str = ""
    tags: list[str] = field(default_factory=list)
    created_at: float = 0.0
    updated_at: float = 0.0
    visits: int = 0
    last_visited_at: float | None = None
    aliases: list[str] = field(default_factory=list)
    score: float = 0.0

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "lat": self.lat,
            "lon": self.lon,
            "accuracy": self.accuracy,
            "note": self.note,
            "tags": self.tags,
            "aliases": self.aliases,
            "visits": self.visits,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "last_visited_at": self.last_visited_at,
            "score": self.score,
        }


class PlaceStore:
    def __init__(self, db_path=None) -> None:
        self.db_path = str(db_path or DB_PATH)
        self._local = threading.local()
        ensure_dirs()
        with self._conn() as conn:
            conn.executescript(SCHEMA)
            conn.commit()

    def _conn(self) -> sqlite3.Connection:
        conn = getattr(self._local, "conn", None)
        if conn is None:
            conn = sqlite3.connect(self.db_path, timeout=10.0)
            conn.row_factory = sqlite3.Row
            conn.execute("PRAGMA foreign_keys = ON")
            self._local.conn = conn
        return conn

    # ------------------------------------------------------------------ writes

    def save(self, name: str, lat: float, lon: float,
             accuracy: float | None = None, note: str = "",
             tags: Iterable[str] = (),
             aliases: Iterable[str] = ()) -> tuple[Place, bool]:
        """
        Insert, or update in place if the normalised name already exists.

        Re-saving is idempotent by design: saying «خونه رو سیو کن» twice from
        two different spots moves the pin rather than creating «خونه ۲».
        """
        name = name.strip()
        if not name:
            raise ValueError("place name is empty")
        if not (-90.0 <= lat <= 90.0) or not (-180.0 <= lon <= 180.0):
            raise ValueError(f"coordinates out of range: {lat},{lon}")
        key = normalize(name)
        now = time.time()
        conn = self._conn()
        row = conn.execute("SELECT id FROM places WHERE name_norm = ?", (key,)).fetchone()
        created = row is None
        with conn:
            if created:
                cur = conn.execute(
                    "INSERT INTO places (name, name_norm, lat, lon, accuracy, note, tags,"
                    " created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
                    (name, key, lat, lon, accuracy, note, json.dumps(list(tags), ensure_ascii=False),
                     now, now),
                )
                place_id = int(cur.lastrowid)
            else:
                place_id = int(row["id"])
                conn.execute(
                    "UPDATE places SET name=?, lat=?, lon=?, accuracy=?, note=?, tags=?,"
                    " updated_at=? WHERE id=?",
                    (name, lat, lon, accuracy, note,
                     json.dumps(list(tags), ensure_ascii=False), now, place_id),
                )
            for alias in aliases:
                self._add_alias(conn, place_id, alias)
        return self.get_by_id(place_id), created  # type: ignore[return-value]

    def _add_alias(self, conn: sqlite3.Connection, place_id: int, alias: str) -> None:
        alias = (alias or "").strip()
        if not alias:
            return
        norm = normalize(alias)
        if not norm:
            return
        conn.execute(
            "INSERT OR IGNORE INTO place_aliases (place_id, alias, alias_norm)"
            " VALUES (?,?,?)",
            (place_id, alias, norm),
        )

    def add_alias(self, place_name: str, alias: str) -> bool:
        place = self.get(place_name)
        if not place:
            return False
        conn = self._conn()
        with conn:
            self._add_alias(conn, place.id, alias)
        return True

    def delete(self, name: str) -> bool:
        place = self.get(name)
        if not place:
            return False
        conn = self._conn()
        with conn:
            conn.execute("DELETE FROM places WHERE id = ?", (place.id,))
        return True

    def touch(self, name: str) -> None:
        place = self.get(name)
        if not place:
            return
        conn = self._conn()
        with conn:
            conn.execute(
                "UPDATE places SET visits = visits + 1, last_visited_at = ? WHERE id = ?",
                (time.time(), place.id),
            )

    # ------------------------------------------------------------------- reads

    @staticmethod
    def _row_to_place(row: sqlite3.Row) -> Place:
        try:
            tags = json.loads(row["tags"] or "[]")
        except json.JSONDecodeError:
            tags = []
        return Place(
            id=int(row["id"]),
            name=row["name"],
            name_norm=row["name_norm"],
            lat=float(row["lat"]),
            lon=float(row["lon"]),
            accuracy=None if row["accuracy"] is None else float(row["accuracy"]),
            note=row["note"] or "",
            tags=tags,
            created_at=float(row["created_at"]),
            updated_at=float(row["updated_at"]),
            visits=int(row["visits"] or 0),
            last_visited_at=row["last_visited_at"],
        )

    def _with_aliases(self, places: list[Place]) -> list[Place]:
        if not places:
            return places
        conn = self._conn()
        rows = conn.execute("SELECT place_id, alias FROM place_aliases").fetchall()
        by_id: dict[int, list[str]] = {}
        for r in rows:
            by_id.setdefault(int(r["place_id"]), []).append(r["alias"])
        for p in places:
            p.aliases = by_id.get(p.id, [])
        return places

    def get_by_id(self, place_id: int) -> Place | None:
        row = self._conn().execute("SELECT * FROM places WHERE id = ?", (place_id,)).fetchone()
        return self._with_aliases([self._row_to_place(row)])[0] if row else None

    def all(self) -> list[Place]:
        rows = self._conn().execute(
            "SELECT * FROM places ORDER BY visits DESC, updated_at DESC"
        ).fetchall()
        return self._with_aliases([self._row_to_place(r) for r in rows])

    def get(self, query: str) -> Place | None:
        matches = self.find(query, limit=1, floor=0.62)
        return matches[0] if matches else None

    def find(self, query: str, limit: int = 5, floor: float = 0.45) -> list[Place]:
        """
        Resolve free text to a saved place.

        Three passes, cheapest first: exact normalised name, exact normalised
        alias, then fuzzy over every name+alias. A visit-count bonus means
        «خونه» picks your real home over a place you once saved by accident.
        """
        norm = normalize(query)
        if not norm:
            return []
        conn = self._conn()
        row = conn.execute("SELECT * FROM places WHERE name_norm = ?", (norm,)).fetchone()
        if row:
            return self._with_aliases([self._row_to_place(row)])
        row = conn.execute(
            "SELECT p.* FROM places p JOIN place_aliases a ON a.place_id = p.id"
            " WHERE a.alias_norm = ?",
            (norm,),
        ).fetchone()
        if row:
            return self._with_aliases([self._row_to_place(row)])

        candidates: list[tuple[Place, str]] = []
        for place in self.all():
            candidates.append((place, place.name))
            candidates.extend((place, alias) for alias in place.aliases)
        scored: dict[int, tuple[Place, float]] = {}
        for place, label in candidates:
            s = combined(norm, label)
            prev = scored.get(place.id)
            if prev is None or s > prev[1]:
                scored[place.id] = (place, s)
        ranked = [
            (p, round(s + min(p.visits, 5) * 0.01, 6))
            for p, s in scored.values()
            if s >= floor
        ]
        ranked.sort(key=lambda x: -x[1])
        out: list[Place] = []
        for place, score in ranked[:limit]:
            place.score = score
            out.append(place)
        return out

    def suggest_names(self, query: str, limit: int = 3) -> list[str]:
        names = [p.name for p in self.all()]
        return [name for name, _ in best_match(query, names, limit=limit)]

    # ------------------------------------------------------------- navigation

    def route_to(self, name: str, from_lat: float, from_lon: float) -> tuple[Place, RouteLeg] | None:
        place = self.get(name)
        if not place:
            return None
        self.touch(name)
        return place, plan_route(from_lat, from_lon, place.lat, place.lon)

    # ------------------------------------------------------------------ track

    def record_track_point(self, lat: float, lon: float, accuracy: float | None = None) -> None:
        conn = self._conn()
        with conn:
            conn.execute(
                "INSERT INTO gps_track (lat, lon, accuracy, taken_at) VALUES (?,?,?,?)",
                (lat, lon, accuracy, time.time()),
            )

    def track(self, limit: int = 200) -> list[dict]:
        rows = self._conn().execute(
            "SELECT lat, lon, accuracy, taken_at FROM gps_track ORDER BY taken_at DESC LIMIT ?",
            (limit,),
        ).fetchall()
        return [dict(r) for r in reversed(rows)]

    def clear_track(self) -> int:
        conn = self._conn()
        with conn:
            cur = conn.execute("DELETE FROM gps_track")
        return cur.rowcount or 0

    def nearest(self, lat: float, lon: float, limit: int = 3) -> list[tuple[Place, float]]:
        from .geo import haversine_m

        scored = [(p, haversine_m(lat, lon, p.lat, p.lon)) for p in self.all()]
        scored.sort(key=lambda x: x[1])
        return scored[:limit]
