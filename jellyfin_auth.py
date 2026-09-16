"""Jellyfin API auth helpers compatible with Jellyfin 12+.

Legacy headers (X-Emby-Token) and query params (api_key) are disabled by
default on Jellyfin 12. Use Authorization: MediaBrowser and ApiKey instead.
See: https://gist.github.com/nielsvanvelzen/ea047d9028f676185832e51ffaf12a6f
"""

CLIENT = "TVBackgroundSuite"
DEVICE = "Docker"
DEVICE_ID = "tv-background-suite"
VERSION = "1.1.5"


def jellyfin_headers(api_key: str) -> dict:
    """Return request headers for authenticated Jellyfin API calls."""
    return {
        "Authorization": (
            f'MediaBrowser Client="{CLIENT}", Device="{DEVICE}", '
            f'DeviceId="{DEVICE_ID}", Version="{VERSION}", Token="{api_key}"'
        )
    }


def jellyfin_image_url(base_url: str, item_id: str, image_type: str, api_key: str) -> str:
    """Build an authenticated image URL using the non-legacy ApiKey query param."""
    return f"{base_url.rstrip('/')}/Items/{item_id}/Images/{image_type}?ApiKey={api_key}"


def with_api_key(url: str, api_key: str) -> str:
    """Append ApiKey to a Jellyfin URL (handles existing query strings)."""
    sep = "&" if "?" in url else "?"
    return f"{url}{sep}ApiKey={api_key}"


def jellyfin_items_base(base_url: str, user_id: str | None = None) -> str:
    """User-scoped Items API when user_id is set; otherwise server-wide /Items."""
    base = base_url.rstrip("/")
    uid = (user_id or "").strip()
    if uid:
        return f"{base}/Users/{uid}/Items"
    return f"{base}/Items"


def resolve_jellyfin_user_id(base_url: str, api_key: str, preferred: str | None = None) -> str | None:
    """Return preferred user_id if set, else first user from /Users."""
    preferred = (preferred or "").strip()
    if preferred:
        return preferred
    try:
        import requests

        r = requests.get(
            f"{base_url.rstrip('/')}/Users",
            headers=jellyfin_headers(api_key),
            timeout=5,
        )
        r.raise_for_status()
        users = r.json() or []
        if not users:
            return None
        # Prefer an enabled admin, otherwise first account.
        for u in users:
            policy = u.get("Policy") or {}
            if policy.get("IsAdministrator") and not policy.get("IsDisabled"):
                return u.get("Id")
        return users[0].get("Id")
    except Exception:
        return None
