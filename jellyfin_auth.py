"""Jellyfin API auth helpers compatible with Jellyfin 12+.

Legacy headers (X-Emby-Token) and query params (api_key) are disabled by
default on Jellyfin 12. Use Authorization: MediaBrowser and ApiKey instead.
See: https://gist.github.com/nielsvanvelzen/ea047d9028f676185832e51ffaf12a6f
"""

CLIENT = "TVBackgroundSuite"
DEVICE = "Docker"
DEVICE_ID = "tv-background-suite"
VERSION = "1.1.4"


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
