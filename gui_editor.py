CURRENT_VERSION = "1.6.2"
import os
import sys
import json
import random
import traceback
import io
import requests
import time
import base64
import shutil
import re
import uuid
import threading
import subprocess
from datetime import datetime, timedelta
from flask import Blueprint, render_template, request, jsonify, send_from_directory, url_for, send_file, Response
from PIL import Image
from urllib.parse import quote

# Prevent Python from generating .pyc files and __pycache__ folders
sys.dont_write_bytecode = True

# --- IMPORT IMAGE ENGINE ---
from image_engine import ImageGenerator
from jellyfin_auth import (
    jellyfin_headers,
    jellyfin_image_url,
    jellyfin_items_base,
    resolve_jellyfin_user_id,
)
import seerr_client
import media_status
import gallery_dedupe

# Import the missing search trigger script
try:
    import trigger_missing
except ImportError:
    trigger_missing = None

# Blueprint Setup
gui_editor_bp = Blueprint('gui_editor', __name__)
CONFIG_FILE = 'config.json'
BATCH_LOGS = []

# Global to track latest image for preview
LATEST_GENERATED_IMAGE = None

# Global to track running cron process
CRON_PROCESS = None

# Initialize Image Generator for Proxy Processing
image_gen = ImageGenerator()

# --- METADATA CACHE MANAGER (In-Memory) ---
METADATA_CACHE = {"genres": set(), "ages": set(), "years": set(), "images": []}
METADATA_CACHE_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'metadata_cache.json')
CACHE_SAVE_TIMER = None

def _save_metadata_cache_now():
    """Writes the cache to disk."""
    try:
        data = {
            "genres": sorted(list(METADATA_CACHE["genres"])),
            "ages": sorted(list(METADATA_CACHE["ages"])),
            "years": sorted(list(METADATA_CACHE["years"])),
            "images": METADATA_CACHE["images"]
        }
        with open(METADATA_CACHE_FILE, 'w', encoding='utf-8') as f:
            json.dump(data, f, indent=4, ensure_ascii=False)
        print("Metadata cache saved to disk.")
    except Exception as e:
        print(f"Error saving metadata cache: {e}")

def _meta_str(metadata, *keys):
    for key in keys:
        val = metadata.get(key)
        if val is None or val == "":
            continue
        return str(val).strip()
    return ""


def _wallpaper_mtime(filepath):
    """Best-effort mtime from jpg sibling or the metadata json itself."""
    if not filepath:
        return 0.0
    candidates = []
    if filepath.lower().endswith(".json"):
        candidates.append(filepath[:-5] + ".jpg")
        candidates.append(filepath)
    else:
        candidates.append(filepath)
        candidates.append(os.path.splitext(filepath)[0] + ".json")
    for path in candidates:
        try:
            if os.path.exists(path):
                return float(os.path.getmtime(path))
        except OSError:
            continue
    return 0.0


def _normalize_source(source):
    s = str(source or "").strip().lower()
    if not s:
        return ""
    if "jellyfin" in s:
        return "jellyfin"
    if "jellyseerr" in s or s == "seerr" or "seerr" in s:
        return "jellyseerr"
    if "plex" in s:
        return "plex"
    if "tmdb" in s:
        return "tmdb"
    return s


def _merge_metadata_to_cache(metadata, filepath=None, layout_name=None):
    """Merges new metadata into the in-memory sets."""
    if not metadata: return
    
    # Genres (comma separated string)
    genres_str = metadata.get('genres', '')
    if genres_str:
        parts = [g.strip() for g in genres_str.split(',') if g.strip()]
        METADATA_CACHE["genres"].update(parts)
        
    # Ages (OfficialRating)
    rating = metadata.get('officialRating')
    if rating:
        METADATA_CACHE["ages"].add(str(rating).strip())
        
    # Years
    year = metadata.get('year')
    if year:
        METADATA_CACHE["years"].add(str(year).strip())
        
    # Update Image Inventory (if path provided)
    if filepath and layout_name:
        # Remove existing entry for this file if exists (to allow updates)
        METADATA_CACHE["images"] = [img for img in METADATA_CACHE["images"] if img['path'] != filepath]
        
        # Parse Rating (Try different fields)
        rating = 0.0
        for field in ['rating', 'CommunityRating', 'VoteAverage', 'OfficialRating']:
            val = metadata.get(field)
            if val is not None:
                try:
                    rating = float(val)
                    break
                except: pass

        source_raw = _meta_str(metadata, 'source')
        jellyfin_id = _meta_str(metadata, 'jellyfin_id')
        item_id = _meta_str(metadata, 'id', 'Id')
        if not jellyfin_id and item_id and _normalize_source(source_raw) == "jellyfin":
            jellyfin_id = item_id
        
        image_entry = {
            "path": filepath,
            "layout": layout_name,
            "genres": metadata.get('genres', ''),
            "officialRating": metadata.get('officialRating', ''),
            "year": metadata.get('year'),
            "rating": rating,
            "title": metadata.get('title'),
            "action_url": metadata.get('action_url'),
            "mtime": _wallpaper_mtime(filepath),
            "watch_state": _meta_str(metadata, 'watch_state', 'watch_status'),
            "library_state": _meta_str(metadata, 'library_state'),
            "source": source_raw,
            "source_norm": _normalize_source(source_raw),
            "availability": _meta_str(metadata, 'availability'),
            "jellyfin_id": jellyfin_id,
            "tmdb_id": _meta_str(metadata, 'tmdb_id'),
        }
        METADATA_CACHE["images"].append(image_entry)

def update_metadata_cache(new_metadata, filepath=None, layout_name=None):
    """Updates the cache and schedules a debounced save."""
    global CACHE_SAVE_TIMER
    _merge_metadata_to_cache(new_metadata, filepath, layout_name)
    
    # Debounce save (wait 5 seconds before writing to disk to save I/O)
    if CACHE_SAVE_TIMER:
        CACHE_SAVE_TIMER.cancel()
    
    CACHE_SAVE_TIMER = threading.Timer(5.0, _save_metadata_cache_now)
    CACHE_SAVE_TIMER.start()

def _scan_and_rebuild_cache():
    """Scans all JSONs and rebuilds the cache. Returns number of files scanned."""
    global METADATA_CACHE
    METADATA_CACHE = {"genres": set(), "ages": set(), "years": set(), "images": []}
    
    print("Building/Rebuilding metadata cache from files...")
    base_path = os.path.dirname(os.path.abspath(__file__))
    target_dir = os.path.join(base_path, 'editor_backgrounds')
    
    scanned_files = 0
    if os.path.exists(target_dir):
        for root, dirs, files in os.walk(target_dir):
            for file in files:
                if file.endswith('.json') and file != 'status.json':
                    try:
                        with open(os.path.join(root, file), 'r', encoding='utf-8') as f:
                            data = json.load(f)
                            
                            # Determine Layout Name from folder structure
                            rel_path = os.path.relpath(root, target_dir)
                            layout_name = "Default"
                            if rel_path != ".":
                                layout_name = rel_path.split(os.sep)[0]
                                
                            _merge_metadata_to_cache(data.get('metadata', {}), os.path.join(root, file), layout_name)
                            scanned_files += 1
                    except Exception as e:
                        print(f"Warning: Could not parse {os.path.join(root, file)}. Error: {e}")
    
    _save_metadata_cache_now()
    print(f"Cache build/rebuild complete. Scanned {scanned_files} files.")
    return scanned_files

def initialize_metadata_cache():
    """Loads cache from disk or rebuilds it from files on startup."""
    global METADATA_CACHE
    if os.path.exists(METADATA_CACHE_FILE):
        try:
            with open(METADATA_CACHE_FILE, 'r', encoding='utf-8') as f:
                data = json.load(f)
                METADATA_CACHE["genres"] = set(data.get("genres", []))
                METADATA_CACHE["ages"] = set(data.get("ages", []))
                METADATA_CACHE["years"] = set(data.get("years", []))
                METADATA_CACHE["images"] = data.get("images", [])
                print("Loaded metadata cache from disk.")
                return
        except Exception as e:
            print(f"Error loading metadata cache, rebuilding from scratch. Error: {e}")

    # Fallback: Scan all JSONs if cache file missing
    _scan_and_rebuild_cache()

# Initialize on module load (Container Start)
initialize_metadata_cache()
# ------------------------------------------

KNOWN_DIRS = [
    "layouts",
    "editor_backgrounds",
    "plex_backgrounds",
    "jellyfin_backgrounds",
    "trakt_backgrounds",
    "radarrsonarr_backgrounds",
    "tmdb_backgrounds",
    "plexfriend_backgrounds"
]

LAYOUTS_DIR = 'layouts'
LAYOUT_BUNDLED_DIR = os.path.join(LAYOUTS_DIR, 'bundled')
LAYOUT_PREVIEWS_DIR = os.path.join(LAYOUTS_DIR, 'previews')
LAYOUT_PRESET_VERSION = 4
MANAGED_LAYOUT_NAMES = {
    "Default",
    "Netflix Hero",
    "Prime Cinematic",
    "Google TV Clean",
    "Status Focus",
    "Jellyfin Dense",
}
OVERLAYS_DIR = 'overlays'
OVERLAYS_JSON = 'overlays.json'
TEXTURES_DIR = 'textures'
TEXTURES_JSON = 'textures.json'
FONTS_DIR = 'fonts'
CUSTOM_ICONS_DIR = 'custom_icons'

if not os.path.exists(LAYOUTS_DIR):
    os.makedirs(LAYOUTS_DIR)
if not os.path.exists(LAYOUT_PREVIEWS_DIR):
    os.makedirs(LAYOUT_PREVIEWS_DIR)
if not os.path.exists(OVERLAYS_DIR):
    os.makedirs(OVERLAYS_DIR)
if not os.path.exists(TEXTURES_DIR):
    os.makedirs(TEXTURES_DIR)
if not os.path.exists(FONTS_DIR):
    os.makedirs(FONTS_DIR)
if not os.path.exists(CUSTOM_ICONS_DIR):
    os.makedirs(CUSTOM_ICONS_DIR)


def seed_bundled_layouts():
    """Copy/upgrade managed streaming presets from layouts/bundled into layouts/."""
    if not os.path.isdir(LAYOUT_BUNDLED_DIR):
        return
    for fname in os.listdir(LAYOUT_BUNDLED_DIR):
        if not fname.endswith(".json"):
            continue
        name = fname[:-5]
        if name not in MANAGED_LAYOUT_NAMES:
            continue
        src = os.path.join(LAYOUT_BUNDLED_DIR, fname)
        dst = os.path.join(LAYOUTS_DIR, fname)
        try:
            with open(src, "r", encoding="utf-8") as f:
                bundled = json.load(f)
        except Exception as e:
            print(f"Skip bundled layout {fname}: {e}")
            continue
        bundled_ver = int(bundled.get("layout_preset_version") or LAYOUT_PRESET_VERSION)
        existing_ver = -1
        missing_watch = False
        if os.path.exists(dst):
            try:
                with open(dst, "r", encoding="utf-8") as f:
                    existing = json.load(f)
                # Only auto-upgrade managed names (or files already marked managed)
                if name in MANAGED_LAYOUT_NAMES or existing.get("managed_preset"):
                    existing_ver = int(existing.get("layout_preset_version") or 0)
                    tags = [
                        o.get("dataTag")
                        for o in (existing.get("objects") or [])
                        if isinstance(o, dict)
                    ]
                    missing_watch = "watch_status" not in tags
                else:
                    continue
            except Exception:
                existing_ver = 0
                missing_watch = True
        if bundled_ver > existing_ver or not os.path.exists(dst) or missing_watch:
            try:
                shutil.copy2(src, dst)
                print(f"Seeded layout preset: {name} (v{bundled_ver})")
            except Exception as e:
                print(f"Failed seeding {name}: {e}")


seed_bundled_layouts()

# --- CONFIGURATION LOGIC ---
def load_config():
    defaults = {
        "general": {"overwrite_existing": False, "timezone_offset": 1},
        "jellyfin": {"url": "", "api_key": "", "user_id": "", "excluded_libraries": ""},
        "plex": {"url": "", "token": ""},
        "tmdb": {"api_key": "", "language": "de-DE"},
        "radarr": {"url": "", "api_key": ""},
        "sonarr": {"url": "", "api_key": ""},
        "jellyseerr": {
            "url": "",
            "api_key": "",
            "trending_window": "week",
            "default_request_seasons": "all",
        },
        "trakt": {"api_key": "", "username": "", "listname": ""},
        "omdb": {"api_key": ""},
        "editor": {"resolution": "1080"},
        "cron": {"enabled": False, "start_time": "00:00", "frequency": "1"}
    }

    if os.path.exists(CONFIG_FILE):
        with open(CONFIG_FILE, 'r') as f:
            try:
                loaded = json.load(f)
                for key, value in loaded.items():
                    if key in defaults and isinstance(defaults[key], dict) and isinstance(value, dict):
                        defaults[key].update(value)
                    else:
                        defaults[key] = value
            except:
                pass
    return defaults

def save_config(config_data):
    with open(CONFIG_FILE, 'w') as f:
        json.dump(config_data, f, indent=4)

def clean_tmdb_url(path):
    """ Safely constructs a TMDB image URL from a path. """
    if not path:
        return None
    if path.startswith("http"):
        return path
    return f"https://image.tmdb.org/t/p/original/{path.lstrip('/')}"

# --- API ROUTES ---


@gui_editor_bp.route('/api/proxy/image')
def proxy_image():
    """ Proxies an image URL to bypass CORS/CORB blocks. """
    url = request.args.get('url')
    raw = request.args.get('raw', 'false').lower() == 'true'
    if not url:
        return "Missing URL", 400
    try:
        headers = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"}
        # Jellyfin image URLs may still need Authorization even with ApiKey in query
        # (and browsers cannot send that header on <img>/fabric loads).
        try:
            from urllib.parse import urlparse, parse_qs
            parsed = urlparse(url)
            qs = parse_qs(parsed.query)
            token = (qs.get('ApiKey') or qs.get('api_key') or [None])[0]
            if token and '/Items/' in parsed.path and '/Images/' in parsed.path:
                headers.update(jellyfin_headers(token))
        except Exception:
            pass
        resp = requests.get(url, headers=headers, timeout=10)
        
        if resp.status_code != 200:
            return f"Upstream Error: {resp.status_code}", resp.status_code
            
        # Check if this is likely a logo (PNG or contains 'logo' in path)
        # This prevents processing backdrops (JPGs) which would turn white if dark.
        is_likely_logo = 'logo' in url.lower() or url.lower().endswith('.png')
        
        if is_likely_logo and not raw:
            try:
                img = Image.open(io.BytesIO(resp.content))
                # Apply the contrast logic from image_engine.py
                img = image_gen.ensure_high_contrast(img)
                output = io.BytesIO()
                img.save(output, format='PNG')
                output.seek(0)
                return send_file(output, mimetype='image/png')
            except Exception as e:
                print(f"Error processing proxy image: {e}")

        return send_file(
            io.BytesIO(resp.content),
            mimetype=resp.headers.get('Content-Type') or 'image/jpeg'
        )
    except requests.exceptions.RequestException as e:
        print(f"Proxy Connection Error for {url}: {e}", file=sys.stderr)
        return str(e), 502
    except Exception as e:
        print(f"Proxy Error for {url}: {e}", file=sys.stderr)
        traceback.print_exc()
        return str(e), 500

# --- NEW: Server-Side Generation Example ---
@gui_editor_bp.route('/api/generate_preview_server', methods=['POST'])
def generate_preview_server():
    """
    Example of using the ImageEngine to generate an image server-side.
    This keeps the main file clean and logic isolated.
    """
    data = request.json
    
    # Initialize Engine (Loads fonts/backgrounds once)
    engine = ImageGenerator()
    
    # Simulate getting an image (in reality you'd download it from data['backdrop_url'])
    # For demo, we use the base background as a placeholder for artwork
    artwork = engine.base_bg 
    
    # 1. Create Canvas
    engine.create_canvas(artwork)
    
    # 2. Draw Elements (Dynamic Layout happens automatically inside)
    engine.draw_logo_or_title(title_text=data.get('title', 'No Title'))
    engine.draw_info_text(f"{data.get('year')} • {data.get('rating')}")
    engine.draw_summary(data.get('overview', ''))
    engine.draw_custom_text_and_provider_logo("Preview Generated by Engine", "jellyfinlogo.png")
    
    # 3. Return Image
    return send_file(engine.get_bytes(), mimetype='image/jpeg')

# --- CACHED METADATA ROUTES ---
@gui_editor_bp.route('/api/genres/list')
def list_genres_cached():
    # Reads strictly from RAM
    return jsonify(sorted(list(METADATA_CACHE["genres"])))

@gui_editor_bp.route('/api/ages/list')
def list_ages_cached():
    # Reads strictly from RAM
    return jsonify(sorted(list(METADATA_CACHE["ages"])))

@gui_editor_bp.route('/api/year/list')
def list_years_cached():
    # Reads strictly from RAM
    return jsonify(sorted(list(METADATA_CACHE["years"]), reverse=True))

@gui_editor_bp.route('/api/ratings/list')
def list_ratings_cached():
    # Extract unique integer ratings on the fly from the image list
    rating_levels = set()
    for img in METADATA_CACHE["images"]:
        r = img.get('rating', 0)
        if r > 0:
            rating_levels.add(int(r))
    return jsonify(sorted(list(rating_levels), reverse=True))

@gui_editor_bp.route('/api/cache/rebuild', methods=['POST'])
def rebuild_cache_endpoint():
    """API endpoint to manually trigger a cache rebuild from all image JSONs."""
    try:
        count = _scan_and_rebuild_cache()
        
        # Extract unique integer ratings for display (e.g. 7 for 7.0-7.9)
        rating_levels = set()
        for img in METADATA_CACHE["images"]:
            r = img.get('rating', 0)
            if r > 0:
                rating_levels.add(int(r))
                
        return jsonify({
            "status": "success", 
            "message": f"Cache rebuilt successfully from {count} files.",
            "genres": sorted(list(METADATA_CACHE["genres"])),
            "ages": sorted(list(METADATA_CACHE["ages"])),
            "years": sorted(list(METADATA_CACHE["years"]), reverse=True),
            "ratings": sorted(list(rating_levels), reverse=True)
        })
    except Exception as e:
        print(f"Error during manual cache rebuild: {e}")
        return jsonify({"status": "error", "message": str(e)}), 500

# --- HELPER FUNCTIONS FOR SEASON COUNT ---
def get_jellyfin_season_count(server_url, item_id, user_id, api_key):
    """Holt die echte Anzahl der Staffeln (ohne Specials/S0) für Jellyfin."""
    try:
        url = f"{server_url}/Shows/{item_id}/Seasons?userId={user_id}&Fields=IndexNumber"
        headers = jellyfin_headers(api_key)
        r = requests.get(url, headers=headers, timeout=5)
        if r.status_code == 200:
            items = r.json().get('Items', [])
            # Zähle alles, wo IndexNumber nicht 0 ist
            count = sum(1 for i in items if i.get('IndexNumber') != 0)
            return count
    except Exception as e:
        print(f"Error fetching Jellyfin seasons: {e}")
    return 0

def get_plex_season_count(server_url, rating_key, token):
    """Holt die echte Anzahl der Staffeln (ohne Specials/S0) für Plex."""
    try:
        url = f"{server_url}/library/metadata/{rating_key}/children"
        headers = {"X-Plex-Token": token, "Accept": "application/json"}
        r = requests.get(url, headers=headers, timeout=5)
        if r.status_code == 200:
            # Plex Container -> Metadata enthält die Staffeln
            metadata = r.json().get('MediaContainer', {}).get('Metadata', [])
            # Zähle alles, wo index nicht 0 ist (Plex nutzt 'index' für Staffelnummer)
            count = sum(1 for s in metadata if int(s.get('index', 0)) != 0)
            return count
    except Exception as e:
        print(f"Error fetching Plex seasons: {e}")
    return 0

def _jellyfin_tmdb_id(item: dict):
    pids = item.get("ProviderIds") or {}
    if not isinstance(pids, dict):
        return None
    for key in ("Tmdb", "tmdb", "TmdbId", "TMDB"):
        if pids.get(key) not in (None, ""):
            try:
                return int(str(pids.get(key)).strip())
            except (TypeError, ValueError):
                continue
    return None


def _jellyfin_media_type(item: dict) -> str:
    t = (item.get("Type") or "").lower()
    if t in ("series", "season", "episode", "tv"):
        return "tv"
    return "movie"


# Seerr/TMDB metadata keys to merge onto Jellyfin payloads (never overwrite watch/library/source/art).
_SEERR_META_KEYS = (
    "tagline", "status", "collection", "genre_list", "writers", "editors", "keywords",
    "countries", "language", "budget", "revenue", "certification",
    "release_theatrical", "release_digital", "release_physical",
    "seerr_rt", "seerr_rt_audience", "seerr_imdb", "seerr_tmdb",
    "tmdb_id", "media_type", "seerr_url",
)


def enrich_jellyfin_with_seerr(payload: dict, item: dict, config: dict = None) -> dict:
    """Fill Seerr Info fields on a Jellyfin item using TMDB id via Seerr API."""
    if not payload or not config:
        return payload
    conf = seerr_client.get_seerr_conf(config)
    if not conf.get("url") or not conf.get("api_key"):
        return payload

    tid = payload.get("tmdb_id") or _jellyfin_tmdb_id(item)
    if tid is None:
        pids = payload.get("provider_ids") or {}
        if isinstance(pids, dict):
            for key in ("Tmdb", "tmdb"):
                if pids.get(key) not in (None, ""):
                    try:
                        tid = int(str(pids.get(key)).strip())
                        break
                    except (TypeError, ValueError):
                        pass
    if tid is None:
        return payload

    mt = payload.get("media_type") or _jellyfin_media_type(item)
    try:
        enriched = seerr_client.enrich_item(conf["url"], conf["api_key"], mt, int(tid), config) or {}
    except Exception as e:
        print(f"Jellyfin Seerr enrich error: {e}")
        return payload

    if not enriched:
        return payload

    payload["tmdb_id"] = int(tid)
    payload["media_type"] = "tv" if mt in ("tv", "show", "series") else "movie"

    for key in _SEERR_META_KEYS:
        val = enriched.get(key)
        if val in (None, "", [], {}):
            continue
        # Don't blank existing jellyfin values with empties; prefer enriched for Seerr-specific keys
        if key.startswith("seerr_") or key in (
            "tagline", "collection", "release_theatrical", "release_digital", "release_physical",
            "budget", "revenue", "language", "writers", "editors", "keywords", "countries", "genre_list",
        ):
            payload[key] = val
        elif not payload.get(key):
            payload[key] = val

    # Fill genres string from genre_list if missing/weak
    if enriched.get("genre_list") and (not payload.get("genres") or payload.get("genres") == ""):
        payload["genres"] = ", ".join(enriched["genre_list"])
    elif enriched.get("genres") and not payload.get("genres"):
        payload["genres"] = enriched["genres"]

    # Prefer Seerr cast/crew lists when Jellyfin People was empty
    for list_key in ("actors", "directors", "studios"):
        if enriched.get(list_key) and not payload.get(list_key):
            payload[list_key] = enriched[list_key]

    if enriched.get("officialRating") and not payload.get("officialRating"):
        payload["officialRating"] = enriched["officialRating"]
    if enriched.get("certification") and not payload.get("certification"):
        payload["certification"] = enriched["certification"]
    if enriched.get("imdb_id") and not payload.get("imdb_id"):
        payload["imdb_id"] = enriched["imdb_id"]

    # Keep Jellyfin as source of truth for art, watch, library
    return payload


def format_jellyfin_item(item, clean_url, api_key, user_id=None, config=None):
    # Check for Logo availability
    has_logo = 'Logo' in item.get('ImageTags', {})
    logo_url = jellyfin_image_url(clean_url, item['Id'], 'Logo', api_key) if has_logo else None

    # Default Runtime logic
    ticks = item.get('RunTimeTicks', 0)
    minutes = (ticks // 600000000) if ticks else 0
    h, m = divmod(minutes, 60)
    runtime_str = f"{h}h {m}min" if h > 0 else f"{m}min"

    # --- NEU: Override Runtime with Season Count for Series ---
    if item.get('Type') == 'Series' and user_id:
        season_count = get_jellyfin_season_count(clean_url, item['Id'], user_id, api_key)
        if season_count > 0:
            runtime_str = f"{season_count} Season{'s' if season_count != 1 else ''}"
    # ----------------------------------------------------------

    # Extract Actors and Directors from People
    people = item.get('People', [])
    actors = [p.get('Name') for p in people if p.get('Type') == 'Actor']
    
    # Director extraction: Check Type='Director' first, fall back to Type='Writer'
    directors = list(dict.fromkeys(
        p.get('Name') for p in people if p.get('Type') == 'Director'
    ))
    if not directors:
        directors = list(dict.fromkeys(
            p.get('Name') for p in people if p.get('Type') == 'Writer'
        ))

    writers = list(dict.fromkeys(
        p.get('Name') for p in people if p.get('Type') == 'Writer'
    ))

    status = media_status.jellyfin_status_fields(item, config)
    tmdb_id = _jellyfin_tmdb_id(item)
    payload = {
        "id": item.get('Id'),
        "title": item.get('Name'),
        "original_title": item.get('OriginalTitle'),
        "year": item.get('ProductionYear'),
        "rating": item.get('CommunityRating'),
        "overview": item.get('Overview', ''),
        "genres": ", ".join(item.get('Genres', [])),
        "tags": item.get('Tags', []),
        "actors": actors,
        "directors": directors,
        "writers": writers,
        "studios": [s.get('Name') for s in item.get('Studios', [])],
        "provider_ids": item.get('ProviderIds', {}),
        "runtime": runtime_str,
        "backdrop_url": jellyfin_image_url(clean_url, item['Id'], 'Backdrop', api_key),
        "logo_url": logo_url,
        "officialRating": item.get('OfficialRating'),
        "inheritedParentalRatingValue": item.get('InheritedParentalRatingValue'),
        "imdb_id": item.get('ProviderIds', {}).get('Imdb'),
        "tmdb_id": tmdb_id,
        "media_type": _jellyfin_media_type(item),
        "source": "Jellyfin",
        **status,
    }
    payload = enrich_jellyfin_with_seerr(payload, item, config)
    return media_status.attach_primary_score(payload)


def fetch_jellyfin_list(config, filter_mode, filter_val, item_types, limit_count, request_args):
    jf = config.get('jellyfin', {})
    if not jf.get('url') or not jf.get('api_key'): return []
    
    headers = jellyfin_headers(jf['api_key'])
    jf_url = str(jf.get('url', '')).rstrip('/')
    clean_url = jf_url

    
    excluded_libs = jf.get('excluded_libraries', "")
    excluded_list = [x.strip() for x in excluded_libs.split(',') if x.strip()]
    excluded_paths = []
    if excluded_list:
        try:
            r_libs = requests.get(f"{clean_url}/Library/VirtualFolders", headers=headers, timeout=5)
            if r_libs.status_code == 200:
                libs = r_libs.json()
                for lib in libs:
                    if lib.get('Name') in excluded_list:
                        excluded_paths.extend(lib.get('Locations', []))
        except: pass

    base_params = f"Recursive=true&IncludeItemTypes={item_types}&ExcludeItemTypes=BoxSet&Fields=Name,Path,OfficialRating,InheritedParentalRatingValue"
    if limit_count and limit_count != '0':
        base_params += f"&Limit={limit_count}"
    else:
        base_params += "&Limit=100000"
    sort_params = "&SortBy=SortName"
    
    if filter_mode == 'recent':
        sort_params = "&SortBy=DateCreated&SortOrder=Descending"
    elif filter_mode == 'year':
        sort_params = f"&SortBy=SortName&Years={filter_val}"
    elif filter_mode == 'genre':
        sort_params = f"&SortBy=SortName&Genres={filter_val}"
    elif filter_mode == 'rating':
        sort_params = f"&SortBy=CommunityRating&SortOrder=Descending&MinCommunityRating={filter_val}"
    elif filter_mode == 'custom':
        min_year = request_args.get('min_year')
        max_year = request_args.get('max_year')
        min_rating = request_args.get('min_rating')
        genre = request_args.get('genre')
        c_params = []
        if min_year or max_year:
            try:
                start = int(min_year) if min_year else 1900
                end = int(max_year) if max_year else datetime.now().year
                years_str = ",".join(str(y) for y in range(min(start, end), max(start, end) + 1))
                c_params.append(f"Years={years_str}")
            except: pass
        if min_rating: c_params.append(f"MinCommunityRating={min_rating}")
        if genre: c_params.append(f"Genres={genre}")
        if c_params: sort_params += "&" + "&".join(c_params)

    url = f"{jellyfin_items_base(clean_url, jf.get('user_id'))}?{base_params}{sort_params}"
    try:
        r = requests.get(url, headers=headers, timeout=10)
        r.raise_for_status()
        items = r.json().get('Items', [])
        valid = []
        for item in items:
            if excluded_paths and item.get('Path') and any(ex in item['Path'] for ex in excluded_paths):
                continue
            if filter_mode == 'official_rating':
                f_val = str(filter_val).strip().lower()
                i_rating = item.get('InheritedParentalRatingValue')
                o_rating = str(item.get('OfficialRating', '') or '').lower()
                match = False
                if f_val.isdigit():
                    if i_rating is not None and int(i_rating) == int(f_val): match = True
                    elif f_val in re.findall(r'\d+', o_rating): match = True
                else:
                    f_norm = "".join(c for c in f_val if c.isalnum())
                    o_norm = "".join(c for c in o_rating if c.isalnum())
                    if f_norm and f_norm in o_norm: match = True
                if not match: continue
            valid.append({"Id": f"jellyfin-{item['Id']}", "Name": item['Name']})
        return valid
    except: return []

def fetch_plex_list(config, filter_mode, filter_val, item_types, limit_count):
    p = config.get('plex', {})
    if not p.get('url') or not p.get('token'): return []
    url = str(p.get('url', '')).rstrip('/')

    token = p['token']
    headers = {"Accept": "application/json"}
    try:
        r_sections = requests.get(f"{url}/library/sections?X-Plex-Token={token}", headers=headers, timeout=5)
        if r_sections.status_code != 200: return []
        sections = r_sections.json().get('MediaContainer', {}).get('Directory', [])
        valid = []
        plex_types = []
        if 'Movie' in item_types: plex_types.append('movie')
        if 'Series' in item_types: plex_types.append('show')
        for s in sections:
            if s.get('type') in plex_types:
                sid = s.get('key')
                # Basic fetch for now - complex filtering can be added later
                r_items = requests.get(f"{url}/library/sections/{sid}/all?X-Plex-Token={token}", headers=headers, timeout=10)
                if r_items.status_code == 200:
                    items = r_items.json().get('MediaContainer', {}).get('Metadata', [])
                    for item in items:
                        valid.append({"Id": f"plex-{item.get('ratingKey')}", "Name": item.get('title')})
        if limit_count and limit_count != '0':
            return valid[:int(limit_count)]
        return valid
    except: return []

def fetch_trakt_list(config):
    t = config.get('trakt', {})
    if not t.get('api_key') or not t.get('username') or not t.get('listname'): return []
    url = f"https://api.trakt.tv/users/{t['username']}/lists/{t['listname']}/items"
    headers = {"Content-Type": "application/json", "trakt-api-version": "2", "trakt-api-key": t['api_key']}
    try:
        r = requests.get(url, headers=headers, timeout=10)
        if r.status_code == 200:
            items = r.json()
            valid = []
            for it in items:
                mtype = it['type']
                media = it.get(mtype)
                if media and media.get('ids', {}).get('tmdb'):
                    valid.append({"Id": f"trakt-{mtype}-{media['ids']['tmdb']}", "Name": media.get('title')})
            return valid
    except: return []

def fetch_sonarr_list(config, filter_mode='all'):
    s = config.get('sonarr', {})
    if not s.get('url') or not s.get('api_key'): return []
    headers = {"X-Api-Key": s['api_key']}

    # --- Handle 'Missing' Filter Mode ---
    if filter_mode == 'missing':
        url = f"{str(s.get('url', '')).rstrip('/')}/api/v3/wanted/missing"
        params = {
            "page": 1,
            "pageSize": 1000, # Fetch a larger chunk for the UI list
            "sortKey": "airDateUtc",
            "sortDir": "desc"
        }
        try:
            r = requests.get(url, headers=headers, params=params, timeout=10)
            if r.status_code == 200:
                data = r.json()
                records = data.get('records', [])
                valid = []
                seen_series = set()
                for item in records:
                    series = item.get('series', {})
                    sid = series.get('id')
                    if sid and sid not in seen_series:
                        valid.append({"Id": f"sonarr-{sid}-missing", "Name": series.get('title')})
                        seen_series.add(sid)
                return valid
        except: pass
        return []
    # ------------------------------------

    url = f"{str(s.get('url', '')).rstrip('/')}/api/v3/calendar"
    # Fetch calendar for next 30 days
    params = {
        "start": datetime.utcnow().date().isoformat(),
        "end": (datetime.utcnow() + timedelta(days=30)).date().isoformat()
    }
    try:
        r = requests.get(url, headers=headers, params=params, timeout=10)
        if r.status_code == 200:
            episodes = r.json()
            valid = []
            seen_series = set()
            for ep in episodes:
                series = ep.get('series', {})
                sid = series.get('id')
                if sid and sid not in seen_series:
                    valid.append({"Id": f"sonarr-{sid}", "Name": series.get('title')})
                    seen_series.add(sid)
            return valid
    except: pass
    return []

def fetch_radarr_list(config, filter_mode='all'):
    r_conf = config.get('radarr', {})
    if not r_conf.get('url') or not r_conf.get('api_key'): return []
    headers = {"X-Api-Key": r_conf['api_key']}

    # --- Handle 'Missing' Filter Mode ---
    if filter_mode == 'missing':
        url = f"{r_conf['url'].rstrip('/')}/api/v3/wanted/missing"
        params = {"page": 1, "pageSize": 1000, "sortKey": "releaseDate", "sortDir": "desc"}
        try:
            r = requests.get(url, headers=headers, params=params, timeout=10)
            if r.status_code == 200:
                data = r.json()
                records = data.get('records', [])
                valid = []
                for m in records:
                    valid.append({"Id": f"radarr-{m['id']}-missing", "Name": m.get('title')})
                return valid
        except: pass
        return []
    # ------------------------------------

    url = f"{r_conf['url'].rstrip('/')}/api/v3/movie"
    try:
        r = requests.get(url, headers=headers, timeout=10)
        if r.status_code == 200:
            movies = r.json()
            # Sort by added date or similar? Radarr doesn't have a simple "upcoming" API like Sonarr calendar
            # but we can filter by 'monitored' and 'hasFile'==False for "upcoming"
            valid = []
            for m in movies:
                valid.append({"Id": f"radarr-{m['id']}", "Name": m.get('title')})
            return valid
    except: pass
    return []

def format_seerr_item(norm: dict, config: dict = None) -> dict:
    """Turn normalized Seerr item into editor media payload (full Seerr details)."""
    if not norm:
        return {}
    config = config or {}
    conf = seerr_client.get_seerr_conf(config)
    mt = norm.get("media_type") or "movie"
    tid = norm.get("tmdb_id")

    enriched = {}
    if conf.get("url") and conf.get("api_key") and tid is not None:
        try:
            enriched = seerr_client.enrich_item(conf["url"], conf["api_key"], mt, int(tid), config) or {}
        except Exception as e:
            print(f"Seerr enrich error: {e}")
            enriched = {}

    # Merge: enriched details win for metadata; keep list-level availability if richer
    merged = {**norm, **{k: v for k, v in enriched.items() if v not in (None, "", [], {})}}
    # Prefer enriched lists even when empty was overwritten incorrectly
    for list_key in ("actors", "directors", "writers", "editors", "keywords", "studios", "countries", "genre_list"):
        if enriched.get(list_key):
            merged[list_key] = enriched[list_key]
    for str_key in (
        "tagline", "status", "collection", "genres", "language", "budget", "revenue",
        "certification", "officialRating", "release_theatrical", "release_digital", "release_physical",
        "seerr_rt", "seerr_rt_audience", "seerr_imdb", "seerr_tmdb", "runtime", "overview", "imdb_id",
    ):
        if enriched.get(str_key) not in (None, ""):
            merged[str_key] = enriched[str_key]

    backdrop = seerr_client.tmdb_image_url(merged.get("backdrop_path") or norm.get("backdrop_path"))
    backdrop = backdrop or seerr_client.tmdb_image_url(merged.get("poster_path") or norm.get("poster_path"))
    logo_url = merged.get("logo_url") or norm.get("logo_url")

    # Clearlogo still from TMDB images API (Seerr details don't include logos)
    if not logo_url:
        logo_url = fetch_tmdb_logo_url(str(tid), mt, config)
    if not backdrop:
        try:
            details = fetch_tmdb_details(str(tid), mt, config)
            if details.get("backdrop_url"):
                backdrop = details["backdrop_url"]
            if details.get("logo_url") and not logo_url:
                logo_url = details["logo_url"]
        except Exception:
            pass

    avail = merged.get("availability") or "not_available"
    if avail == "available" or avail == "partial":
        source = "Seerr"
    elif avail in ("pending", "processing"):
        source = "Seerr Pending"
    else:
        source = "Seerr Requestable"

    genres = merged.get("genres") or ""
    if not genres and merged.get("genre_list"):
        genres = ", ".join(merged["genre_list"])

    payload = {
        "id": f"jellyseerr-{mt}-{tid}",
        "title": merged.get("title"),
        "year": merged.get("year"),
        "rating": merged.get("rating"),
        "overview": merged.get("overview") or "",
        "tagline": merged.get("tagline") or "",
        "status": merged.get("status") or "",
        "collection": merged.get("collection") or "",
        "genres": genres,
        "genre_list": merged.get("genre_list") or [],
        "actors": merged.get("actors") or [],
        "directors": merged.get("directors") or [],
        "writers": merged.get("writers") or [],
        "editors": merged.get("editors") or [],
        "keywords": merged.get("keywords") or [],
        "studios": merged.get("studios") or [],
        "countries": merged.get("countries") or [],
        "language": merged.get("language") or "",
        "budget": merged.get("budget") or "",
        "revenue": merged.get("revenue") or "",
        "runtime": merged.get("runtime"),
        "certification": merged.get("certification") or "",
        "officialRating": merged.get("officialRating") or merged.get("certification") or "",
        "release_theatrical": merged.get("release_theatrical") or "",
        "release_digital": merged.get("release_digital") or "",
        "release_physical": merged.get("release_physical") or "",
        "seerr_rt": merged.get("seerr_rt") or "",
        "seerr_rt_audience": merged.get("seerr_rt_audience") or "",
        "seerr_imdb": merged.get("seerr_imdb") or "",
        "seerr_tmdb": merged.get("seerr_tmdb") or "",
        "backdrop_url": backdrop,
        "logo_url": logo_url,
        "imdb_id": merged.get("imdb_id"),
        "provider_ids": {"Tmdb": str(tid)},
        "source": source,
        "availability": avail,
        "availability_label": merged.get("availability_label"),
        "seerr_status": merged.get("seerr_status"),
        "in_library": merged.get("in_library"),
        "can_request": merged.get("can_request"),
        "seerr_url": merged.get("seerr_url") or norm.get("seerr_url"),
        "action_url": merged.get("seerr_url") or norm.get("seerr_url"),
        "media_type": mt,
        "tmdb_id": tid,
        "releaseDate": merged.get("releaseDate") or norm.get("release_date") or norm.get("releaseDate"),
        "firstAirDate": merged.get("firstAirDate") or norm.get("first_air_date") or norm.get("firstAirDate"),
    }
    media_status.apply_seerr_status(payload, norm)
    # Only cross-link Jellyfin when Seerr reports in-library (avoids false JF logo on Seerr-only)
    if payload.get("in_library") or payload.get("library_state") == "in_library":
        try:
            media_status.enrich_with_jellyfin_watch(payload, config)
        except Exception as e:
            print(f"Seerr Jellyfin watch enrich error: {e}")
    return media_status.attach_primary_score(payload)


def fetch_seerr_list(config, filter_mode, filter_val, item_types, limit_count, request_args=None):
    conf = seerr_client.get_seerr_conf(config)
    if not conf.get("url") or not conf.get("api_key"):
        return []
    request_args = request_args or {}
    # mode=trending (or source_mode) uses discover/trending
    mode = (filter_mode or "trending").lower()
    if mode in ("all", "library", "recent", "year", "genre", "rating", "custom", "official_rating"):
        mode = "trending"
    time_window = (
        request_args.get("seerr_time_window")
        or conf.get("trending_window")
        or "week"
    )
    availability = request_args.get("seerr_availability") or filter_val or "all"
    if mode == "trending" and filter_val in ("available", "not_available", "requestable", "all"):
        availability = filter_val
    lang = (config.get("tmdb") or {}).get("language")
    try:
        items = seerr_client.fetch_trending_items(
            conf["url"],
            conf["api_key"],
            media_types=item_types or "Movie,Series",
            time_window=time_window,
            availability=availability,
            limit=limit_count or 50,
            language=lang,
        )
        return [
            {"Id": f"jellyseerr-{it['media_type']}-{it['tmdb_id']}", "Name": it.get("title") or f"{it['media_type']}-{it['tmdb_id']}"}
            for it in items
        ]
    except Exception as e:
        print(f"Seerr list error: {e}")
        return []


def fetch_tmdb_list(config, limit_count):
    t = config.get('tmdb', {})
    api_key = t.get('api_key')
    if not api_key: return []
    
    # Fetch Trending items from TMDB
    url = f"https://api.themoviedb.org/3/trending/all/week?api_key={api_key}"
    try:
        r = requests.get(url, timeout=10)
        if r.status_code == 200:
            results = r.json().get('results', [])
            valid = []
            for item in results:
                media_type = item.get('media_type', 'movie')
                if media_type not in ['movie', 'tv']: continue
                title = item.get('title') or item.get('name')
                valid.append({"Id": f"tmdb-{media_type}-{item['id']}", "Name": title})
            
            if limit_count and str(limit_count) != '0':
                return valid[:int(limit_count)]
            return valid
    except: pass
    return []


@gui_editor_bp.route('/api/media/random')
def get_random_media():
    config = load_config()
    provider = (request.args.get('provider') or request.args.get('providers') or 'jellyfin').split(',')[0].strip().lower()
    if provider == 'seerr':
        provider = 'jellyseerr'

    # Prefer Seerr when explicitly requested
    if provider == 'jellyseerr':
        if not seerr_client.is_configured(config):
            return jsonify({"error": "Seerr is not configured (URL + API key)"}), 400
        conf = seerr_client.get_seerr_conf(config)
        try:
            items = seerr_client.fetch_trending_items(
                conf["url"],
                conf["api_key"],
                media_types=request.args.get('types', 'Movie,Series'),
                time_window=request.args.get('seerr_time_window') or conf.get('trending_window') or 'week',
                availability=request.args.get('seerr_availability') or 'all',
                limit=request.args.get('limit', 40),
                language=(config.get('tmdb') or {}).get('language'),
            )
            if items:
                return jsonify(format_seerr_item(random.choice(items), config))
            return jsonify({"error": "No Seerr trending items found"}), 404
        except Exception as e:
            print(f"DEBUG: Seerr random error: {e}")
            return jsonify({"error": f"Seerr error: {e}"}), 500

    if provider == 'tmdb':
        tmdb_items = fetch_tmdb_list(config, 40)
        if tmdb_items:
            pick = random.choice(tmdb_items)
            # Id like tmdb-movie-123
            return get_media_item(pick['Id'])
        return jsonify({"error": "No TMDB items (check API key)"}), 404

    jf = config.get('jellyfin', {})
    excluded_libs = jf.get('excluded_libraries', "")
    excluded_list = [x.strip() for x in excluded_libs.split(',') if x.strip()]
    
    if provider in ('jellyfin', 'plex') and jf.get('url') and jf.get('api_key') and provider == 'jellyfin':
        headers = jellyfin_headers(jf['api_key'])
        clean_url = jf['url'].rstrip('/')
        user_id = resolve_jellyfin_user_id(clean_url, jf['api_key'], jf.get('user_id'))
        
        excluded_paths = []
        if excluded_list:
            try:
                r_libs = requests.get(f"{clean_url}/Library/VirtualFolders", headers=headers, timeout=5)
                if r_libs.status_code == 200:
                    libs = r_libs.json()
                    for lib in libs:
                        if lib.get('Name') in excluded_list:
                            excluded_paths.extend(lib.get('Locations', []))
            except Exception as e:
                print(f"Error fetching libraries: {e}")

        url = (
            f"{jellyfin_items_base(clean_url, user_id)}"
            "?Recursive=true&IncludeItemTypes=Movie,Series&ExcludeItemTypes=BoxSet"
            "&SortBy=Random&Limit=50"
            "&Fields=Type,Overview,Genres,CommunityRating,ProductionYear,RunTimeTicks,"
            "ImageTags,Path,ProviderIds,OfficialRating,InheritedParentalRatingValue,People,UserData,RecursiveItemCount"
        )
        
        try:
            r = requests.get(url, headers=headers, timeout=5)
            r.raise_for_status()
            items = r.json().get('Items', [])
            
            valid_items = []
            for item in items:
                if item.get('Type') == 'BoxSet':
                    continue
                if excluded_paths and item.get('Path') and any(ex in item['Path'] for ex in excluded_paths):
                    continue
                valid_items.append(item)
            
            if valid_items:
                item = random.choice(valid_items)
                return jsonify(format_jellyfin_item(item, clean_url, jf['api_key'], user_id, config))
        except Exception as e:
            print(f"DEBUG: Jellyfin Error: {e}")
            if provider == 'jellyfin':
                return jsonify({"error": f"Jellyfin error: {e}"}), 500

    if provider == 'plex':
        p = config.get('plex', {})
        if p.get('url') and p.get('token'):
            try:
                items = fetch_plex_list(config, 'all', '', 'Movie,Series', 50)
                if items:
                    return get_media_item(random.choice(items)['Id'])
            except Exception as e:
                return jsonify({"error": f"Plex error: {e}"}), 500
        return jsonify({"error": "Plex is not configured"}), 400

    # Fallback: Seerr trending if configured (only when provider wasn't an explicit failed path)
    if provider == 'jellyfin' and seerr_client.is_configured(config):
        conf = seerr_client.get_seerr_conf(config)
        try:
            items = seerr_client.fetch_trending_items(
                conf["url"], conf["api_key"], limit=30,
                time_window=conf.get("trending_window") or "week",
                language=(config.get("tmdb") or {}).get("language"),
            )
            if items:
                return jsonify(format_seerr_item(random.choice(items), config))
        except Exception as e:
            print(f"DEBUG: Seerr fallback error: {e}")

    # Fallback Data
    mock_samples = [
        {"title": "Interstellar", "year": 2014, "rating": 8.7, "overview": "Ein Team von Entdeckern nutzt ein neu entdecktes Wurmloch, um die Grenzen der menschlichen Raumfahrt zu überwinden und die weiten Entfernungen einer interstellaren Reise zu bewältigen.", "backdrop_url": clean_tmdb_url("/5XNQBqnBwPA9yT0jZ0p3s8bbLh0.jpg"), "logo_url": clean_tmdb_url("/eJjFbfeOuZPuPJFnDP3YJ5daSsg.png")},
        {"title": "The Dark Knight", "year": 2008, "rating": 9.0, "overview": "Batman zieht im Kampf gegen das Verbrechen die Daumenschrauben an. Mit der Hilfe von Lieutenant Jim Gordon und Staatsanwalt Harvey Dent setzt er sein Vorhaben fort, die organisierten Verbrecherorganisationen in Gotham endgültig zu zerschlagen.", "backdrop_url": clean_tmdb_url("/6fA9nie4ROlkyZAUlgKNjGNCbHG.jpg"), "logo_url": clean_tmdb_url("/hdtvO84iZVAk848CoJmLMMTsQ9i.png")}
    ]
    sample = random.choice(mock_samples)
    sample["source"] = "Demo Mode"
    
    # Prevent browser caching of the random endpoint to ensure new URLs are loaded
    response = jsonify(sample)
    response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
    return response

@gui_editor_bp.route('/api/media/list')
def get_media_list():
    config = load_config()
    filter_mode = request.args.get('mode', 'all')
    filter_val = request.args.get('val', '')
    item_types = request.args.get('types', 'Movie,Series')
    limit_count = request.args.get('limit', '0')
    providers = request.args.get('providers', 'jellyfin').split(',')
    
    # If mode is 'missing', restrict providers to *arrs only.
    # Jellyfin/Plex/Trakt do not support 'missing' logic in this context and would return existing items.
    if filter_mode == 'missing':
        allowed_missing_providers = ['sonarr', 'radarr']
        providers = [p for p in providers if p.strip().lower() in allowed_missing_providers]

    all_items = []
    for p in providers:
        p = p.strip().lower()
        if p == 'jellyfin':
            all_items.extend(fetch_jellyfin_list(config, filter_mode, filter_val, item_types, limit_count, request.args))
        elif p == 'plex':
            all_items.extend(fetch_plex_list(config, filter_mode, filter_val, item_types, limit_count))
        elif p == 'trakt':
            all_items.extend(fetch_trakt_list(config))
        elif p == 'sonarr':
            all_items.extend(fetch_sonarr_list(config, filter_mode))
        elif p == 'radarr':
            all_items.extend(fetch_radarr_list(config, filter_mode))
        elif p == 'tmdb':
            all_items.extend(fetch_tmdb_list(config, limit_count))
        elif p in ('jellyseerr', 'seerr'):
            all_items.extend(fetch_seerr_list(config, filter_mode, filter_val, item_types, limit_count, request.args))
            
    return jsonify(all_items)



@gui_editor_bp.route('/api/media/search')
def search_media():
    query = request.args.get('q')
    if not query: return jsonify([])
    
    config = load_config()
    jf = config.get('jellyfin', {})
    if not jf.get('url') or not jf.get('api_key'): return jsonify([])
    
    headers = jellyfin_headers(jf['api_key'])
    clean_url = jf['url'].rstrip('/')
    user_id = resolve_jellyfin_user_id(clean_url, jf['api_key'], jf.get('user_id'))
    url = (
        f"{jellyfin_items_base(clean_url, user_id)}"
        f"?Recursive=true&IncludeItemTypes=Movie,Series&ExcludeItemTypes=BoxSet"
        f"&SearchTerm={query}&Limit=10&Fields=Name,ProductionYear"
    )
    
    try:
        r = requests.get(url, headers=headers, timeout=5)
        r.raise_for_status()
        return jsonify(r.json().get('Items', []))
    except:
        return jsonify([])

def format_plex_item(item, base_url, token):
    # Check for Logo (clearLogo)
    logo_url = f"{base_url}/library/metadata/{item.get('ratingKey')}/clearLogo?X-Plex-Token={token}"
    
    # Plex duration is in milliseconds
    duration_ms = item.get('duration', 0)
    h, m = divmod(duration_ms // 60000, 60)
    runtime_str = f"{h}h {m}min" if h > 0 else f"{m}min"
    
    # --- NEU: Override Runtime with Season Count for Shows ---
    if item.get('type') == 'show':
        season_count = get_plex_season_count(base_url, item.get('ratingKey'), token)
        if season_count > 0:
            runtime_str = f"{season_count} Season{'s' if season_count > 1 else ''}"
    # ---------------------------------------------------------
    
    genres = [g.get('tag') for g in item.get('Genre', [])]
    actors = [r.get('tag') for r in item.get('Role', [])]
    directors = [d.get('tag') for d in item.get('Director', [])]
    if not directors:
        directors = [w.get('tag') for w in item.get('Writer', [])]

    return {
        "id": f"plex-{item.get('ratingKey')}",
        "title": item.get('title'),
        "original_title": item.get('originalTitle'),
        "year": item.get('year'),
        "rating": item.get('rating') or item.get('audienceRating'),
        "overview": item.get('summary', ''),
        "genres": ", ".join(genres),
        "tags": [],
        "actors": actors,
        "directors": directors,
        "studios": [item.get('studio')] if item.get('studio') else [],
        "provider_ids": {}, 
        "runtime": runtime_str,
        "backdrop_url": f"{base_url}/library/metadata/{item.get('ratingKey')}/art?X-Plex-Token={token}",
        "logo_url": logo_url,
        "officialRating": item.get('contentRating'),
        "source": "Plex"
    }

# Public TMDB v3 key shipped by Seerr/Overseerr (GitHub). Used only when the user
# has not configured their own key, so Seerr shuffle can still resolve clearlogos.
_TMDB_FALLBACK_API_KEY = "431a8708161bcd1f1fbe7536137e61ed"


def resolve_tmdb_api_key(config):
    t = (config or {}).get("tmdb") or {}
    return (t.get("api_key") or "").strip() or _TMDB_FALLBACK_API_KEY


def pick_tmdb_logo_path(logos, language="en-US"):
    """Prefer configured language, then English, then null-lang, then any; PNG over SVG."""
    if not logos:
        return None
    lang = (language or "en").split("-")[0].lower()

    def score(logo):
        iso = (logo.get("iso_639_1") or "").lower()
        path = logo.get("file_path") or ""
        lang_score = 0
        if iso == lang:
            lang_score = 3
        elif iso == "en":
            lang_score = 2
        elif not iso:
            lang_score = 1
        png_score = 1 if path.lower().endswith(".png") else 0
        votes = float(logo.get("vote_average") or 0)
        return (lang_score, png_score, votes)

    best = max(logos, key=score)
    return best.get("file_path")


def fetch_tmdb_logo_url(tmdb_id, media_type, config):
    """Lightweight logo-only lookup for Seerr / TMDB enrichment."""
    api_key = resolve_tmdb_api_key(config)
    if not api_key or not tmdb_id:
        return None
    mt = "tv" if str(media_type) in ("tv", "show", "series") else "movie"
    lang = ((config or {}).get("tmdb") or {}).get("language") or "en-US"
    try:
        r = requests.get(
            f"https://api.themoviedb.org/3/{mt}/{int(tmdb_id)}/images",
            params={"api_key": api_key, "include_image_language": f"{lang.split('-')[0]},en,null"},
            timeout=5,
        )
        if r.status_code != 200:
            return None
        path = pick_tmdb_logo_path(r.json().get("logos") or [], lang)
        return f"https://image.tmdb.org/t/p/original{path}" if path else None
    except Exception:
        return None


def fetch_tmdb_details(tmdb_id, media_type, config):
    t = config.get('tmdb', {})
    api_key = resolve_tmdb_api_key(config)
    if not api_key: return {}
    
    lang = t.get('language', 'en-US')
    base_url = "https://api.themoviedb.org/3"
    
    try:
        # 1. Main Details
        r = requests.get(f"{base_url}/{media_type}/{tmdb_id}?api_key={api_key}&language={lang}", timeout=5)
        if r.status_code != 200: return {}
        data = r.json()
        
        # Extract IMDb ID
        imdb_id = data.get('imdb_id')
        if not imdb_id and media_type == 'tv':
            try:
                r_ext = requests.get(f"{base_url}/tv/{tmdb_id}/external_ids?api_key={api_key}", timeout=5)
                if r_ext.status_code == 200:
                    imdb_id = r_ext.json().get('imdb_id')
            except: pass

        # 2. Images (for Logo) — prefer UI language, then English
        logo_url = None
        r_img = requests.get(
            f"{base_url}/{media_type}/{tmdb_id}/images",
            params={"api_key": api_key, "include_image_language": f"{lang.split('-')[0]},en,null"},
            timeout=5,
        )
        if r_img.status_code == 200:
            logo_path = pick_tmdb_logo_path(r_img.json().get('logos', []), lang)
            if logo_path:
                logo_url = f"https://image.tmdb.org/t/p/original{logo_path}"
                
        # 3. Credits (for Actors/Directors)
        r_credits = requests.get(f"{base_url}/{media_type}/{tmdb_id}/credits?api_key={api_key}", timeout=5)
        credits = r_credits.json() if r_credits.status_code == 200 else {}
        
        actors = [a.get('name') for a in credits.get('cast', [])[:10]]
        directors = [d.get('name') for d in credits.get('crew', []) if d.get('job') == 'Director']
        
        runtime = ""
        if media_type == 'movie':
            rt = data.get('runtime', 0)
            h, m = divmod(rt, 60)
            runtime = f"{h}h {m}min" if h > 0 else f"{m}min"
        else:
            ep_rt = data.get('episode_run_time', [0])[0]
            runtime = f"{ep_rt} min"
            
        return {
            "id": f"trakt-{media_type}-{tmdb_id}",
            "title": data.get('title') or data.get('name'),
            "imdb_id": imdb_id,
            "original_title": data.get('original_title') or data.get('original_name'),
            "year": (data.get('release_date') or data.get('first_air_date') or "")[:4],
            "rating": data.get('vote_average'),
            "overview": data.get('overview', ''),
            "genres": ", ".join([g.get('name') for g in data.get('genres', [])]),
            "actors": actors,
            "directors": directors,
            "runtime": runtime,
            "backdrop_url": f"https://image.tmdb.org/t/p/original{data.get('backdrop_path')}" if data.get('backdrop_path') else None,
            "logo_url": logo_url,
            "source": "Trakt/TMDB"
        }
    except: return {}

@gui_editor_bp.route('/api/media/item/<path:item_id>')
def get_media_item(item_id):
    config = load_config()
    
    provider = "jellyfin"
    actual_id = item_id
    if "-" in item_id:
        parts = item_id.split("-")
        provider = parts[0]
        actual_id = "-".join(parts[1:])

    if provider == "jellyfin":
        jf = config.get('jellyfin', {})
        if jf.get('url') and jf.get('api_key'):
            headers = jellyfin_headers(jf['api_key'])
            clean_url = str(jf.get('url', '')).rstrip('/')
            user_id = resolve_jellyfin_user_id(clean_url, jf['api_key'], jf.get('user_id'))

            if user_id:
                url = (
                    f"{clean_url}/Users/{user_id}/Items/{actual_id}"
                    "?Fields=Type,Overview,Genres,CommunityRating,ProductionYear,RunTimeTicks,"
                    "ImageTags,Path,ProviderIds,OfficialRating,InheritedParentalRatingValue,People,UserData,RecursiveItemCount"
                )
            else:
                url = (
                    f"{clean_url}/Items/{actual_id}"
                    "?Fields=Type,Overview,Genres,CommunityRating,ProductionYear,RunTimeTicks,"
                    "ImageTags,Path,ProviderIds,OfficialRating,InheritedParentalRatingValue,People,UserData,RecursiveItemCount"
                )
            try:
                r = requests.get(url, headers=headers, timeout=5)
                r.raise_for_status()
                return jsonify(format_jellyfin_item(r.json(), clean_url, jf['api_key'], user_id, config))
            except Exception as e:
                return jsonify({"error": str(e)}), 500

    elif provider in ("jellyseerr", "seerr"):
        # actual_id is movie-123 or tv-123
        parts = actual_id.split("-")
        if len(parts) >= 2:
            mtype = parts[0]
            tmdb_id = parts[1]
            conf = seerr_client.get_seerr_conf(config)
            if not conf.get("url") or not conf.get("api_key"):
                return jsonify({"error": "Seerr not configured"}), 400
            try:
                detail = seerr_client.media_details(conf["url"], conf["api_key"], mtype, int(tmdb_id))
                norm = seerr_client.normalize_result(detail, conf["url"])
                if not norm:
                    # Discover payloads differ; synthesize from detail + mediaInfo
                    detail["mediaType"] = "tv" if mtype in ("tv", "show") else "movie"
                    detail["id"] = int(tmdb_id)
                    norm = seerr_client.normalize_result(detail, conf["url"])
                if not norm:
                    return jsonify({"error": "Unable to normalize Seerr item"}), 500
                return jsonify(format_seerr_item(norm, config))
            except Exception as e:
                return jsonify({"error": str(e)}), 500
                
    elif provider == "plex":
        p = config.get('plex', {})
        if p.get('url') and p.get('token'):
            url = str(p.get('url', '')).rstrip('/')

            token = p['token']
            # Fetch metadata for ratingKey
            headers = {"Accept": "application/json"}
            try:
                r = requests.get(f"{url}/library/metadata/{actual_id}?X-Plex-Token={token}", headers=headers, timeout=5)
                r.raise_for_status()
                meta = r.json().get('MediaContainer', {}).get('Metadata', [{}])[0]
                return jsonify(format_plex_item(meta, url, token))
            except Exception as e:
                return jsonify({"error": str(e)}), 500
                
    elif provider == "trakt":
        # Trakt IDs are formatted as "trakt-type-tmdbid" (media listing returns this)
        parts = actual_id.split("-")
        if len(parts) >= 2:
            mtype = parts[0] # 'movie' or 'show' (or 'tv')
            if mtype == 'show': mtype = 'tv' # TMDB uses 'tv'
            tmdb_id = parts[1]
            return jsonify(fetch_tmdb_details(tmdb_id, mtype, config))

    elif provider == "sonarr":
        s = config.get('sonarr', {})
        if not s.get('url') or not s.get('api_key'): return jsonify({"error": "Sonarr not configured"}), 400
        
        is_missing = False
        if actual_id.endswith("-missing"):
            actual_id = actual_id.replace("-missing", "")
            is_missing = True
            
        url = f"{s['url'].rstrip('/')}/api/v3/series/{actual_id}"
        headers = {"X-Api-Key": s['api_key']}
        try:
            r = requests.get(url, headers=headers, timeout=10)
            if r.status_code == 200:
                series = r.json()
                tvdb_id = series.get('tvdbId')
                if tvdb_id:
                    # Resolve TMDB ID from TVDB
                    tmdb_api_key = config.get('tmdb', {}).get('api_key')
                    if tmdb_api_key:
                        find_url = f"https://api.themoviedb.org/3/find/{tvdb_id}?api_key={tmdb_api_key}&external_source=tvdb_id"
                        r_tmdb = requests.get(find_url, timeout=5)
                        if r_tmdb.status_code == 200:
                            results = r_tmdb.json().get('tv_results', [])
                            if results:
                                tmdb_id = results[0]['id']
                                details = fetch_tmdb_details(tmdb_id, 'tv', config)
                                if details:
                                    details['source'] = "Sonarr Missing" if is_missing else "Sonarr"
                                    return jsonify(details)
                # Fallback if no TMDB match
                return jsonify({
                    "id": f"sonarr-{actual_id}",
                    "title": series.get('title'),
                    "overview": series.get('overview', ''),
                    "year": series.get('year'),
                    "source": "Sonarr Missing" if is_missing else "Sonarr"
                })
        except: pass

    elif provider == "radarr":
        r_conf = config.get('radarr', {})
        if not r_conf.get('url') or not r_conf.get('api_key'): return jsonify({"error": "Radarr not configured"}), 400
        
        is_missing = False
        if actual_id.endswith("-missing"):
            actual_id = actual_id.replace("-missing", "")
            is_missing = True
            
        url = f"{r_conf['url'].rstrip('/')}/api/v3/movie/{actual_id}"
        headers = {"X-Api-Key": r_conf['api_key']}
        try:
            r = requests.get(url, headers=headers, timeout=10)
            if r.status_code == 200:
                movie = r.json()
                tmdb_id = movie.get('tmdbId')
                if tmdb_id:
                    details = fetch_tmdb_details(tmdb_id, 'movie', config)
                    if details:
                        details['source'] = "Radarr Missing" if is_missing else "Radarr"
                        return jsonify(details)
                # Fallback
                return jsonify({
                    "id": f"radarr-{actual_id}",
                    "title": movie.get('title'),
                    "overview": movie.get('overview', ''),
                    "year": movie.get('year'),
                    "source": "Radarr Missing" if is_missing else "Radarr"
                })
        except: pass
        
    elif provider == "tmdb":
        # ID format: tmdb-type-id
        parts = actual_id.split("-")
        if len(parts) >= 2:
            mtype = parts[0]
            tmdb_id = parts[1]
            details = fetch_tmdb_details(tmdb_id, mtype, config)
            if details:
                details['source'] = "TMDB"
                return jsonify(details)

    return jsonify({"error": f"Provider {provider} or Item not found"}), 400



@gui_editor_bp.route('/api/settings', methods=['POST'])
def update_settings():
    global CRON_PROCESS
    config_data = request.json
    save_config(config_data)
    
    # Check if any job needs immediate execution
    jobs = config_data.get('cron_jobs', [])
    should_run = any(j.get('force_run') for j in jobs)
    
    if should_run:
        # Spawn cron_runner.py in background to handle the forced job
        # We use sys.executable to ensure we use the same python interpreter
        script_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'cron_runner.py')
        CRON_PROCESS = subprocess.Popen([sys.executable, script_path])
        
    return jsonify({"status": "success"})

@gui_editor_bp.route('/api/settings_full')
def get_settings_full():
    return jsonify(load_config())

@gui_editor_bp.route('/api/cron/log', methods=['POST'])
def receive_cron_log():
    data = request.json
    msg = data.get('message')
    if msg:
        try:
            config = load_config()
            offset = int(config.get('general', {}).get('timezone_offset', 1))
            now = datetime.utcnow() + timedelta(hours=offset)
            timestamp = now.strftime("%H:%M:%S")
        except:
            timestamp = time.strftime("%H:%M:%S")
        BATCH_LOGS.append(f"[{timestamp}] {msg}")
        # Keep log size manageable
        if len(BATCH_LOGS) > 1000:
            BATCH_LOGS.pop(0)
    return jsonify({"status": "success"})

@gui_editor_bp.route('/api/cron/stop', methods=['POST'])
def stop_cron_jobs():
    global CRON_PROCESS
    killed = False
    
    # 1. Try killing the child process we spawned directly
    if CRON_PROCESS:
        try:
            CRON_PROCESS.terminate()
            time.sleep(0.5)
            if CRON_PROCESS.poll() is None:
                CRON_PROCESS.kill()
            killed = True
        except: pass
        CRON_PROCESS = None
        
    # 2. System-wide kill (fallback for jobs started via system cron)
    try:
        if os.name != 'nt':
            ret = os.system("pkill -f cron_runner.py")
            if ret == 0: killed = True
    except: pass
            
    return jsonify({"status": "success", "message": "Stop signal sent" if killed else "No running jobs found"})

@gui_editor_bp.route('/api/batch/logs/clear', methods=['POST'])
def clear_batch_logs():
    global BATCH_LOGS
    BATCH_LOGS = []
    return jsonify({"status": "success"})

@gui_editor_bp.route('/api/batch/logs')
def get_batch_logs():
    return jsonify(BATCH_LOGS)

@gui_editor_bp.route('/api/test/jellyfin', methods=['POST'])
def test_jellyfin():
    data = request.json
    url = data.get('url')
    api_key = data.get('api_key')
    
    if not url or not api_key:
        return jsonify({"status": "error", "message": "URL and API Key required"}), 400
        
    try:
        headers = jellyfin_headers(api_key)
        clean = url.rstrip('/')
        # Test connection by fetching system info
        r = requests.get(f"{clean}/System/Info", headers=headers, timeout=5)
        r.raise_for_status()
        user_id = resolve_jellyfin_user_id(clean, api_key, data.get('user_id'))
        return jsonify({
            "status": "success",
            "message": f"Connected: {r.json().get('ServerName')}",
            "user_id": user_id,
        })
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500

@gui_editor_bp.route('/api/test/plex', methods=['POST'])
def test_plex():
    data = request.json
    url = data.get('url')
    token = data.get('token')
    if not url or not token:
        return jsonify({"status": "error", "message": "URL and Token required"}), 400
    try:
        headers = {'X-Plex-Token': token, 'Accept': 'application/json'}
        # Check identity endpoint
        r = requests.get(f"{url.rstrip('/')}/identity", headers=headers, timeout=5)
        r.raise_for_status()
        return jsonify({"status": "success", "message": "Connected to Plex"})
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500

@gui_editor_bp.route('/api/test/tmdb', methods=['POST'])
def test_tmdb():
    data = request.json
    api_key = data.get('api_key')
    if not api_key:
        return jsonify({"status": "error", "message": "API Key required"}), 400
    try:
        # Try as Bearer Token first (v4)
        headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json;charset=utf-8"}
        r = requests.get("https://api.themoviedb.org/3/authentication", headers=headers, timeout=5)
        
        if r.status_code == 401:
            # Fallback: Try as v3 API Key query param
            r = requests.get(f"https://api.themoviedb.org/3/authentication?api_key={api_key}", timeout=5)
            
        r.raise_for_status()
        return jsonify({"status": "success", "message": "Connected to TMDB"})
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500

@gui_editor_bp.route('/api/test/radarr', methods=['POST'])
def test_radarr():
    data = request.json
    url = data.get('url')
    api_key = data.get('api_key')
    if not url or not api_key:
        return jsonify({"status": "error", "message": "URL and API Key required"}), 400
    try:
        headers = {'X-Api-Key': api_key}
        r = requests.get(f"{url.rstrip('/')}/api/v3/system/status", headers=headers, timeout=5)
        r.raise_for_status()
        return jsonify({"status": "success", "message": f"Connected to Radarr ({r.json().get('version', 'Unknown')})"})
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500

@gui_editor_bp.route('/api/test/sonarr', methods=['POST'])
def test_sonarr():
    data = request.json
    url = data.get('url')
    api_key = data.get('api_key')
    if not url or not api_key:
        return jsonify({"status": "error", "message": "URL and API Key required"}), 400
    try:
        headers = {'X-Api-Key': api_key}
        r = requests.get(f"{url.rstrip('/')}/api/v3/system/status", headers=headers, timeout=5)
        r.raise_for_status()
        return jsonify({"status": "success", "message": f"Connected to Sonarr ({r.json().get('version', 'Unknown')})"})
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500

@gui_editor_bp.route('/api/test/jellyseerr', methods=['POST'])
def test_jellyseerr():
    data = request.json or {}
    url = data.get('url')
    api_key = data.get('api_key')
    if not url or not api_key:
        return jsonify({"status": "error", "message": "URL and API Key required"}), 400
    try:
        info = seerr_client.status(url, api_key)
        return jsonify({
            "status": "success",
            "message": f"Connected to Seerr/Jellyseerr ({info.get('version', 'Unknown')})",
            "version": info.get("version"),
        })
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500


@gui_editor_bp.route('/api/seerr/request', methods=['POST'])
def seerr_create_request():
    config = load_config()
    conf = seerr_client.get_seerr_conf(config)
    if not conf.get("url") or not conf.get("api_key"):
        return jsonify({"status": "error", "message": "Seerr not configured"}), 400
    data = request.json or {}
    media_type = data.get("media_type") or data.get("mediaType") or "movie"
    media_id = data.get("media_id") or data.get("mediaId") or data.get("tmdb_id")
    if not media_id:
        return jsonify({"status": "error", "message": "media_id required"}), 400
    seasons = data.get("seasons", conf.get("default_request_seasons") or "all")
    try:
        body, code = seerr_client.create_request(
            conf["url"], conf["api_key"], media_type, int(media_id), seasons=seasons
        )
        if code >= 400:
            return jsonify({"status": "error", "message": body.get("message") or body, "detail": body}), code
        return jsonify({"status": "success", "request": body})
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500


@gui_editor_bp.route('/api/seerr/status/<media_type>/<int:tmdb_id>', methods=['GET'])
def seerr_status_lookup(media_type, tmdb_id):
    config = load_config()
    conf = seerr_client.get_seerr_conf(config)
    if not conf.get("url") or not conf.get("api_key"):
        return jsonify({"status": "error", "message": "Seerr not configured"}), 400
    try:
        detail = seerr_client.media_details(conf["url"], conf["api_key"], media_type, tmdb_id)
        detail["mediaType"] = "tv" if media_type in ("tv", "show", "series") else "movie"
        detail["id"] = tmdb_id
        norm = seerr_client.normalize_result(detail, conf["url"])
        return jsonify(norm or {"error": "not found"})
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500


@gui_editor_bp.route('/api/test/trakt', methods=['POST'])
def test_trakt():
    data = request.json
    client_id = data.get('client_id')
    username = data.get('username')
    if not client_id or not username:
        return jsonify({"status": "error", "message": "Client ID and Username required"}), 400
    try:
        headers = {
            'Content-Type': 'application/json',
            'trakt-api-version': '2',
            'trakt-api-key': client_id
        }
        r = requests.get(f"https://api.trakt.tv/users/{username}/profile", headers=headers, timeout=5)
        r.raise_for_status()
        return jsonify({"status": "success", "message": f"Connected to Trakt (User: {r.json().get('username')})"})
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500

@gui_editor_bp.route('/api/layouts/list')
def list_layouts():
    seed_bundled_layouts()
    layouts = []
    if os.path.exists(LAYOUTS_DIR):
        layouts = [f.replace('.json', '') for f in os.listdir(LAYOUTS_DIR) if f.endswith('.json') and f != 'bundled']
        # Exclude nested dirs accidentally listed
        layouts = [n for n in layouts if os.path.isfile(os.path.join(LAYOUTS_DIR, f"{n}.json"))]
    return jsonify(sorted(layouts))

@gui_editor_bp.route('/api/overlays/list')
def list_overlays():
    if os.path.exists(OVERLAYS_JSON):
        with open(OVERLAYS_JSON, 'r') as f:
            return jsonify(json.load(f))
    return jsonify([])

@gui_editor_bp.route('/api/overlays/add', methods=['POST'])
def add_overlay():
    name = request.form.get('name')
    file_1080 = request.files.get('file_1080')
    file_4k = request.files.get('file_4k')
    
    if not name:
        return jsonify({"status": "error", "message": "Name required"}), 400

    overlay_id = str(uuid.uuid4())
    entry = {"id": overlay_id, "name": name, "file_1080": None, "file_4k": None}

    if file_1080:
        ext = os.path.splitext(file_1080.filename)[1]
        fname = f"{overlay_id}_1080{ext}"
        file_1080.save(os.path.join(OVERLAYS_DIR, fname))
        entry["file_1080"] = fname
        
    if file_4k:
        ext = os.path.splitext(file_4k.filename)[1]
        fname = f"{overlay_id}_4k{ext}"
        file_4k.save(os.path.join(OVERLAYS_DIR, fname))
        entry["file_4k"] = fname
        
    overlays = []
    if os.path.exists(OVERLAYS_JSON):
        with open(OVERLAYS_JSON, 'r') as f:
            try: overlays = json.load(f)
            except: pass
            
    overlays.append(entry)
    
    with open(OVERLAYS_JSON, 'w') as f:
        json.dump(overlays, f, indent=4)
        
    return jsonify({"status": "success"})

@gui_editor_bp.route('/api/overlays/delete/<overlay_id>', methods=['POST'])
def delete_overlay(overlay_id):
    overlays = []
    if os.path.exists(OVERLAYS_JSON):
        with open(OVERLAYS_JSON, 'r') as f:
            try: overlays = json.load(f)
            except: pass
            
    new_overlays = []
    for o in overlays:
        if o['id'] == overlay_id:
            # Delete files
            if o.get('file_1080'):
                p = os.path.join(OVERLAYS_DIR, o['file_1080'])
                if os.path.exists(p): os.remove(p)
            if o.get('file_4k'):
                p = os.path.join(OVERLAYS_DIR, o['file_4k'])
                if os.path.exists(p): os.remove(p)
        else:
            new_overlays.append(o)
            
    with open(OVERLAYS_JSON, 'w') as f:
        json.dump(new_overlays, f, indent=4)
        
    return jsonify({"status": "success"})

@gui_editor_bp.route('/api/overlays/image/<path:filename>')
def get_overlay_image(filename):
    return send_from_directory(OVERLAYS_DIR, filename)

@gui_editor_bp.route('/api/overlays/update_margins', methods=['POST'])
def update_overlay_margins():
    data = request.json
    overlay_id = data.get('id')
    blocked_areas = data.get('blocked_areas')
    
    if not overlay_id:
        return jsonify({"status": "error", "message": "ID required"}), 400

    overlays = []
    if os.path.exists(OVERLAYS_JSON):
        with open(OVERLAYS_JSON, 'r') as f:
            try: 
                data = json.load(f)
                if isinstance(data, list): overlays = data
            except: pass
    
    updated = False
    for o in overlays:
        if o['id'] == overlay_id:
            o['blocked_areas'] = blocked_areas
            updated = True
            break
    
    if updated:
        with open(OVERLAYS_JSON, 'w') as f:
            json.dump(overlays, f, indent=4)
        return jsonify({"status": "success"})
    
    return jsonify({"status": "error", "message": "Overlay not found"}), 404

@gui_editor_bp.route('/api/textures/list')
def list_textures():
    if os.path.exists(TEXTURES_JSON):
        with open(TEXTURES_JSON, 'r') as f:
            return jsonify(json.load(f))
    return jsonify([])

@gui_editor_bp.route('/api/textures/add', methods=['POST'])
def add_texture():
    name = request.form.get('name')
    file = request.files.get('file')
    
    if not name or not file:
        return jsonify({"status": "error", "message": "Name and file required"}), 400

    texture_id = str(uuid.uuid4())
    ext = os.path.splitext(file.filename)[1]
    fname = f"{texture_id}{ext}"
    file.save(os.path.join(TEXTURES_DIR, fname))
    
    entry = {"id": texture_id, "name": name, "filename": fname}
    
    textures = []
    if os.path.exists(TEXTURES_JSON):
        with open(TEXTURES_JSON, 'r') as f:
            try: textures = json.load(f)
            except: pass
            
    textures.append(entry)
    
    with open(TEXTURES_JSON, 'w') as f:
        json.dump(textures, f, indent=4)
        
    return jsonify({"status": "success"})

@gui_editor_bp.route('/api/textures/delete/<texture_id>', methods=['POST'])
def delete_texture(texture_id):
    textures = []
    if os.path.exists(TEXTURES_JSON):
        with open(TEXTURES_JSON, 'r') as f:
            try: textures = json.load(f)
            except: pass
            
    new_textures = []
    for t in textures:
        if t['id'] == texture_id:
            p = os.path.join(TEXTURES_DIR, t['filename'])
            if os.path.exists(p): os.remove(p)
        else:
            new_textures.append(t)
            
    with open(TEXTURES_JSON, 'w') as f:
        json.dump(new_textures, f, indent=4)
        
    return jsonify({"status": "success"})

@gui_editor_bp.route('/api/textures/image/<path:filename>')
def get_texture_image(filename):
    return send_from_directory(TEXTURES_DIR, filename)

# --- FONT PARSING LOGIC START ---

def parse_font_filename(filename):
    """
    Analyzes the filename and extracts family, weight, and style.
    Example: "Inter_18pt-BoldItalic.ttf" -> Family: "Inter", Weight: 700, Style: "italic"
    """
    name_part = os.path.splitext(filename)[0]
    
    # 1. Default values
    weight = 'normal' # 400
    style = 'normal'
    
    # 2. Detect style (Italic/Oblique)
    if re.search(r'(italic|oblique)', name_part, re.IGNORECASE):
        style = 'italic'
    
    # 3. Detect weight (Keywords & Mapping to CSS numbers)
    # Order is important: Check 'ExtraBold' before 'Bold'!
    weight_map = {
        r'(thin|hairline|100)': '100',
        r'(extra[-]?light|ultra[-]?light|200)': '200',
        r'(light|300)': '300',
        r'(normal|regular|book|400)': '400',
        r'(medium|500)': '500',
        r'(semi[-]?bold|demi[-]?bold|600)': '600',
        r'(extra[-]?bold|ultra[-]?bold|800)': '800', # Check ExtraBold before Bold
        r'(bold|700)': '700',                         # Bold as the last of the bold variants
        r'(black|heavy|900)': '900'
    }
    
    lower_name = name_part.lower()
    for pattern, w_val in weight_map.items():
        if re.search(pattern, lower_name):
            weight = w_val
            break # First match wins (hence order above is important)

    # 4. Cleaning up the family name
    # We remove all keywords found above from the name
    remove_patterns = [
        r'(italic|oblique)',
        r'(thin|hairline|100)',
        r'(extra[-]?light|ultra[-]?light|200)',
        # r'(light|300)', # Removed aggressive match that breaks "Highlight"
        r'[-_ ](light|300)', # Only remove if preceded by separator (Fixes Highlight -> High)
        r'(normal|regular|book|400)',
        r'(medium|500)',
        r'(semi[-]?bold|demi[-]?bold|600)',
        r'(extra[-]?bold|ultra[-]?bold|800)',
        r'(bold|700)',
        r'(black|heavy|900)',
        r'(_\d+pt)', # Removes e.g. "_18pt" or "_24pt" (like in Inter)
        r'(variablefont_wght)'
    ]
    
    clean_name = name_part
    for p in remove_patterns:
        clean_name = re.sub(p, '', clean_name, flags=re.IGNORECASE)
        
    # Clean up separators (underscores, hyphens at the end/beginning)
    clean_name = re.sub(r'[-_ ]+', ' ', clean_name).strip()
    
    # Fallback: If everything was deleted (e.g. filename was just "Bold.ttf"), use original
    if not clean_name:
        clean_name = name_part

    return {
        'family': clean_name,
        'weight': weight,
        'style': style,
        'src': filename
    }

def get_font_metadata():
    if not os.path.exists(FONTS_DIR):
        return []
        
    fonts = []
    for f in os.listdir(FONTS_DIR):
        if f.lower().endswith(('.ttf', '.otf', '.woff', '.woff2')):
            meta = parse_font_filename(f)
            fonts.append(meta)
    return fonts

@gui_editor_bp.route('/dynamic_fonts.css')
def dynamic_fonts_css():
    """Generates CSS @font-face rules that group families."""
    fonts = get_font_metadata()
    css = []
    
    for font in fonts:
        # Here is the trick: We use the same 'font-family' name for different files
        rule = (
            f"@font-face {{\n"
            f"    font-family: '{font['family']}';\n"
            f"    src: url('{url_for('gui_editor.get_font_file', filename=font['src'])}');\n"
            f"    font-weight: {font['weight']};\n"
            f"    font-style: {font['style']};\n"
            f"    font-display: swap;\n"
            f"}}"
        )
        css.append(rule)
        
    return "\n".join(css), 200, {'Content-Type': 'text/css'}

@gui_editor_bp.route('/api/fonts/list')
def list_fonts():
    """Returns only the unique family names for the dropdown."""
    fonts = get_font_metadata()
    # Use Set to remove duplicates, then sort
    families = sorted(list(set(f['family'] for f in fonts)))
    return jsonify(families)

@gui_editor_bp.route('/api/fonts/grouped')
def list_fonts_grouped():
    """Returns fonts grouped by family for the manager UI."""
    fonts = get_font_metadata()
    grouped = {}
    for f in fonts:
        fam = f['family']
        if fam not in grouped:
            grouped[fam] = []
        grouped[fam].append(f)
    
    # Sort families alphabetically
    sorted_keys = sorted(grouped.keys())
    result = {k: grouped[k] for k in sorted_keys}
    return jsonify(result)

# --- FONT PARSING LOGIC END ---

@gui_editor_bp.route('/api/fonts/add', methods=['POST'])
def add_font():
    file = request.files.get('file')
    if not file:
        return jsonify({"status": "error", "message": "File required"}), 400
    
    filename = file.filename
    # Basic sanitization
    filename = "".join(c for c in filename if c.isalnum() or c in "._-").strip()
    
    if not filename.lower().endswith(('.ttf', '.otf', '.woff', '.woff2')):
         return jsonify({"status": "error", "message": "Invalid font file type"}), 400

    file.save(os.path.join(FONTS_DIR, filename))
    return jsonify({"status": "success"})

@gui_editor_bp.route('/api/fonts/delete/<filename>', methods=['POST'])
def delete_font(filename):
    # sanitize filename to prevent directory traversal
    filename = os.path.basename(filename)
    path = os.path.join(FONTS_DIR, filename)
    if os.path.exists(path):
        os.remove(path)
    return jsonify({"status": "success"})

@gui_editor_bp.route('/api/fonts/file/<path:filename>')
def get_font_file(filename):
    return send_from_directory(FONTS_DIR, filename)

@gui_editor_bp.route('/api/custom-icons/list')
def list_custom_icons():
    icons = []
    if os.path.exists(CUSTOM_ICONS_DIR):
        icons = [f for f in os.listdir(CUSTOM_ICONS_DIR) if f.lower().endswith(('.png', '.svg', '.jpg', '.jpeg'))]
    return jsonify(sorted(icons))

@gui_editor_bp.route('/api/custom-icons/add', methods=['POST'])
def add_custom_icon():
    file = request.files.get('file')
    if not file:
        return jsonify({"status": "error", "message": "File required"}), 400
    
    filename = file.filename
    # Basic sanitization
    filename = "".join(c for c in filename if c.isalnum() or c in "._-").strip()
    
    if not filename.lower().endswith(('.png', '.svg', '.jpg', '.jpeg')):
         return jsonify({"status": "error", "message": "Invalid file type"}), 400

    file.save(os.path.join(CUSTOM_ICONS_DIR, filename))
    return jsonify({"status": "success"})

@gui_editor_bp.route('/api/custom-icons/delete/<filename>', methods=['POST'])
def delete_custom_icon(filename):
    filename = os.path.basename(filename)
    path = os.path.join(CUSTOM_ICONS_DIR, filename)
    if os.path.exists(path):
        os.remove(path)
    return jsonify({"status": "success"})

@gui_editor_bp.route('/api/custom-icons/image/<path:filename>')
def get_custom_icon_image(filename):
    return send_from_directory(CUSTOM_ICONS_DIR, filename)

@gui_editor_bp.route('/api/layouts/save', methods=['POST'])
def save_layout():
    try:
        data = request.json or {}
        name = data.get('name')
        layout = data.get('layout')
        preview_image = data.get('preview_image')
        action_url = data.get('action_url')
        media_title = data.get('media_title')
        metadata = data.get('metadata')
        if not name or not layout:
            return jsonify({"status": "error", "message": "Missing name or layout data"}), 400

        safe_name = "".join(c for c in str(name) if c.isalnum() or c in " ._-").strip()
        if not safe_name:
            return jsonify({"status": "error", "message": "Invalid name"}), 400

        if not isinstance(layout, dict):
            return jsonify({"status": "error", "message": "Invalid layout data"}), 400

        # Custom names must not stay "managed" or later seed upgrades can treat them oddly
        if safe_name not in MANAGED_LAYOUT_NAMES:
            layout.pop("managed_preset", None)
            layout.pop("layout_preset_version", None)
            layout["preset_name"] = safe_name
            layout["layout_anchor"] = layout.get("layout_anchor") or "left_top"
        else:
            # Editing a shipped preset in place — keep managed markers so upgrades can refresh
            layout["managed_preset"] = True
            layout["preset_name"] = safe_name

        if metadata:
            layout['metadata'] = metadata

        path = os.path.join(LAYOUTS_DIR, f"{safe_name}.json")
        os.makedirs(LAYOUTS_DIR, exist_ok=True)
        with open(path, 'w', encoding='utf-8') as f:
            json.dump(layout, f)

        # Clear existing previews for this layout to avoid mixing old and new images
        preview_dir_path = os.path.join(LAYOUT_PREVIEWS_DIR, safe_name)
        if os.path.exists(preview_dir_path):
            shutil.rmtree(preview_dir_path)

        # Save Preview Image (Thumbnail)
        if preview_image:
            if ',' in preview_image:
                preview_image = preview_image.split(',')[1]
            try:
                os.makedirs(LAYOUT_PREVIEWS_DIR, exist_ok=True)
                preview_path = os.path.join(LAYOUT_PREVIEWS_DIR, f"{safe_name}.jpg")
                with open(preview_path, "wb") as f:
                    f.write(base64.b64decode(preview_image))
            except Exception as e:
                print(f"Error saving layout preview: {e}")

        # Save status.json for Android App Deep Link
        bg_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'editor_backgrounds', safe_name)
        if not os.path.exists(bg_dir):
            os.makedirs(bg_dir)

        status_data = {
            "action_url": action_url,
            "title": media_title,
            "timestamp": int(time.time())
        }
        with open(os.path.join(bg_dir, 'status.json'), 'w', encoding='utf-8') as f:
            json.dump(status_data, f)

        return jsonify({"status": "success", "name": safe_name})
    except Exception as e:
        print(f"Error saving layout: {e}")
        return jsonify({"status": "error", "message": str(e)}), 500

@gui_editor_bp.route('/api/layouts/load/<path:name>')
def load_layout(name):
    safe_name = "".join(c for c in name if c.isalnum() or c in " ._-").strip()
    path = os.path.join(LAYOUTS_DIR, f"{safe_name}.json")
    if os.path.exists(path):
        with open(path, 'r', encoding='utf-8') as f:
            return jsonify(json.load(f))
    return jsonify({"status": "error", "message": "Layout not found"}), 404

@gui_editor_bp.route('/api/layouts/preview/<path:name>')
def get_layout_preview(name):
    safe_name = "".join(c for c in name if c.isalnum() or c in " ._-").strip()
    filename = f"{safe_name}.jpg"
    preview_path = os.path.join(LAYOUT_PREVIEWS_DIR, filename)
    if os.path.exists(preview_path):
        return send_from_directory(LAYOUT_PREVIEWS_DIR, filename)
    # 1x1 transparent GIF — avoids noisy 404s for presets without thumbnails yet
    pixel = base64.b64decode("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7")
    return Response(pixel, mimetype="image/gif")

@gui_editor_bp.route('/api/layouts/for-app')
def list_layouts_for_app():
    layouts = []
    if os.path.exists(LAYOUTS_DIR):
        files = [f for f in os.listdir(LAYOUTS_DIR) if f.endswith('.json')]
        for f in sorted(files):
            name = f.replace('.json', '')
            preview_url = url_for('gui_editor.get_layout_preview', name=name, _external=True)
            layouts.append({"name": name, "preview_url": preview_url})
    return jsonify(layouts)

@gui_editor_bp.route('/api/wallpaper/status')
def get_wallpaper_status():
    # --- Search Engine Logic ---
    layout_name = request.args.get('layout', 'Default')
    genre_filter = request.args.get('genre')
    age_rating_filter = request.args.get('age_rating') or request.args.get('age')
    min_rating_filter = request.args.get('min_rating')
    max_rating_filter = request.args.get('max_rating')
    min_year_filter = request.args.get('min_year')
    max_year_filter = request.args.get('max_year')
    sort_mode = (request.args.get('sort') or 'random').strip().lower()
    pool = (request.args.get('pool') or '').strip().lower()
    exclude_raw = request.args.get('exclude') or request.args.get('exclude_path') or ''

    safe_layout = "".join(c for c in layout_name if c.isalnum() or c in " ._-").strip()
    base_path = os.path.dirname(os.path.abspath(__file__))

    response = {
        "imageUrl": None,
        "actionUrl": None,
        "title": None,
        "path": None,
        "sort": sort_mode,
        "pool": pool or None,
    }

    # 1. Collect Candidates from RAM Cache (No Disk I/O)
    candidates = [img for img in METADATA_CACHE["images"] if img.get('layout') == safe_layout]
    if not candidates:
        return jsonify(response)

    # Ensure mtime exists for older cache entries
    for img in candidates:
        if not img.get('mtime'):
            img['mtime'] = _wallpaper_mtime(img.get('path'))
        if not img.get('source_norm') and img.get('source'):
            img['source_norm'] = _normalize_source(img.get('source'))

    filtered = list(candidates)

    # Pool filters (watch / library / source)
    if pool:
        before_pool = filtered
        if pool == 'unwatched':
            filtered = [c for c in filtered if str(c.get('watch_state') or '').lower() in ('unwatched', 'unplayed')]
        elif pool in ('partial', 'partially_watched'):
            filtered = [c for c in filtered if str(c.get('watch_state') or '').lower() in ('partial', 'partially_watched', 'inprogress', 'in_progress')]
        elif pool == 'watched':
            filtered = [c for c in filtered if str(c.get('watch_state') or '').lower() in ('watched', 'played')]
        elif pool == 'in_library':
            filtered = [c for c in filtered if str(c.get('library_state') or '').lower() == 'in_library' or c.get('jellyfin_id') or c.get('source_norm') == 'jellyfin']
        elif pool in ('seerr_only', 'not_in_library'):
            filtered = [c for c in filtered if str(c.get('library_state') or '').lower() in ('seerr_only', 'not_in_library') or (c.get('source_norm') == 'jellyseerr' and not c.get('jellyfin_id'))]
        elif pool == 'requestable':
            filtered = [c for c in filtered if str(c.get('availability') or '').lower() in ('not_available', 'requestable') or str(c.get('library_state') or '').lower() == 'seerr_only']
        elif pool in ('available', 'available_seerr'):
            filtered = [c for c in filtered if str(c.get('availability') or '').lower() in ('available', 'available_seerr')]
        elif pool.startswith('source:'):
            want = pool.split(':', 1)[1].strip().lower()
            if want in ('seerr', 'jellyseerr'):
                want = 'jellyseerr'
            filtered = [c for c in filtered if c.get('source_norm') == want or want in str(c.get('source') or '').lower()]
        if not filtered:
            filtered = before_pool  # never blank out pool misses

    # Rating Filter
    if min_rating_filter or max_rating_filter:
        try:
            min_r = float(min_rating_filter) if min_rating_filter else 0.0
            max_r = float(max_rating_filter) if max_rating_filter else 10.0
            filtered = [c for c in filtered if min_r <= float(c.get('rating', 0) or 0) <= max_r]
        except Exception:
            pass

    # Year Filter (Range)
    if min_year_filter or max_year_filter:
        try:
            min_y = int(min_year_filter) if min_year_filter else 0
            max_y = int(max_year_filter) if max_year_filter else 9999
            filtered = [c for c in filtered if min_y <= int(c.get('year', 0) or 0) <= max_y]
        except Exception:
            pass

    if genre_filter:
        g_terms = [g.strip().lower() for g in genre_filter.split(',') if g.strip()]
        if g_terms:
            filtered = [c for c in filtered if any(term in str(c.get('genres', '')).lower() for term in g_terms)]

    if age_rating_filter:
        a_terms = [a.strip().lower() for a in age_rating_filter.split(',') if a.strip()]
        if a_terms:
            norm_terms = ["".join(c for c in t if c.isalnum()) for t in a_terms]
            filtered = [c for c in filtered if any(term in "".join(k for k in str(c.get('officialRating', '')).lower() if k.isalnum()) for term in norm_terms)]

    # Exclude recently shown paths / filenames
    exclude_tokens = [t.strip().replace('\\', '/').lower() for t in exclude_raw.split(',') if t.strip()]
    if exclude_tokens and len(filtered) > 1:
        def _is_excluded(entry):
            path = str(entry.get('path') or '').replace('\\', '/').lower()
            base = os.path.basename(path).lower()
            stem = os.path.splitext(base)[0]
            for token in exclude_tokens:
                if token == path or token == base or token in path or os.path.splitext(os.path.basename(token))[0] == stem:
                    return True
            return False
        narrowed = [c for c in filtered if not _is_excluded(c)]
        if narrowed:
            filtered = narrowed

    # Fallback if filter too strict
    if not filtered and candidates:
        filtered = candidates
    elif not filtered:
        return jsonify(response)

    # 3. Sort / Pick
    selected = None
    if sort_mode in ('year', 'year_desc'):
        filtered.sort(key=lambda x: int(x.get('year', 0) or 0), reverse=True)
        selected = filtered[0]
    elif sort_mode in ('year_asc', 'year_old'):
        filtered.sort(key=lambda x: int(x.get('year', 0) or 0))
        selected = filtered[0]
    elif sort_mode in ('rating', 'rating_high', 'rating_desc'):
        filtered.sort(key=lambda x: float(x.get('rating', 0) or 0), reverse=True)
        selected = filtered[0]
    elif sort_mode in ('rating_asc', 'rating_low'):
        filtered.sort(key=lambda x: float(x.get('rating', 0) or 0))
        selected = filtered[0]
    elif sort_mode in ('latest', 'newest', 'mtime_desc'):
        filtered.sort(key=lambda x: float(x.get('mtime', 0) or 0), reverse=True)
        selected = filtered[0]
    elif sort_mode in ('oldest', 'mtime_asc'):
        filtered.sort(key=lambda x: float(x.get('mtime', 0) or 0))
        selected = filtered[0]
    else:  # random
        selected = random.choice(filtered)

    # 4. Construct Response
    if selected:
        full_path = selected['path']
        filename = os.path.basename(full_path).replace('.json', '.jpg')

        layout_dir = os.path.join(base_path, 'editor_backgrounds', safe_layout)
        if full_path.startswith(layout_dir):
            rel_path = os.path.relpath(full_path, layout_dir)
            filename = rel_path.replace('.json', '.jpg').replace('\\', '/')

        folder_param = f"Layout: {safe_layout}"
        response["imageUrl"] = url_for('gui_editor.get_gallery_image', folder=folder_param, filename=filename, _external=True)
        response["actionUrl"] = selected.get("action_url")
        response["title"] = selected.get("title")
        response["path"] = filename

    return jsonify(response)

@gui_editor_bp.route('/api/current-background')
def get_current_background():
    layout_name = request.args.get('layout', 'Default')
    safe_name = "".join(c for c in layout_name if c.isalnum() or c in " ._-").strip()
    
    base_path = os.path.dirname(os.path.abspath(__file__))
    
    # 1. Try High-Res Render (e.g. rendered_LayoutName.jpg in editor_backgrounds)
    high_res_path = os.path.join(base_path, 'editor_backgrounds', f"rendered_{safe_name}.jpg")
    if os.path.exists(high_res_path):
        return send_file(high_res_path)
        
    # 2. Fallback: Layout Preview
    preview_path = os.path.join(LAYOUT_PREVIEWS_DIR, f"{safe_name}.jpg")
    if os.path.exists(preview_path):
        return send_from_directory(LAYOUT_PREVIEWS_DIR, f"{safe_name}.jpg")
        
    return jsonify({"error": "Background not found"}), 404

@gui_editor_bp.route('/api/layouts/delete/<path:name>', methods=['POST'])
def delete_layout(name):
    safe_name = "".join(c for c in name if c.isalnum() or c in " ._-").strip()
    if not safe_name:
        return jsonify({"status": "error", "message": "Invalid name"}), 400
    if safe_name in MANAGED_LAYOUT_NAMES:
        return jsonify({
            "status": "error",
            "message": f'"{safe_name}" is a built-in layout and cannot be deleted. Save a copy under a new name instead.'
        }), 400

    json_path = os.path.join(LAYOUTS_DIR, f"{safe_name}.json")
    preview_path = os.path.join(LAYOUT_PREVIEWS_DIR, f"{safe_name}.jpg")
    preview_dir_path = os.path.join(LAYOUT_PREVIEWS_DIR, safe_name)

    try:
        if os.path.exists(json_path):
            os.remove(json_path)
        if os.path.exists(preview_path):
            os.remove(preview_path)
        if os.path.exists(preview_dir_path):
            shutil.rmtree(preview_dir_path)
        return jsonify({"status": "success"})
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500

@gui_editor_bp.route('/api/gallery/delete_all', methods=['POST'])
def delete_all_gallery_images():
    data = request.json
    folder = data.get('folder')
    if not folder:
        return jsonify({"status": "error", "message": "Missing folder"}), 400

    base_path = os.path.dirname(os.path.abspath(__file__))
    target_dir = None

    if folder.startswith("Layout: "):
        layout_name = folder.replace("Layout: ", "").strip()
        safe_layout = "".join(c for c in layout_name if c.isalnum() or c in " ._-").strip()
        target_dir = os.path.join(base_path, "editor_backgrounds", safe_layout)
    elif folder.startswith("LayoutPreview: "):
        layout_name = folder.replace("LayoutPreview: ", "").strip()
        safe_layout = "".join(c for c in layout_name if c.isalnum() or c in " ._-").strip()
        target_dir = os.path.join(base_path, "layouts", "previews", safe_layout)
    elif folder == "Editor (Unsorted)":
        target_dir = os.path.join(base_path, "editor_backgrounds")
    elif folder in KNOWN_DIRS:
        target_dir = os.path.join(base_path, folder)
    
    if not target_dir or not os.path.exists(target_dir):
        return jsonify({"status": "error", "message": "Invalid or non-existent folder"}), 400

    try:
        for filename in os.listdir(target_dir):
            file_path = os.path.join(target_dir, filename)
            if os.path.isfile(file_path) and filename.lower().endswith(('.jpg', '.jpeg', '.png', '.json')):
                os.remove(file_path)
        
        # Check if directory is empty and remove it if so (only for subfolders)
        if not os.listdir(target_dir) and target_dir != os.path.join(base_path, "editor_backgrounds"):
            os.rmdir(target_dir)
            
        return jsonify({"status": "success"})
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500

@gui_editor_bp.route('/api/save_image', methods=['POST'])
def save_editor_image():
    global LATEST_GENERATED_IMAGE
    data = request.json
    image_data = data.get('image')
    metadata = data.get('metadata', {})
    layout_name = data.get('layout_name', 'Default')
    canvas_json = data.get('canvas_json')
    overwrite_filename = data.get('overwrite_filename')
    target_type = data.get('target_type', 'gallery')
    organize_by_genre = data.get('organize_by_genre', False)

    if not image_data:
        return jsonify({"status": "error", "message": "No image data"}), 400
    
    if ',' in image_data:
        image_data = image_data.split(',')[1]
    
    if target_type == 'layout_preview':
        folder = os.path.join("layouts", "previews")
    else:
        folder = "editor_backgrounds"
        
    base_path = os.path.dirname(os.path.abspath(__file__))
    
    safe_layout = "".join(c for c in layout_name if c.isalnum() or c in " ._-").strip()
    if not safe_layout: safe_layout = "Default"
    
    full_path = os.path.join(base_path, folder, safe_layout)
    
    # Genre Sorting Logic
    if organize_by_genre and metadata and metadata.get('genres'):
        # Get the first genre from the comma-separated list
        first_genre = str(metadata.get('genres', '')).split(',')[0].strip()
        safe_genre = "".join(c for c in first_genre if c.isalnum() or c in " ._-").strip()
        if safe_genre:
            full_path = os.path.join(full_path, safe_genre)
    
    if not os.path.exists(full_path):
        os.makedirs(full_path)
    
    if overwrite_filename:
        filename = overwrite_filename
    else:
        if metadata and (metadata.get('title') or metadata.get('Name')):
            filename = gallery_dedupe.preferred_filename(metadata)
        else:
            filename = f"custom_{int(time.time())}.jpg"

    if metadata:
        metadata = gallery_dedupe.enrich_metadata_identity(metadata)
        data['metadata'] = metadata

    # When replacing, remove other gallery files for the same show (old names / duplicates)
    if data.get('replace_existing') or data.get('overwrite'):
        try:
            gallery_dedupe.delete_matches(full_path, metadata)
        except Exception as e:
            print(f"WARN: replace_existing cleanup failed: {e}")

    filepath = os.path.join(full_path, filename)
    
    try:
        with open(filepath, "wb") as f:
            f.write(base64.b64decode(image_data))

        final_json_data = canvas_json if canvas_json else {}
        
        # --- New: Handle separate ambilight image ---
        ambilight_image_data = data.get('ambilight_image_data')
        if ambilight_image_data and final_json_data:
            if ',' in ambilight_image_data:
                ambilight_image_data = ambilight_image_data.split(',')[1]
            
            ambilight_filename = os.path.splitext(filename)[0] + ".ambilight.jpg"
            ambilight_filepath = os.path.join(full_path, ambilight_filename)
            
            with open(ambilight_filepath, "wb") as f:
                f.write(base64.b64decode(ambilight_image_data))

            canvas_width = final_json_data.get('width', 1920)
            canvas_height = final_json_data.get('height', 1080)
            
            try:
                img = Image.open(ambilight_filepath)
                img_width, img_height = img.size
            except Exception as e:
                print(f"WARN: Could not read ambilight image dimensions: {e}")
                img_width, img_height = canvas_width, canvas_height # Fallback

            ambilight_obj = {
                "type": "image",
                "version": "5.3.0",
                "originX": "center", "originY": "center",
                "left": canvas_width / 2, "top": canvas_height / 2,
                "width": img_width, "height": img_height,
                "scaleX": canvas_width / img_width, "scaleY": canvas_height / img_height,
                "src": os.path.basename(ambilight_filepath),
                "dataTag": "ambilight_bg",
                "selectable": False, "evented": False, "crossOrigin": "anonymous"
            }
            if 'objects' not in final_json_data:
                final_json_data['objects'] = []
            final_json_data['objects'].insert(0, ambilight_obj)
        # --- End New ---
            
        # Update JSON with metadata and action_url
        if metadata:
            final_json_data['metadata'] = metadata
            final_json_data['action_url'] = metadata.get('action_url')
            
        json_path = os.path.splitext(filepath)[0] + ".json"
        with open(json_path, "w") as f:
            json.dump(final_json_data, f)


        # Update Cache (Live Update)
        if metadata:
            update_metadata_cache(metadata, filepath, safe_layout)

        # Update global variable for preview
        LATEST_GENERATED_IMAGE = filepath

        return jsonify({"status": "success", "filename": filename})
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500


@gui_editor_bp.route('/api/gallery/check_media', methods=['POST'])
def gallery_check_media():
    """Check whether a wallpaper already exists for this show/movie (IMDb/TMDB/JF id)."""
    data = request.json or {}
    layout_name = data.get('layout_name') or data.get('layout') or 'Default'
    metadata = data.get('metadata') or {}
    safe_layout = "".join(c for c in str(layout_name) if c.isalnum() or c in " ._-").strip() or "Default"
    layout_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "editor_backgrounds", safe_layout)
    matches = gallery_dedupe.find_matches(layout_dir, metadata)
    return jsonify({
        "status": "success",
        "exists": bool(matches),
        "matches": matches,
        "preferred_filename": gallery_dedupe.preferred_filename(metadata),
    })


@gui_editor_bp.route('/api/gallery/delete_media', methods=['POST'])
def gallery_delete_media():
    """Delete all gallery wallpapers for a show/movie (by identity keys)."""
    data = request.json or {}
    layout_name = data.get('layout_name') or data.get('layout') or 'Default'
    metadata = data.get('metadata') or {}
    safe_layout = "".join(c for c in str(layout_name) if c.isalnum() or c in " ._-").strip() or "Default"
    layout_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "editor_backgrounds", safe_layout)
    matches = gallery_dedupe.find_matches(layout_dir, metadata)
    removed = gallery_dedupe.delete_bases(layout_dir, matches)
    return jsonify({"status": "success", "deleted": removed, "matches": matches})


@gui_editor_bp.route('/api/gallery/data/<folder>/<path:filename>')
def get_gallery_image_data(folder, filename):
    base_path = os.path.dirname(os.path.abspath(__file__))
    
    # Determine target directory (logic shared with get_gallery_image)
    target_dir = ""
    if folder.startswith("Layout: "):
        layout_name = folder.replace("Layout: ", "").strip()
        safe_layout = "".join(c for c in layout_name if c.isalnum() or c in " ._-").strip()
        target_dir = os.path.join(base_path, "editor_backgrounds", safe_layout)
    elif folder.startswith("LayoutPreview: "):
        layout_name = folder.replace("LayoutPreview: ", "").strip()
        safe_layout = "".join(c for c in layout_name if c.isalnum() or c in " ._-").strip()
        target_dir = os.path.join(base_path, "layouts", "previews", safe_layout)
    elif folder == "Editor (Unsorted)":
        target_dir = os.path.join(base_path, "editor_backgrounds")
    elif folder in KNOWN_DIRS:
        target_dir = os.path.join(base_path, folder)
    else:
        return jsonify({"status": "error", "message": "Invalid folder"}), 400

    json_filename = os.path.splitext(filename)[0] + ".json"
    json_path = os.path.join(target_dir, json_filename)
    
    if os.path.exists(json_path):
        with open(json_path, 'r') as f:
            return jsonify(json.load(f))
    
    return jsonify({"status": "error", "message": "No layout data found for this image"}), 404

@gui_editor_bp.route('/api/certification/<path:filename>')
def get_certification_image(filename):
    cert_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'certification')
    return send_from_directory(cert_dir, filename)

@gui_editor_bp.route('/get_local_background')
def get_local_background():
    current_dir = os.path.dirname(os.path.abspath(__file__))
    return send_from_directory(current_dir, 'background.jpg')

@gui_editor_bp.route('/editor')
def editor_index():
    config = load_config()
    fonts = get_font_metadata()
    families = sorted(list(set(f['family'] for f in fonts)))
    data = {"title": "TV Background", "backdrop_url": url_for('gui_editor.get_local_background'), "version": CURRENT_VERSION, "font_families": families}
    return render_template('editor.html', data=data, config=config)

@gui_editor_bp.route('/api/gallery/list')
def list_gallery_images():
    gallery = {}
    base_path = os.path.dirname(os.path.abspath(__file__))
    for folder in KNOWN_DIRS:
        folder_path = os.path.join(base_path, folder)
        if os.path.exists(folder_path):
            if folder == "editor_backgrounds":
                # Scan subdirectories for layouts
                try:
                    subdirs = [d for d in os.listdir(folder_path) if os.path.isdir(os.path.join(folder_path, d))]
                    if not subdirs:
                        # Fallback for root files
                        images = [f for f in os.listdir(folder_path) if f.lower().endswith(('.jpg', '.jpeg', '.png')) and '.ambilight' not in f.lower()]
                        if images: gallery["Editor (Unsorted)"] = sorted(images)
                    else:
                        for subdir in subdirs:
                            sub_path = os.path.join(folder_path, subdir)
                            images = [f for f in os.listdir(sub_path) if f.lower().endswith(('.jpg', '.jpeg', '.png')) and '.ambilight' not in f.lower()]
                            if images: gallery[f"Layout: {subdir}"] = sorted(images)
                except: pass
            elif folder == "layouts":
                # Scan previews subdirectory
                previews_dir = os.path.join(folder_path, "previews")
                if os.path.exists(previews_dir):
                    try:
                        subdirs = [d for d in os.listdir(previews_dir) if os.path.isdir(os.path.join(previews_dir, d))]
                        for subdir in subdirs:
                            sub_path = os.path.join(previews_dir, subdir)
                            images = [f for f in os.listdir(sub_path) if f.lower().endswith(('.jpg', '.jpeg', '.png')) and '.ambilight' not in f.lower()]
                            if images: gallery[f"LayoutPreview: {subdir}"] = sorted(images)
                    except: pass
            elif folder != "layouts":
                images = [f for f in os.listdir(folder_path) if f.lower().endswith(('.jpg', '.jpeg', '.png')) and '.ambilight' not in f.lower()]
                if images:
                    gallery[folder] = sorted(images)
    return jsonify(gallery)

@gui_editor_bp.route('/api/gallery/image/<folder>/<path:filename>')
def get_gallery_image(folder, filename):
    base_path = os.path.dirname(os.path.abspath(__file__))
    
    # Handle Layout subfolders
    if folder.startswith("Layout: "):
        layout_name = folder.replace("Layout: ", "").strip()
        safe_layout = "".join(c for c in layout_name if c.isalnum() or c in " ._-").strip()
        return send_from_directory(os.path.join(base_path, "editor_backgrounds", safe_layout), filename)
    
    if folder.startswith("LayoutPreview: "):
        layout_name = folder.replace("LayoutPreview: ", "").strip()
        safe_layout = "".join(c for c in layout_name if c.isalnum() or c in " ._-").strip()
        return send_from_directory(os.path.join(base_path, "layouts", "previews", safe_layout), filename)
    
    if folder == "Editor (Unsorted)":
        return send_from_directory(os.path.join(base_path, "editor_backgrounds"), filename)

    if folder not in KNOWN_DIRS:
        return "Invalid folder", 400
         
    return send_from_directory(os.path.join(base_path, folder), filename)

def find_most_recent_image_in_dirs(search_dirs):
    """Scans a list of directories for the most recently modified image file."""
    latest_file = None
    latest_time = 0
    
    base_path = os.path.dirname(os.path.abspath(__file__))

    for d in search_dirs:
        s_dir = os.path.join(base_path, d)
        if not os.path.exists(s_dir):
            continue
        for root, _, files in os.walk(s_dir):
            for file in files:
                if file.lower().endswith(('.jpg', '.jpeg', '.png')) and '.ambilight' not in file.lower():
                    path = os.path.join(root, file)
                    try:
                        mtime = os.path.getmtime(path)
                        if mtime > latest_time:
                            latest_time = mtime
                            latest_file = path
                    except OSError:
                        continue
    return latest_file

@gui_editor_bp.route('/api/batch/preview/latest_image')
def get_latest_batch_image():
    global LATEST_GENERATED_IMAGE
    if LATEST_GENERATED_IMAGE and os.path.exists(LATEST_GENERATED_IMAGE):
        return send_file(LATEST_GENERATED_IMAGE)
    
    search_folders = [d for d in KNOWN_DIRS if 'backgrounds' in d]
    fallback_image = find_most_recent_image_in_dirs(search_folders)
    if fallback_image:
        LATEST_GENERATED_IMAGE = fallback_image
        return send_file(fallback_image)

    return "", 404

@gui_editor_bp.route('/api/trigger_search', methods=['POST'])
def trigger_batch_search_endpoint():
    """
    Triggered by the browser batch process.
    Runs the missing episode/movie search in a background thread.
    """
    if not trigger_missing:
        return jsonify({"status": "error", "message": "trigger_missing module not loaded"}), 500

    data = request.json
    providers = [p.lower() for p in data.get('providers', [])]

    def run_background_search():
        # Simple logger wrapper to print to server console
        def logger(msg):
            print(f"[Batch-Trigger] {msg}")

        # Search triggering disabled per user request
        # if 'sonarr' in providers:
        #     trigger_missing.run_sonarr_batch_search(logger=logger)
        # 
        # if 'radarr' in providers:
        #     trigger_missing.trigger_radarr_missing_search(logger=logger)

    # Start in background thread so UI doesn't hang
    threading.Thread(target=run_background_search).start()
    
    return jsonify({"status": "success", "message": "Search started in background"})

if __name__ == '__main__':
    from flask import Flask
    app = Flask(__name__)
    app.register_blueprint(gui_editor_bp)
    app.run(debug=True, host='0.0.0.0', port=5000)