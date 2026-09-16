"""Seerr / Jellyseerr API client for TV Background Suite."""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import quote

import requests

# Seerr MediaStatus enum
STATUS_UNKNOWN = 1
STATUS_PENDING = 2
STATUS_PROCESSING = 3
STATUS_PARTIALLY_AVAILABLE = 4
STATUS_AVAILABLE = 5
STATUS_DELETED = 6

STATUS_LABELS = {
    STATUS_UNKNOWN: "Not in library",
    STATUS_PENDING: "Pending",
    STATUS_PROCESSING: "Processing",
    STATUS_PARTIALLY_AVAILABLE: "Partially available",
    STATUS_AVAILABLE: "Available",
    STATUS_DELETED: "Deleted",
}


def seerr_headers(api_key: str) -> Dict[str, str]:
    return {"X-Api-Key": api_key, "Accept": "application/json"}


def get_seerr_conf(config: dict) -> dict:
    """Return jellyseerr config block (shared key for Seerr + Jellyseerr)."""
    return config.get("jellyseerr") or {}


def is_configured(config: dict) -> bool:
    conf = get_seerr_conf(config)
    return bool(conf.get("url") and conf.get("api_key"))


def map_status(media_info: Optional[dict]) -> Dict[str, Any]:
    """Map Seerr mediaInfo.status to app availability fields."""
    status_code = None
    if media_info and isinstance(media_info, dict):
        status_code = media_info.get("status")
    try:
        status_code = int(status_code) if status_code is not None else STATUS_UNKNOWN
    except (TypeError, ValueError):
        status_code = STATUS_UNKNOWN

    label = STATUS_LABELS.get(status_code, "Not in library")
    in_library = status_code in (STATUS_AVAILABLE, STATUS_PARTIALLY_AVAILABLE)
    can_request = status_code in (STATUS_UNKNOWN, STATUS_DELETED)
    availability = {
        STATUS_AVAILABLE: "available",
        STATUS_PARTIALLY_AVAILABLE: "partial",
        STATUS_PENDING: "pending",
        STATUS_PROCESSING: "processing",
        STATUS_DELETED: "not_available",
        STATUS_UNKNOWN: "not_available",
    }.get(status_code, "not_available")

    return {
        "availability": availability,
        "availability_label": label,
        "seerr_status": status_code,
        "in_library": in_library,
        "can_request": can_request,
    }


def matches_availability_filter(mapped: dict, filt: str) -> bool:
    """Filter: all | available | not_available | requestable."""
    filt = (filt or "all").strip().lower()
    if filt in ("", "all"):
        return True
    if filt == "available":
        return bool(mapped.get("in_library"))
    if filt == "not_available":
        return not bool(mapped.get("in_library"))
    if filt == "requestable":
        return bool(mapped.get("can_request"))
    return True


def deep_link(base_url: str, media_type: str, tmdb_id: int) -> str:
    base = (base_url or "").rstrip("/")
    mt = "tv" if media_type in ("tv", "show", "series") else "movie"
    return f"{base}/{mt}/{tmdb_id}"


def status(base_url: str, api_key: str = "") -> dict:
    headers = seerr_headers(api_key) if api_key else {"Accept": "application/json"}
    r = requests.get(f"{base_url.rstrip('/')}/api/v1/status", headers=headers, timeout=8)
    r.raise_for_status()
    return r.json()


def trending(
    base_url: str,
    api_key: str,
    media_type: str = "all",
    time_window: str = "week",
    page: int = 1,
    language: Optional[str] = None,
) -> dict:
    params: Dict[str, Any] = {
        "page": page,
        "mediaType": media_type if media_type in ("all", "movie", "tv") else "all",
        "timeWindow": "week" if time_window == "week" else "day",
    }
    if language:
        params["language"] = language
    r = requests.get(
        f"{base_url.rstrip('/')}/api/v1/discover/trending",
        headers=seerr_headers(api_key),
        params=params,
        timeout=15,
    )
    r.raise_for_status()
    return r.json()


def media_details(base_url: str, api_key: str, media_type: str, tmdb_id: int) -> dict:
    mt = "tv" if media_type in ("tv", "show", "series") else "movie"
    r = requests.get(
        f"{base_url.rstrip('/')}/api/v1/{mt}/{int(tmdb_id)}",
        headers=seerr_headers(api_key),
        timeout=15,
    )
    r.raise_for_status()
    return r.json()


def create_request(
    base_url: str,
    api_key: str,
    media_type: str,
    media_id: int,
    seasons: Any = "all",
    is4k: bool = False,
) -> Tuple[dict, int]:
    """POST /api/v1/request. Returns (json, status_code)."""
    mt = "tv" if media_type in ("tv", "show", "series") else "movie"
    payload: Dict[str, Any] = {
        "mediaType": mt,
        "mediaId": int(media_id),
        "is4k": bool(is4k),
    }
    if mt == "tv":
        payload["seasons"] = seasons if seasons is not None else "all"

    r = requests.post(
        f"{base_url.rstrip('/')}/api/v1/request",
        headers={**seerr_headers(api_key), "Content-Type": "application/json"},
        json=payload,
        timeout=20,
    )
    try:
        body = r.json()
    except Exception:
        body = {"message": r.text}
    if r.status_code >= 400 and mt == "tv" and seasons == "all":
        # Fallback: request seasons 1+ if "all" rejected
        payload["seasons"] = list(range(1, 21))
        r2 = requests.post(
            f"{base_url.rstrip('/')}/api/v1/request",
            headers={**seerr_headers(api_key), "Content-Type": "application/json"},
            json=payload,
            timeout=20,
        )
        try:
            body2 = r2.json()
        except Exception:
            body2 = {"message": r2.text}
        return body2, r2.status_code
    return body, r.status_code


def normalize_result(item: dict, base_url: str) -> Optional[dict]:
    """Normalize a Seerr discover/movie/tv payload into a common shape."""
    if not item or not isinstance(item, dict):
        return None

    media_type = item.get("mediaType") or item.get("type")
    # movie details endpoint may not include mediaType
    if not media_type:
        if "title" in item and "name" not in item:
            media_type = "movie"
        elif "name" in item:
            media_type = "tv"
        else:
            return None
    if media_type == "person":
        return None
    if media_type not in ("movie", "tv"):
        return None

    tmdb_id = item.get("id") or item.get("tmdbId")
    if tmdb_id is None and item.get("mediaInfo"):
        tmdb_id = item["mediaInfo"].get("tmdbId")
    if tmdb_id is None:
        return None

    title = item.get("title") or item.get("name")
    year_src = item.get("releaseDate") or item.get("firstAirDate") or ""
    year = str(year_src)[:4] if year_src else None
    overview = item.get("overview") or ""
    rating = item.get("voteAverage") or item.get("vote_average")
    backdrop = item.get("backdropPath") or item.get("backdrop_path")
    poster = item.get("posterPath") or item.get("poster_path")
    media_info = item.get("mediaInfo") or {}
    mapped = map_status(media_info)

    genres = item.get("genres") or []
    if genres and isinstance(genres[0], dict):
        genre_str = ", ".join(g.get("name", "") for g in genres if g.get("name"))
    elif genres and isinstance(genres[0], str):
        genre_str = ", ".join(genres)
    else:
        genre_str = ""

    runtime = None
    if media_type == "movie":
        rt = item.get("runtime")
        if rt:
            h, m = divmod(int(rt), 60)
            runtime = f"{h}h {m}min" if h else f"{m}min"
    else:
        seasons = item.get("numberOfSeasons") or item.get("seasonCount")
        if seasons:
            runtime = f"{seasons} Season{'s' if int(seasons) != 1 else ''}"

    logo_url = None
    # Prefer TMDB logo from images if present on detail payloads
    images = item.get("images") or {}
    logos = images.get("logos") if isinstance(images, dict) else None
    if logos:
        for logo in logos:
            if logo.get("file_path") or logo.get("filePath"):
                path = logo.get("file_path") or logo.get("filePath")
                logo_url = f"https://image.tmdb.org/t/p/original{path}"
                break

    return {
        "media_type": media_type,
        "tmdb_id": int(tmdb_id),
        "title": title,
        "year": year,
        "overview": overview,
        "rating": rating,
        "genres": genre_str,
        "runtime": runtime,
        "backdrop_path": backdrop,
        "poster_path": poster,
        "logo_url": logo_url,
        "media_info": media_info,
        "seerr_url": deep_link(base_url, media_type, int(tmdb_id)),
        **mapped,
    }


def tmdb_image_url(path: Optional[str]) -> Optional[str]:
    if not path:
        return None
    if str(path).startswith("http"):
        return path
    return f"https://image.tmdb.org/t/p/original/{str(path).lstrip('/')}"


def fetch_trending_items(
    base_url: str,
    api_key: str,
    media_types: str = "Movie,Series",
    time_window: str = "week",
    availability: str = "all",
    limit: int = 50,
    language: Optional[str] = None,
) -> List[dict]:
    """Fetch and filter trending results across pages until limit."""
    want_movie = "Movie" in media_types or "movie" in media_types.lower()
    want_tv = "Series" in media_types or "tv" in media_types.lower() or "show" in media_types.lower()
    if want_movie and want_tv:
        mt = "all"
    elif want_tv:
        mt = "tv"
    else:
        mt = "movie"

    try:
        limit_n = int(limit) if limit and str(limit) != "0" else 50
    except Exception:
        limit_n = 50
    limit_n = max(1, min(limit_n, 200))

    collected: List[dict] = []
    page = 1
    total_pages = 1
    while page <= total_pages and len(collected) < limit_n and page <= 10:
        data = trending(base_url, api_key, media_type=mt, time_window=time_window, page=page, language=language)
        total_pages = int(data.get("totalPages") or data.get("total_pages") or 1)
        for raw in data.get("results") or []:
            norm = normalize_result(raw, base_url)
            if not norm:
                continue
            if norm["media_type"] == "movie" and not want_movie:
                continue
            if norm["media_type"] == "tv" and not want_tv:
                continue
            if not matches_availability_filter(norm, availability):
                continue
            collected.append(norm)
            if len(collected) >= limit_n:
                break
        page += 1
    return collected
