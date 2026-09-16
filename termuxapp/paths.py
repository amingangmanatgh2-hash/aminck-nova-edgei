"""
All filesystem access is rooted at the repository folder.

The user asked for one thing explicitly: the localhost must read *everything*
from the folder it lives in. So `ROOT` is derived from this file's location,
never from the process working directory, and every user-supplied path goes
through :func:`safe_resolve` which refuses to escape `ROOT`.
"""

from __future__ import annotations

import os
from pathlib import Path

ROOT: Path = Path(__file__).resolve().parent.parent

DATA_DIR: Path = ROOT / "data"
KB_DIR: Path = DATA_DIR / "knowledge"
GPS_DIR: Path = DATA_DIR / "gps"
MEMORY_DIR: Path = DATA_DIR / "memory"
LOG_DIR: Path = DATA_DIR / "logs"

WEB_DIR: Path = ROOT / "web"
PUBLIC_DIR: Path = ROOT / "public"
DOCS_DIR: Path = ROOT / "docs"

DB_PATH: Path = DATA_DIR / "nova.db"
PLACES_PATH: Path = DATA_DIR / "places.json"
CATALOG_PATH: Path = DATA_DIR / "catalog.json"
CONFIG_PATH: Path = DATA_DIR / "config.json"
LAST_FIX_PATH: Path = GPS_DIR / "last_fix.json"
FEEDBACK_PATH: Path = MEMORY_DIR / "feedback.jsonl"
QUERIES_PATH: Path = MEMORY_DIR / "queries.jsonl"

WRITABLE_DIRS: tuple[Path, ...] = (DATA_DIR, KB_DIR, GPS_DIR, MEMORY_DIR, LOG_DIR)


def ensure_dirs() -> None:
    """Create the writable data folders. Safe to call on every start."""
    for d in WRITABLE_DIRS:
        d.mkdir(parents=True, exist_ok=True)


def safe_resolve(relative: str | os.PathLike[str]) -> Path:
    """
    Resolve *relative* inside :data:`ROOT`, refusing anything that escapes it.

    ``..`` segments, absolute paths and symlink tricks all resolve to a path
    that we then verify is still under ROOT. Returns None-equivalent by raising
    :class:`PermissionError` so callers cannot accidentally serve /etc/passwd.
    """
    candidate = Path(relative)
    if candidate.is_absolute():
        # Absolute paths are allowed only if they are already inside ROOT.
        resolved = candidate.resolve()
    else:
        resolved = (ROOT / candidate).resolve()
    try:
        resolved.relative_to(ROOT.resolve())
    except ValueError as exc:  # pragma: no cover - exercised by tests
        raise PermissionError(f"path escapes project root: {relative}") from exc
    return resolved


def is_inside_root(path: Path) -> bool:
    try:
        path.resolve().relative_to(ROOT.resolve())
        return True
    except ValueError:
        return False


def rel_to_root(path: Path) -> str:
    try:
        return path.resolve().relative_to(ROOT.resolve()).as_posix()
    except ValueError:
        return path.name


def human_size(num: int | float) -> str:
    size = float(num)
    for unit in ("B", "KB", "MB", "GB"):
        if size < 1024 or unit == "GB":
            return f"{size:.0f} {unit}" if unit == "B" else f"{size:.1f} {unit}"
        size /= 1024
    return f"{size:.1f} GB"  # pragma: no cover
