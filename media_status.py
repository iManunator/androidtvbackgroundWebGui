"""Shared media watch / library status normalization for editor + cron."""

from __future__ import annotations

from datetime import date, datetime
from typing import Any, Dict, Optional, Tuple

import requests

from jellyfin_auth import jellyfin_headers, jellyfin_items_base, resolve_jellyfin_user_id

PARTIAL_PERCENT = 5.0
WATCHED_PERCENT = 90.0

LIBRARY_LABELS = {
    "in_library": "In library",
    "seerr_only": "On Seerr",
    "upcoming": "Coming soon",
    "unknown": "",
}

WATCH_LABELS = {
    "unwatched": "Unwatched",
    "partially_watched": "In progress",
    "watched": "Watched",
}


def _safe_float(val: Any, default: float = 0.0) -> float:
    try:
        if val is None or val == "":
            return default
        return float(val)
    except (TypeError, ValueError):
        return default


def _safe_int(val: Any, default: int = 0) -> int:
    try:
        if val is None or val == "":
            return default
        return int(val)
    except (TypeError, ValueError):
        return default


def parse_iso_date(value: Any) -> Optional[date]:
    if not value:
        return None
    s = str(value).strip()
    if not s:
        return None
    # Accept YYYY-MM-DD or full ISO datetime
    try:
        if "T" in s:
            return datetime.fromisoformat(s.replace("Z", "+00:00")).date()
        return date.fromisoformat(s[:10])
    except ValueError:
        return None


def watch_from_userdata(user_data: Optional[dict]) -> Dict[str, Any]:
    """Map Jellyfin UserData to watch_state / watch_percent / labels."""
    ud = user_data if isinstance(user_data, dict) else {}
    played = bool(ud.get("Played"))
    percent = _safe_float(ud.get("PlayedPercentage"), 0.0)
    position = _safe_int(ud.get("PlaybackPositionTicks"), 0)

    if played or percent >= WATCHED_PERCENT:
        state = "watched"
        percent = max(percent, 100.0) if played else percent
        if percent < WATCHED_PERCENT:
            percent = 100.0
    elif position > 0 or percent >= PARTIAL_PERCENT:
        state = "partially_watched"
    else:
        state = "unwatched"
        percent = 0.0

    if state == "watched":
        label = WATCH_LABELS["watched"]
    elif state == "partially_watched":
        pct = int(round(percent))
        label = f"{pct}% watched" if pct > 0 else WATCH_LABELS["partially_watched"]
    else:
        label = WATCH_LABELS["unwatched"]

    return {
        "watch_state": state,
        "watch_percent": int(round(min(100.0, max(0.0, percent)))),
        "watch_status": label,
        "status_label": label,
    }


def empty_watch() -> Dict[str, Any]:
    return {
        "watch_state": "unwatched",
        "watch_percent": 0,
        "watch_status": "",
        "status_label": "",
    }


def library_label(library_state: str) -> str:
    return LIBRARY_LABELS.get(library_state or "unknown", "")


def jellyfin_status_fields(item: Optional[dict] = None) -> Dict[str, Any]:
    """Status fields for an in-library Jellyfin item."""
    ud = (item or {}).get("UserData") if isinstance(item, dict) else None
    watch = watch_from_userdata(ud)
    return {
        **watch,
        "library_state": "in_library",
        "library_status": LIBRARY_LABELS["in_library"],
    }


def is_upcoming(
    release_date: Any = None,
    first_air_date: Any = None,
    theatrical: Any = None,
    digital: Any = None,
) -> bool:
    today = date.today()
    for raw in (theatrical, digital, release_date, first_air_date):
        d = parse_iso_date(raw)
        if d and d > today:
            return True
    return False


def seerr_library_state(
    in_library: bool,
    release_date: Any = None,
    first_air_date: Any = None,
    theatrical: Any = None,
    digital: Any = None,
) -> Tuple[str, str]:
    """Return (library_state, library_status label) for a Seerr item."""
    if in_library:
        return "in_library", LIBRARY_LABELS["in_library"]
    if is_upcoming(release_date, first_air_date, theatrical, digital):
        return "upcoming", LIBRARY_LABELS["upcoming"]
    return "seerr_only", LIBRARY_LABELS["seerr_only"]


def apply_seerr_status(payload: dict, norm: Optional[dict] = None) -> dict:
    """Attach library_state / library_status (and empty watch if missing) to Seerr payload."""
    in_library = bool(payload.get("in_library"))
    release = (
        payload.get("release_theatrical")
        or payload.get("release_digital")
        or (norm or {}).get("release_date")
        or (norm or {}).get("first_air_date")
        or payload.get("releaseDate")
        or payload.get("firstAirDate")
    )
    state, label = seerr_library_state(
        in_library,
        release_date=release,
        first_air_date=(norm or {}).get("first_air_date") or payload.get("firstAirDate"),
        theatrical=payload.get("release_theatrical"),
        digital=payload.get("release_digital"),
    )
    payload["library_state"] = state
    payload["library_status"] = label
    if "watch_state" not in payload:
        payload.update(empty_watch())
        if state != "in_library":
            payload["watch_status"] = ""
            payload["status_label"] = label
    return payload


def matches_watch_filter(watch_state: str, filt: str) -> bool:
    """Filter: all | unwatched | in_progress | watched."""
    filt = (filt or "all").strip().lower()
    if filt in ("", "all"):
        return True
    state = (watch_state or "unwatched").strip().lower()
    if filt == "unwatched":
        return state == "unwatched"
    if filt in ("in_progress", "partially_watched", "partial"):
        return state == "partially_watched"
    if filt == "watched":
        return state == "watched"
    return True


def jellyfin_filter_param(filt: str) -> Optional[str]:
    """Jellyfin Items Filters query value for watch buckets."""
    filt = (filt or "").strip().lower()
    if filt == "unwatched":
        return "IsUnplayed"
    if filt in ("in_progress", "partially_watched", "partial"):
        return "IsResumable"
    if filt == "watched":
        return "IsPlayed"
    return None


def find_jellyfin_item_by_provider(
    config: dict,
    tmdb_id: Any = None,
    imdb_id: Any = None,
    media_type: str = "movie",
) -> Optional[dict]:
    """Resolve a Jellyfin library item by TMDB or IMDb id (includes UserData)."""
    jf = (config or {}).get("jellyfin") or {}
    if not jf.get("url") or not jf.get("api_key"):
        return None

    base_url = str(jf["url"]).rstrip("/")
    headers = jellyfin_headers(jf["api_key"])
    user_id = resolve_jellyfin_user_id(base_url, jf["api_key"], jf.get("user_id"))

    keys = []
    if tmdb_id is not None and str(tmdb_id).strip():
        keys.append(f"Tmdb.{tmdb_id}")
        keys.append(f"tmdb.{tmdb_id}")
    if imdb_id:
        keys.append(f"Imdb.{imdb_id}")
        keys.append(f"imdb.{imdb_id}")
    if not keys:
        return None

    item_types = "Series" if str(media_type).lower() in ("tv", "show", "series") else "Movie"
    fields = "UserData,ProviderIds,ImageTags,Type,Overview,Genres,CommunityRating,ProductionYear,RunTimeTicks,OfficialRating,InheritedParentalRatingValue,People,OriginalTitle,Tags,Studios"

    for key in keys:
        params = (
            f"Recursive=true&IncludeItemTypes={item_types}&ExcludeItemTypes=BoxSet"
            f"&AnyProviderIdEquals={key}&Limit=5&Fields={fields}"
        )
        url = f"{jellyfin_items_base(base_url, user_id)}?{params}"
        try:
            r = requests.get(url, headers=headers, timeout=8)
            if r.status_code != 200:
                continue
            items = r.json().get("Items") or []
            if items:
                return items[0]
        except Exception:
            continue
    return None


def enrich_with_jellyfin_watch(payload: dict, config: dict) -> dict:
    """If Seerr item is in library (or we can find it), attach Jellyfin watch fields."""
    if not payload:
        return payload
    tmdb_id = payload.get("tmdb_id")
    imdb_id = payload.get("imdb_id")
    media_type = payload.get("media_type") or "movie"
    item = find_jellyfin_item_by_provider(config, tmdb_id=tmdb_id, imdb_id=imdb_id, media_type=media_type)
    if not item:
        return payload
    watch = jellyfin_status_fields(item)
    payload.update(watch)
    payload["jellyfin_id"] = item.get("Id")
    return payload
