"""Shared media watch / library status normalization for editor + cron."""

from __future__ import annotations

from datetime import date, datetime
from typing import Any, Dict, Optional, Tuple

import requests

from jellyfin_auth import jellyfin_headers, jellyfin_items_base, resolve_jellyfin_user_id

LIBRARY_LABELS = {
    "in_library": "In library",
    "seerr_only": "On Seerr",
    "upcoming": "Coming soon",
    "unknown": "",
}

WATCH_LABELS = {
    "unwatched": "Unwatched",
    "partially_watched": "Partly watched",
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


def watch_from_userdata(
    user_data: Optional[dict],
    item_type: Optional[str] = None,
    recursive_item_count: Any = None,
) -> Dict[str, Any]:
    """Map Jellyfin UserData to watch_state / watch_percent / labels.

    Watched = fully complete (movie finished, or every episode of a series).
    Partly watched = started but not finished (e.g. half a movie, a few episodes).
    Unwatched = never started.
    """
    ud = user_data if isinstance(user_data, dict) else {}
    played = bool(ud.get("Played"))
    percent = _safe_float(ud.get("PlayedPercentage"), 0.0)
    position = _safe_int(ud.get("PlaybackPositionTicks"), 0)
    unplayed_raw = ud.get("UnplayedItemCount")
    unplayed_n = _safe_int(unplayed_raw, 0) if unplayed_raw is not None else None
    total = _safe_int(recursive_item_count, 0) if recursive_item_count is not None else 0

    kind = str(item_type or "").strip().lower()
    is_series = kind in ("series", "season")
    # Jellyfin series UserData often includes UnplayedItemCount; don't miss partial shows
    # when Type is missing from the payload.
    if not is_series and unplayed_n is not None and (total > 1 or unplayed_n > 1):
        is_series = True

    if is_series:
        # Series: never trust Played / PlayedPercentage alone.
        # Unplayed episodes always win; full watched only when UnplayedItemCount == 0.
        if unplayed_n is not None and unplayed_n > 0:
            watched_eps = max(0, total - unplayed_n) if total > 0 else 0
            has_progress = (
                watched_eps > 0
                or position > 0
                or percent > 0
                or played
            )
            if has_progress:
                state = "partially_watched"
                if total > 0:
                    percent = (watched_eps / total) * 100.0
            else:
                state = "unwatched"
                percent = 0.0
        elif unplayed_n == 0 and total > 0:
            state = "watched"
            percent = 100.0
        elif position > 0 or (0 < percent < 100):
            state = "partially_watched"
        elif played or percent >= 100:
            # Provisional — often wrong on series; caller should refine via episodes
            state = "watched"
            percent = 100.0
        else:
            state = "unwatched"
            percent = 0.0
    else:
        # Movie (and other single items): watched only when fully marked played
        if played:
            state = "watched"
            percent = 100.0
        elif position > 0 or percent > 0:
            state = "partially_watched"
        else:
            state = "unwatched"
            percent = 0.0

    return _watch_result(state, percent, is_series=is_series, total=total, unplayed_n=unplayed_n)


def _watch_result(
    state: str,
    percent: float,
    is_series: bool = False,
    total: int = 0,
    unplayed_n: Optional[int] = None,
    watched_eps: Optional[int] = None,
) -> Dict[str, Any]:
    if state == "watched":
        label = WATCH_LABELS["watched"]
    elif state == "partially_watched":
        if watched_eps is not None and total > 0:
            label = f"Partly watched ({watched_eps}/{total})"
        elif is_series and total > 0 and unplayed_n is not None:
            eps = max(0, total - unplayed_n)
            label = f"Partly watched ({eps}/{total})" if eps > 0 else WATCH_LABELS["partially_watched"]
        else:
            pct = int(round(percent))
            label = f"Partly watched ({pct}%)" if pct > 0 else WATCH_LABELS["partially_watched"]
    else:
        label = WATCH_LABELS["unwatched"]

    return {
        "watch_state": state,
        "watch_percent": int(round(min(100.0, max(0.0, percent)))),
        "watch_status": label,
        "status_label": label,
    }


def watch_from_episode_counts(watched: int, total: int, in_progress: int = 0) -> Dict[str, Any]:
    """Build watch fields from concrete episode tallies."""
    watched = max(0, int(watched or 0))
    total = max(0, int(total or 0))
    in_progress = max(0, int(in_progress or 0))
    if total <= 0:
        return empty_watch()
    if watched >= total and in_progress == 0:
        return _watch_result("watched", 100.0)
    if watched > 0 or in_progress > 0:
        percent = (watched / total) * 100.0
        return _watch_result(
            "partially_watched",
            percent,
            is_series=True,
            total=total,
            watched_eps=watched,
        )
    return empty_watch()


def fetch_series_episode_counts(
    config: dict,
    series_id: Any,
) -> Optional[Tuple[int, int, int]]:
    """Return (watched, total, in_progress) for episodes under a series, or None."""
    if not series_id:
        return None
    jf = (config or {}).get("jellyfin") or {}
    if not jf.get("url") or not jf.get("api_key"):
        return None
    base_url = str(jf["url"]).rstrip("/")
    headers = jellyfin_headers(jf["api_key"])
    user_id = resolve_jellyfin_user_id(base_url, jf["api_key"], jf.get("user_id"))
    params = (
        f"ParentId={series_id}&IncludeItemTypes=Episode&Recursive=true"
        f"&Fields=UserData&Limit=2000"
    )
    url = f"{jellyfin_items_base(base_url, user_id)}?{params}"
    try:
        r = requests.get(url, headers=headers, timeout=10)
        if r.status_code != 200:
            return None
        items = r.json().get("Items") or []
    except Exception:
        return None
    if not items:
        return None
    watched = 0
    in_progress = 0
    for ep in items:
        ud = ep.get("UserData") if isinstance(ep.get("UserData"), dict) else {}
        if bool(ud.get("Played")):
            watched += 1
            continue
        pos = _safe_int(ud.get("PlaybackPositionTicks"), 0)
        pct = _safe_float(ud.get("PlayedPercentage"), 0.0)
        if pos > 0 or pct > 0:
            in_progress += 1
    return watched, len(items), in_progress


def jellyfin_status_fields(item: Optional[dict] = None, config: Optional[dict] = None) -> Dict[str, Any]:
    """Status fields for an in-library Jellyfin item."""
    item = item if isinstance(item, dict) else {}
    ud = item.get("UserData")
    watch = watch_from_userdata(
        ud,
        item_type=item.get("Type"),
        recursive_item_count=item.get("RecursiveItemCount"),
    )

    # Series: always prefer real episode tallies over series-level UserData
    # (Played/PlayedPercentage on the series item is often wrong — e.g. "From").
    kind = str(item.get("Type") or "").strip().lower()
    if kind == "series" and config and item.get("Id"):
        counts = fetch_series_episode_counts(config, item.get("Id"))
        if counts:
            watch = watch_from_episode_counts(*counts)

    return {
        **watch,
        "library_state": "in_library",
        "library_status": LIBRARY_LABELS["in_library"],
    }


def empty_watch() -> Dict[str, Any]:
    return {
        "watch_state": "unwatched",
        "watch_percent": 0,
        "watch_status": WATCH_LABELS["unwatched"],
        "status_label": WATCH_LABELS["unwatched"],
    }


def library_label(library_state: str) -> str:
    return LIBRARY_LABELS.get(library_state or "unknown", "")


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
        # Keep a visible Unwatched chip on streaming layouts; library label stays separate
        if not payload.get("watch_status"):
            payload["watch_status"] = WATCH_LABELS["unwatched"]
            payload["watch_state"] = "unwatched"
        payload["status_label"] = label
    return payload


def attach_primary_score(payload: dict) -> dict:
    """Pick a single display score.

    Jellyfin library items prefer the Jellyfin community rating (logo + number).
    Seerr / other sources: IMDb → RT critics → TMDb → community.
    """
    if not isinstance(payload, dict):
        return payload

    def _clean(val: Any) -> Optional[str]:
        if val in (None, "", "N/A", "n/a"):
            return None
        s = str(val).strip()
        return s or None

    def _community() -> bool:
        rating = payload.get("rating")
        if rating in (None, "", "N/A"):
            return False
        try:
            label = f"{float(rating):.1f}"
        except (TypeError, ValueError):
            label = str(rating)
        payload["primary_score"] = label
        payload["primary_score_source"] = "community"
        payload["primary_score_label"] = label
        return True

    # Native Jellyfin items: always show Jellyfin community rating with Jellyfin logo
    if payload.get("source") == "Jellyfin" and _community():
        return payload

    # Seerr title that resolved to a Jellyfin library item: prefer real JF rating if present
    jf_rating = payload.get("jellyfin_rating")
    if jf_rating not in (None, "", "N/A"):
        try:
            label = f"{float(jf_rating):.1f}"
        except (TypeError, ValueError):
            label = str(jf_rating)
        payload["primary_score"] = label
        payload["primary_score_source"] = "community"
        payload["primary_score_label"] = label
        return payload

    imdb = _clean(payload.get("seerr_imdb"))
    if imdb:
        payload["primary_score"] = imdb.replace("%", "")
        payload["primary_score_source"] = "imdb"
        payload["primary_score_label"] = payload["primary_score"]
        return payload

    rt = _clean(payload.get("seerr_rt"))
    if rt:
        label = rt if "%" in rt else f"{rt}%"
        payload["primary_score"] = rt.replace("%", "")
        payload["primary_score_source"] = "rt"
        payload["primary_score_label"] = label
        return payload

    tmdb = _clean(payload.get("seerr_tmdb"))
    if tmdb:
        label = tmdb if "%" in tmdb else f"{tmdb}%"
        payload["primary_score"] = tmdb.replace("%", "")
        payload["primary_score_source"] = "tmdb"
        payload["primary_score_label"] = label
        return payload

    if _community():
        return payload

    payload.setdefault("primary_score", "")
    payload.setdefault("primary_score_source", "")
    payload.setdefault("primary_score_label", "")
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
    fields = "UserData,ProviderIds,ImageTags,Type,RecursiveItemCount,Overview,Genres,CommunityRating,ProductionYear,RunTimeTicks,OfficialRating,InheritedParentalRatingValue,People,OriginalTitle,Tags,Studios"

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
    watch = jellyfin_status_fields(item, config)
    payload.update(watch)
    payload["jellyfin_id"] = item.get("Id")
    if item.get("CommunityRating") is not None:
        payload["jellyfin_rating"] = item.get("CommunityRating")
    return payload
