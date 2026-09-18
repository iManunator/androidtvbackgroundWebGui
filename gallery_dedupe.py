"""Identify gallery wallpapers by stable media IDs and skip/replace duplicates."""

from __future__ import annotations

import json
import os
import re
from typing import Any, Dict, Iterable, List, Optional, Set


def _safe_name(text: Any) -> str:
    return "".join(c for c in str(text or "") if c.isalnum() or c in " ._-").strip()


def _norm_imdb(val: Any) -> str:
    s = str(val or "").strip()
    if not s:
        return ""
    if s.lower().startswith("tt"):
        return s.lower()
    if s.isdigit():
        return f"tt{s}"
    return s.lower()


def _media_type(meta: dict) -> str:
    mt = str(meta.get("media_type") or meta.get("Type") or "").strip().lower()
    if mt in ("tv", "show", "series"):
        return "tv"
    if mt in ("movie", "film"):
        return "movie"
    # Heuristics
    if meta.get("source") in ("Jellyfin",) and str(meta.get("Type") or "").lower() == "series":
        return "tv"
    title_id = str(meta.get("id") or "")
    if title_id.startswith("jellyseerr-tv-") or title_id.startswith("seerr-tv-"):
        return "tv"
    return "movie"


def identity_keys(meta: Optional[dict]) -> Set[str]:
    """Stable keys used to decide 'already generated for this show/movie'."""
    meta = meta if isinstance(meta, dict) else {}
    keys: Set[str] = set()

    imdb = _norm_imdb(
        meta.get("imdb_id")
        or (meta.get("provider_ids") or {}).get("Imdb")
        or (meta.get("ProviderIds") or {}).get("Imdb")
        or (meta.get("external_ids") or {}).get("imdb_id")
    )
    if imdb:
        keys.add(f"imdb:{imdb}")

    tmdb = meta.get("tmdb_id") or meta.get("tmdbId")
    if tmdb in (None, "", "N/A"):
        pids = meta.get("provider_ids") or meta.get("ProviderIds") or {}
        if isinstance(pids, dict):
            tmdb = pids.get("Tmdb") or pids.get("tmdb")
    try:
        tmdb_i = int(tmdb) if tmdb not in (None, "") else None
    except (TypeError, ValueError):
        tmdb_i = None
    mt = _media_type(meta)
    if tmdb_i is not None:
        keys.add(f"tmdb:{mt}:{tmdb_i}")
        keys.add(f"tmdb:{tmdb_i}")

    jid = meta.get("jellyfin_id")
    raw_id = meta.get("id")
    if jid:
        keys.add(f"jf:{jid}")
    elif raw_id and meta.get("source") == "Jellyfin":
        keys.add(f"jf:{raw_id}")
    elif raw_id and not str(raw_id).startswith(("jellyseerr-", "seerr-", "tmdb-", "trakt-")):
        # Likely a Jellyfin GUID
        if re.fullmatch(r"[0-9a-fA-F-]{16,}", str(raw_id)):
            keys.add(f"jf:{raw_id}")

    if tmdb_i is not None and (
        str(meta.get("source") or "").lower() in ("seerr", "jellyseerr")
        or str(raw_id or "").startswith(("jellyseerr-", "seerr-"))
    ):
        keys.add(f"seerr:{mt}:{tmdb_i}")

    title = _safe_name(meta.get("title") or meta.get("Name") or "").lower()
    year = meta.get("year") or meta.get("ProductionYear") or ""
    if title:
        keys.add(f"title:{title}|{year}")

    return keys


def preferred_basename(meta: Optional[dict]) -> str:
    """Canonical gallery basename (without extension)."""
    meta = meta if isinstance(meta, dict) else {}
    title = _safe_name(meta.get("title") or meta.get("Name") or "untitled") or "untitled"
    parts = [title]
    year = meta.get("year") or meta.get("ProductionYear")
    if year not in (None, "", "N/A"):
        parts.append(str(year))
    imdb = _norm_imdb(
        meta.get("imdb_id")
        or (meta.get("provider_ids") or {}).get("Imdb")
        or (meta.get("ProviderIds") or {}).get("Imdb")
    )
    if imdb:
        parts.append(imdb)
    else:
        tmdb = meta.get("tmdb_id") or meta.get("tmdbId")
        try:
            tmdb_i = int(tmdb) if tmdb not in (None, "") else None
        except (TypeError, ValueError):
            tmdb_i = None
        if tmdb_i is not None:
            parts.append(f"tmdb{_media_type(meta)}{tmdb_i}")
    return " - ".join(parts)


def preferred_filename(meta: Optional[dict]) -> str:
    return preferred_basename(meta) + ".jpg"


def _read_sidecar_meta(json_path: str) -> dict:
    try:
        with open(json_path, "r", encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict):
            return data.get("metadata") if isinstance(data.get("metadata"), dict) else data
    except Exception:
        pass
    return {}


def index_layout_dir(layout_dir: str) -> List[Dict[str, Any]]:
    """Scan layout gallery folder → [{base, keys, json_path}]."""
    out: List[Dict[str, Any]] = []
    if not layout_dir or not os.path.isdir(layout_dir):
        return out
    for name in os.listdir(layout_dir):
        if not name.lower().endswith(".json"):
            continue
        if ".ambilight." in name.lower():
            continue
        base = name[:-5]
        json_path = os.path.join(layout_dir, name)
        meta = _read_sidecar_meta(json_path)
        keys = identity_keys(meta)
        # Also index filename fallback title|year from basename
        if not keys:
            keys = {f"file:{base.lower()}"}
        else:
            keys.add(f"file:{base.lower()}")
        out.append({"base": base, "keys": keys, "json_path": json_path})
    return out


def find_matches(layout_dir: str, meta: Optional[dict], index: Optional[List[dict]] = None) -> List[str]:
    """Return basenames already generated for this media."""
    want = identity_keys(meta)
    if not want:
        # Fall back to preferred basename exact file
        base = preferred_basename(meta)
        jpg = os.path.join(layout_dir or "", base + ".jpg")
        return [base] if layout_dir and os.path.exists(jpg) else []

    entries = index if index is not None else index_layout_dir(layout_dir)
    matches: List[str] = []
    for entry in entries:
        if want.intersection(entry.get("keys") or set()):
            matches.append(entry["base"])
    # Deduplicate preserving order
    seen = set()
    uniq = []
    for b in matches:
        if b not in seen:
            seen.add(b)
            uniq.append(b)
    return uniq


def delete_bases(layout_dir: str, bases: Iterable[str]) -> int:
    """Delete jpg/json/ambilight for each basename. Returns count of jpg removed."""
    removed = 0
    if not layout_dir:
        return 0
    for base in bases:
        if not base:
            continue
        for ext in (".jpg", ".json", ".ambilight.jpg"):
            path = os.path.join(layout_dir, base + ext)
            try:
                if os.path.exists(path):
                    os.remove(path)
                    if ext == ".jpg":
                        removed += 1
            except OSError:
                pass
    return removed


def delete_matches(layout_dir: str, meta: Optional[dict], index: Optional[List[dict]] = None) -> int:
    return delete_bases(layout_dir, find_matches(layout_dir, meta, index=index))


def exists_for_media(layout_dir: str, meta: Optional[dict], index: Optional[List[dict]] = None) -> bool:
    return bool(find_matches(layout_dir, meta, index=index))


def enrich_metadata_identity(meta: Optional[dict]) -> dict:
    """Attach identity_keys list onto metadata for future scans."""
    meta = dict(meta or {})
    keys = sorted(identity_keys(meta))
    meta["identity_keys"] = keys
    return meta
