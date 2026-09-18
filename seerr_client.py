"""Seerr / Jellyseerr API client for TV Background Suite."""

from __future__ import annotations

import time
from typing import Any, Dict, List, Optional, Tuple

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

# TMDB release types
RELEASE_THEATRICAL_LIMITED = 2
RELEASE_THEATRICAL = 3
RELEASE_DIGITAL = 4
RELEASE_PHYSICAL = 5

_DETAIL_CACHE: Dict[str, Tuple[float, dict]] = {}
_RATINGS_CACHE: Dict[str, Tuple[float, dict]] = {}
_CACHE_TTL_SEC = 600


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
    cache_key = f"{mt}:{int(tmdb_id)}"
    now = time.time()
    cached = _DETAIL_CACHE.get(cache_key)
    if cached and (now - cached[0]) < _CACHE_TTL_SEC:
        return cached[1]
    r = requests.get(
        f"{base_url.rstrip('/')}/api/v1/{mt}/{int(tmdb_id)}",
        headers=seerr_headers(api_key),
        timeout=15,
    )
    r.raise_for_status()
    data = r.json()
    _DETAIL_CACHE[cache_key] = (now, data)
    return data


def ratings_combined(base_url: str, api_key: str, media_type: str, tmdb_id: int) -> dict:
    mt = "tv" if media_type in ("tv", "show", "series") else "movie"
    cache_key = f"{mt}:{int(tmdb_id)}"
    now = time.time()
    cached = _RATINGS_CACHE.get(cache_key)
    if cached and (now - cached[0]) < _CACHE_TTL_SEC:
        return cached[1]
    try:
        r = requests.get(
            f"{base_url.rstrip('/')}/api/v1/{mt}/{int(tmdb_id)}/ratingscombined",
            headers=seerr_headers(api_key),
            timeout=12,
        )
        data = r.json() if r.status_code == 200 and r.content else {}
    except Exception:
        data = {}
    _RATINGS_CACHE[cache_key] = (now, data)
    return data


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


def _crew_names(crew: List[dict], jobs: Tuple[str, ...]) -> List[str]:
    names: List[str] = []
    seen = set()
    for c in crew or []:
        job = (c.get("job") or "").strip()
        name = (c.get("name") or "").strip()
        if job in jobs and name and name not in seen:
            seen.add(name)
            names.append(name)
    return names


def _format_money(value: Any) -> str:
    try:
        n = int(value or 0)
    except (TypeError, ValueError):
        return ""
    if n <= 0:
        return ""
    return f"${n:,}"


def _format_date(iso: Optional[str]) -> str:
    if not iso:
        return ""
    return str(iso)[:10]


def _pick_region(config: Optional[dict]) -> str:
    conf = get_seerr_conf(config or {})
    region = (conf.get("discover_region") or conf.get("region") or "").strip().upper()
    if len(region) == 2:
        return region
    lang = ((config or {}).get("tmdb") or {}).get("language") or "en-US"
    parts = str(lang).replace("_", "-").split("-")
    if len(parts) >= 2 and len(parts[1]) == 2:
        return parts[1].upper()
    return "US"


def _release_entries(releases: Any, region: str) -> List[dict]:
    results = []
    if isinstance(releases, dict):
        results = releases.get("results") or []
    elif isinstance(releases, list):
        results = releases
    region_block = next((r for r in results if (r.get("iso_3166_1") or "").upper() == region), None)
    if not region_block:
        region_block = next((r for r in results if (r.get("iso_3166_1") or "").upper() == "US"), None)
    if not region_block and results:
        region_block = results[0]
    if not region_block:
        return []
    return region_block.get("release_dates") or region_block.get("releaseDates") or []


def _pick_release_date(entries: List[dict], types: Tuple[int, ...]) -> str:
    for t in types:
        for e in entries:
            try:
                et = int(e.get("type"))
            except (TypeError, ValueError):
                continue
            date_val = e.get("release_date") or e.get("releaseDate")
            if et == t and date_val:
                return _format_date(date_val)
    return ""


def _pick_certification(entries: List[dict]) -> str:
    for e in entries:
        cert = (e.get("certification") or "").strip()
        if cert:
            return cert
    return ""


def flatten_details(detail: dict, ratings: Optional[dict] = None, region: str = "US") -> Dict[str, Any]:
    """Flatten Seerr movie/tv detail + ratings into editor tag fields."""
    if not detail:
        return {}
    ratings = ratings or {}
    credits = detail.get("credits") or {}
    cast = credits.get("cast") or []
    crew = credits.get("crew") or []

    genres = detail.get("genres") or []
    if genres and isinstance(genres[0], dict):
        genre_list = [g.get("name") for g in genres if g.get("name")]
        genre_str = ", ".join(genre_list)
    elif genres and isinstance(genres[0], str):
        genre_list = list(genres)
        genre_str = ", ".join(genres)
    else:
        genre_list = []
        genre_str = ""

    keywords = detail.get("keywords") or []
    if keywords and isinstance(keywords[0], dict):
        keyword_list = [k.get("name") for k in keywords if k.get("name")]
    elif keywords and isinstance(keywords[0], str):
        keyword_list = list(keywords)
    else:
        keyword_list = []

    studios = [
        c.get("name")
        for c in (detail.get("productionCompanies") or detail.get("production_companies") or [])
        if c.get("name")
    ]
    countries = [
        c.get("name")
        for c in (detail.get("productionCountries") or detail.get("production_countries") or [])
        if c.get("name")
    ]

    actors = [a.get("name") for a in cast[:20] if a.get("name")]
    directors = _crew_names(crew, ("Director",))
    writers = _crew_names(crew, ("Writer", "Screenplay", "Story", "Teleplay"))
    editors = _crew_names(crew, ("Editor", "Editorial Manager"))

    media_type = "tv" if detail.get("name") and not detail.get("title") else "movie"
    if detail.get("mediaType") in ("movie", "tv"):
        media_type = detail["mediaType"]

    runtime = None
    if media_type == "movie":
        rt = detail.get("runtime")
        if rt:
            h, m = divmod(int(rt), 60)
            runtime = f"{h}h {m}min" if h else f"{m}min"
    else:
        seasons = detail.get("numberOfSeasons") or detail.get("seasonCount")
        if seasons:
            runtime = f"{seasons} Season{'s' if int(seasons) != 1 else ''}"
        else:
            ep_rt = detail.get("episodeRunTime") or detail.get("episode_run_time") or []
            if isinstance(ep_rt, list) and ep_rt and ep_rt[0]:
                runtime = f"{ep_rt[0]} min"

    year_src = detail.get("releaseDate") or detail.get("firstAirDate") or ""
    collection = detail.get("collection") or {}
    collection_name = collection.get("name") if isinstance(collection, dict) else ""

    lang = detail.get("originalLanguage") or detail.get("original_language") or ""
    spoken = detail.get("spokenLanguages") or detail.get("spoken_languages") or []
    if spoken and isinstance(spoken[0], dict):
        lang_name = spoken[0].get("englishName") or spoken[0].get("name") or lang
    else:
        lang_name = lang

    entries = _release_entries(detail.get("releases"), region)
    cert = _pick_certification(entries)
    release_theatrical = _pick_release_date(entries, (RELEASE_THEATRICAL, RELEASE_THEATRICAL_LIMITED))
    release_digital = _pick_release_date(entries, (RELEASE_DIGITAL,))
    release_physical = _pick_release_date(entries, (RELEASE_PHYSICAL,))

    rt = ratings.get("rt") or {}
    imdb = ratings.get("imdb") or {}
    seerr_rt = rt.get("criticsScore")
    seerr_rt_audience = rt.get("audienceScore")
    seerr_imdb = imdb.get("criticsScore")
    vote = detail.get("voteAverage") or detail.get("vote_average")
    seerr_tmdb = None
    if vote is not None:
        try:
            v = float(vote)
            seerr_tmdb = int(round(v * 10)) if v <= 10 else int(round(v))
        except (TypeError, ValueError):
            seerr_tmdb = None

    imdb_id = detail.get("imdbId") or detail.get("imdb_id")
    ext = detail.get("externalIds") or detail.get("external_ids") or {}
    if not imdb_id and isinstance(ext, dict):
        imdb_id = ext.get("imdbId") or ext.get("imdb_id")

    return {
        "title": detail.get("title") or detail.get("name"),
        "year": str(year_src)[:4] if year_src else None,
        "overview": detail.get("overview") or "",
        "tagline": detail.get("tagline") or "",
        "status": detail.get("status") or "",
        "collection": collection_name or "",
        "genres": genre_str,
        "genre_list": genre_list,
        "runtime": runtime,
        "actors": actors,
        "directors": directors,
        "writers": writers,
        "editors": editors,
        "keywords": keyword_list,
        "studios": studios,
        "countries": countries,
        "language": lang_name or "",
        "budget": _format_money(detail.get("budget")),
        "revenue": _format_money(detail.get("revenue")),
        "certification": cert,
        "officialRating": cert,
        "release_theatrical": release_theatrical,
        "release_digital": release_digital,
        "release_physical": release_physical,
        "seerr_rt": str(seerr_rt) if seerr_rt is not None else "",
        "seerr_rt_audience": str(seerr_rt_audience) if seerr_rt_audience is not None else "",
        "seerr_imdb": str(seerr_imdb) if seerr_imdb is not None else "",
        "seerr_tmdb": str(seerr_tmdb) if seerr_tmdb is not None else "",
        "rating": vote,
        "imdb_id": imdb_id,
        "backdrop_path": detail.get("backdropPath") or detail.get("backdrop_path"),
        "poster_path": detail.get("posterPath") or detail.get("poster_path"),
        "media_info": detail.get("mediaInfo") or {},
    }


def enrich_item(
    base_url: str,
    api_key: str,
    media_type: str,
    tmdb_id: int,
    config: Optional[dict] = None,
) -> Dict[str, Any]:
    """Fetch Seerr details + ratings and return flattened tag fields."""
    region = _pick_region(config)
    try:
        detail = media_details(base_url, api_key, media_type, tmdb_id)
    except Exception:
        detail = {}
    try:
        ratings = ratings_combined(base_url, api_key, media_type, tmdb_id)
    except Exception:
        ratings = {}
    flat = flatten_details(detail, ratings, region=region)
    flat["media_type"] = "tv" if media_type in ("tv", "show", "series") else "movie"
    flat["tmdb_id"] = int(tmdb_id)
    if detail:
        mapped = map_status(detail.get("mediaInfo"))
        flat.update(mapped)
        flat["seerr_url"] = deep_link(base_url, flat["media_type"], int(tmdb_id))
    return flat


def normalize_result(item: dict, base_url: str) -> Optional[dict]:
    """Normalize a Seerr discover/movie/tv payload into a common shape."""
    if not item or not isinstance(item, dict):
        return None

    media_type = item.get("mediaType") or item.get("type")
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
        "release_date": item.get("releaseDate") or item.get("release_date") or "",
        "first_air_date": item.get("firstAirDate") or item.get("first_air_date") or "",
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
