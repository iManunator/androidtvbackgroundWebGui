import os
import sys
import time
import argparse
import json
import requests
import subprocess
import tempfile
import base64
import re
from urllib.parse import quote, unquote
from datetime import datetime, timedelta


# Path to own module folder
sys.path.append(os.path.dirname(os.path.abspath(__file__)))
from jellyfin_auth import jellyfin_headers, jellyfin_image_url, jellyfin_items_base, resolve_jellyfin_user_id
import seerr_client
import media_status
from gui_editor import load_config, save_config, fetch_tmdb_details, format_seerr_item, format_jellyfin_item

# Import the missing search trigger script
try:
    import trigger_missing
except ImportError:
    trigger_missing = None

# Config
API_URL = "http://127.0.0.1:5000/api/save_image"
LOG_URL = "http://127.0.0.1:5000/api/cron/log"
STOP_SIGNAL_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'cron_stop.signal')

def log(msg):
    print(msg)
    try:
        requests.post(LOG_URL, json={"message": msg}, timeout=1)
    except:
        pass

# --- START DER ANGEPASSTEN FUNKTION ---
# Diese Funktion ist jetzt viel kürzer und effizienter.
# Sie übergibt die Anweisungen direkt an Node.js, anstatt Bilder selbst herunterzuladen.
def enrich_with_omdb(metadata, config):
    omdb_key = config.get('omdb', {}).get('api_key')
    if not omdb_key: return metadata
    
    imdb_id = metadata.get('imdb_id')
    if not imdb_id:
        pids = metadata.get('provider_ids', {})
        if isinstance(pids, dict): imdb_id = pids.get('Imdb')
    if not imdb_id:
        eids = metadata.get('external_ids', {})
        if isinstance(eids, dict): imdb_id = eids.get('imdb_id')
        
    if imdb_id:
        try:
            url = f"https://www.omdbapi.com/?i={imdb_id}&apikey={omdb_key}&plot=full"
            r = requests.get(url, timeout=5)
            if r.status_code == 200:
                data = r.json()
                if data.get('Response') != 'False':
                    # Map fields to match render_task expectations
                    ratings = data.get('Ratings', [])
                    for rate in ratings:
                        if rate['Source'] == 'Rotten Tomatoes':
                            metadata['omdb_rotten_tomatoes'] = rate['Value'].replace('%', '')
                        elif rate['Source'] == 'Metacritic':
                            metadata['omdb_metacritic'] = rate['Value'].split('/')[0]
                    
                    if data.get('Awards') != 'N/A': metadata['omdb_awards'] = data['Awards']
                    if data.get('Country') != 'N/A': metadata['omdb_country'] = data['Country']
                    if data.get('Rated') != 'N/A': metadata['omdb_rated'] = data['Rated']
                    if data.get('Writer') != 'N/A': metadata['omdb_writer'] = data['Writer']
                    if data.get('imdbRating') != 'N/A': metadata['omdb_imdb_rating'] = data['imdbRating']
                    if data.get('BoxOffice') and data.get('BoxOffice') != 'N/A': metadata['omdb_box_office'] = data.get('BoxOffice')
                    if data.get('Plot') != 'N/A':
                        metadata['omdb_plot_full'] = data['Plot']
                        metadata['omdb_plot'] = data['Plot']
        except Exception as e:
            log(f"OMDb fetch error: {e}")
    return metadata

def run_node_renderer(layout_path, metadata, output_base_path):
    # Extract IMDb ID to ensure render_task.js can fetch OMDb data
    imdb_id = metadata.get('imdb_id')
    if not imdb_id:
        # Check provider_ids (Jellyfin/Emby)
        pids = metadata.get('provider_ids')
        if isinstance(pids, dict):
            imdb_id = pids.get('Imdb')
    
    if not imdb_id:
        # Check external_ids (TMDB)
        eids = metadata.get('external_ids')
        if isinstance(eids, dict):
            imdb_id = eids.get('imdb_id')

    # 1. Daten-Payload als JSON-String vorbereiten
    data_payload = {
        "title": metadata.get('title'),
        "year": metadata.get('year'),
        "overview": metadata.get('overview'),
        "genres": metadata.get('genres'),
        "runtime": metadata.get('runtime'),
        "rating": metadata.get('rating'),
        "officialRating": metadata.get('officialRating'),
        "actors": metadata.get('actors', []),
        "directors": metadata.get('directors', []),
        "source": metadata.get('source', 'Jellyfin'),
        "id": metadata.get('id'),
        "action_url": metadata.get('action_url'),
        "provider_ids": metadata.get('provider_ids'),
        "imdb_id": imdb_id,
        "backdrop_url": metadata.get('backdrop_url'),
        "logo_url": metadata.get('logo_url')
    }

    # Pass through any OMDb fields that were enriched in Python
    for k, v in metadata.items():
        if k.startswith('omdb_'):
            data_payload[k] = v

    data_json_string = json.dumps(data_payload, ensure_ascii=False)

    # 2. Erwartete Ausgabepfade definieren
    output_image_path = f"{output_base_path}.jpg"
    output_json_path = f"{output_base_path}.json"
    output_ambilight_path = f"{output_base_path}.ambilight.jpg"

    # 3. Node.js-Prozess ausführen
    image_b64 = None
    ambilight_b64 = None
    final_json = None
    temp_layout_path = None
    
    try:
        script_dir = os.path.dirname(os.path.abspath(__file__))
        script_path = os.path.join(script_dir, 'render_task.js')
        
        # --- Layout Pre-Processing: Replace URLs with Local Paths ---
        # Fixes ECONNRESET by avoiding loopback network calls for local assets
        try:
            with open(layout_path, 'r', encoding='utf-8') as f:
                layout_content = f.read()
            
            provider_logos_dir = os.path.join(script_dir, 'static', 'provider_logos')
            
            # 1. Replace Provider Logos (http://.../static/provider_logos/X -> file:///app/provider_logos/X)
            def repl_logo(m):
                return f"file://{os.path.join(provider_logos_dir, m.group(1))}"
            
            layout_content = re.sub(r'http[s]?://[^"\']+/static/provider_logos/([^"\']+)', repl_logo, layout_content)
            
            # 2. Unwrap Proxy URLs (http://.../api/proxy/image?url=X -> X)
            def repl_proxy(m):
                return unquote(m.group(1))
            
            layout_content = re.sub(r'http[s]?://[^"\']+/api/proxy/image\?url=([^"\']+)', repl_proxy, layout_content)
            
            # Write to temp file
            with tempfile.NamedTemporaryFile(mode='w', delete=False, suffix='.json', encoding='utf-8') as tf:
                tf.write(layout_content)
                temp_layout_path = tf.name
        except Exception as e:
            log(f"Layout preprocessing warning: {e}")
            temp_layout_path = layout_path # Fallback to original

        # Der neue, korrekte Befehl mit drei Argumenten
        cmd = [
            'node',
            script_path,
            temp_layout_path,
            output_base_path,
            data_json_string
        ]
        
        result = subprocess.run(cmd, capture_output=True, text=True, encoding='utf-8', cwd=script_dir)
        
        if result.stderr: log(f"STDERR: {result.stderr.strip()}")

        if result.returncode == 0:
            if os.path.exists(output_image_path):
                with open(output_image_path, 'rb') as f:
                    image_b64 = f"data:image/jpeg;base64,{base64.b64encode(f.read()).decode('utf-8')}"
            
            if os.path.exists(output_ambilight_path):
                with open(output_ambilight_path, 'rb') as f:
                    ambilight_b64 = f"data:image/jpeg;base64,{base64.b64encode(f.read()).decode('utf-8')}"
            
            if os.path.exists(output_json_path):
                with open(output_json_path, 'r', encoding='utf-8') as f:
                    final_json = json.load(f)
        else:
            log("--- NODE.JS CRASH REPORT --- (Details siehe oben)")

    except Exception as e:
        log(f"Render Execution Error: {e}")
    
    finally:
        # Temporäre Dateien, die von Node.js erstellt wurden, aufräumen
        for p in [output_image_path, output_json_path, output_ambilight_path]:
            if p and os.path.exists(p):
                try: os.remove(p)
                except: pass
        
        # Clean up temp layout file
        if temp_layout_path and temp_layout_path != layout_path and os.path.exists(temp_layout_path):
            try: os.remove(temp_layout_path)
            except: pass

    return image_b64, ambilight_b64, final_json, None

    # --- ENDE DER ANGEPASSTEN FUNKTION ---

def fetch_jellyfin_cron(config, job):
    jf = config.get('jellyfin', {})
    if not jf.get('url'): return []
    headers = jellyfin_headers(jf['api_key'])
    base_url = jf['url'].rstrip('/')
    user_id = resolve_jellyfin_user_id(base_url, jf['api_key'], jf.get('user_id'))
    
    boxset_ids = set()
    try:
        bs_url = f"{jellyfin_items_base(base_url, user_id)}?IncludeItemTypes=BoxSet&Recursive=true&Fields=Id"
        r_bs = requests.get(bs_url, headers=headers, timeout=10)
        if r_bs.status_code == 200:
            for b in r_bs.json().get('Items', []): boxset_ids.add(b['Id'])
    except: pass

    fmode = job.get('filter_mode', 'all')
    params = [
        f"IncludeItemTypes={job.get('item_types', 'Movie,Series')}",
        "Recursive=true", "ExcludeItemTypes=BoxSet",
        "Fields=Overview,Genres,OfficialRating,CommunityRating,ProviderIds,ProductionYear,RunTimeTicks,OriginalTitle,Tags,Studios,InheritedParentalRatingValue,ImageTags,ParentId,People,UserData,Type"
    ]

    jf_watch_filter = media_status.jellyfin_filter_param(fmode)
    if jf_watch_filter:
        params.append(f"Filters={jf_watch_filter}")
    
    if job.get('source_mode') == 'random':
        params.append("SortBy=Random")
        params.append(f"Limit={job.get('random_count', 10)}")
    else:
        limit = job.get('limit', '0')
        if limit != '0': params.append(f"Limit={limit}")
        
        fval = job.get('filter_value', '')
        if fmode == 'recent':
            params.append("SortBy=DateCreated")
            params.append("SortOrder=Descending")
        elif fmode == 'year' and fval:
            params.append(f"Years={fval}")
        elif fmode == 'genre' and fval:
            params.append(f"Genres={fval}")
        elif fmode == 'rating' and fval:
            params.append(f"MinCommunityRating={fval}")
            params.append("SortBy=CommunityRating")
            params.append("SortOrder=Descending")
        elif jf_watch_filter:
            params.append("SortBy=DatePlayed" if fmode == 'watched' else "SortBy=SortName")
            if fmode == 'watched':
                params.append("SortOrder=Descending")
        else:
            params.append("SortBy=SortName")

    url = f"{jellyfin_items_base(base_url, user_id)}?{'&'.join(params)}"
    try:
        r = requests.get(url, headers=headers)
        items = r.json().get('Items', [])
        meta_items = []
        for it in items:
            if it.get('ParentId') in boxset_ids and 'Logo' in it.get('ImageTags', {}):
                # keep logo suppression for boxset children via format path
                pass
            formatted = format_jellyfin_item(it, base_url, jf['api_key'], user_id, config)
            if it.get('ParentId') in boxset_ids:
                formatted['logo_url'] = None
            formatted['action_url'] = f"jellyfin://items/{it.get('Id')}"

            # Client-side fallback if server Filters unsupported
            if jf_watch_filter and not media_status.matches_watch_filter(formatted.get('watch_state'), fmode):
                continue
            meta_items.append(formatted)
        return meta_items
    except Exception as e:
        log(f"Jellyfin cron fetch error: {e}")
        return []

def fetch_plex_cron(config, job):
    p = config.get('plex', {})
    if not p.get('url') or not p.get('token'): return []
    url = p['url'].rstrip('/')
    token = p['token']
    headers = {"Accept": "application/json"}
    try:
        r_sections = requests.get(f"{url}/library/sections?X-Plex-Token={token}", headers=headers, timeout=5)
        if r_sections.status_code != 200: return []
        sections = r_sections.json().get('MediaContainer', {}).get('Directory', [])
        
        item_types = job.get('item_types', 'Movie,Series')
        plex_types = []
        if 'Movie' in item_types: plex_types.append('movie')
        if 'Series' in item_types: plex_types.append('show')
        
        meta_items = []
        for s in sections:
            if s.get('type') in plex_types:
                sid = s.get('key')
                r_items = requests.get(f"{url}/library/sections/{sid}/all?X-Plex-Token={token}", headers=headers, timeout=10)
                if r_items.status_code == 200:
                    items = r_items.json().get('MediaContainer', {}).get('Metadata', [])
                    for it in items:
                        duration_ms = it.get('duration', 0)
                        h, m = divmod(duration_ms // 60000, 60)
                        runtime = f"{h}h {m}min" if h > 0 else f"{m}min"
                        
                        meta_items.append({
                            "id": it.get('ratingKey'),
                            "title": it.get('title'),
                            "year": it.get('year'),
                            "overview": it.get('summary'),
                            "rating": it.get('rating') or it.get('audienceRating'),
                            "officialRating": it.get('contentRating'),
                            "genres": ", ".join([g.get('tag') for g in it.get('Genre', [])]),
                            "runtime": runtime,
                            "backdrop_url": f"{url}/library/metadata/{it['ratingKey']}/art?X-Plex-Token={token}",
                            "logo_url": f"{url}/library/metadata/{it['ratingKey']}/clearLogo?X-Plex-Token={token}",
                            "source": "Plex",
                            "actors": [r.get('tag') for r in it.get('Role', [])],
                            "directors": [d.get('tag') for d in it.get('Director', [])]
                        })
        return meta_items
    except: return []

def fetch_trakt_cron(config, job):

    # Simplified placeholder for now
    return []


def fetch_sonarr_cron(config, job):
    s = config.get('sonarr', {})
    if not s.get('url') or not s.get('api_key'): return []
    url = f"{s['url'].rstrip('/')}/api/v3/calendar"
    headers = {"X-Api-Key": s['api_key']}
    
    # --- Handle 'Missing' Filter Mode ---
    if job.get('filter_mode') == 'missing':
        url = f"{s['url'].rstrip('/')}/api/v3/wanted/missing"
        # Fetch a reasonable amount of missing items
        params = {
            "page": 1,
            "pageSize": 100, 
            "sortKey": "airDateUtc",
            "sortDir": "desc"
        }
        try:
            r = requests.get(url, headers=headers, params=params, timeout=15)
            if r.status_code == 200:
                data = r.json()
                records = data.get('records', [])
                meta_items = []
                seen_series = set()
                
                for item in records:
                    series = item.get('series', {})
                    sid = series.get('id')
                    
                    # Group by Series: Skip if we already have this series
                    if sid in seen_series: continue
                    
                    # Resolve TMDB ID via TVDB ID
                    tvdb_id = series.get('tvdbId')
                    if tvdb_id:
                        tmdb_id = resolve_tmdb_from_tvdb(tvdb_id, config)
                        if tmdb_id:
                            details = fetch_tmdb_details(tmdb_id, 'tv', config)
                            if details:
                                details['id'] = sid # Use Sonarr ID for consistency
                                details['source'] = "Sonarr Missing"
                                meta_items.append(details)
                                seen_series.add(sid)
                
                # Apply limit if specified
                limit = int(job.get('limit', 0))
                if limit > 0:
                    return meta_items[:limit]
                return meta_items
        except Exception as e:
            log(f"Sonarr Missing fetch error: {e}")
        return []
    # ------------------------------------

    days = int(job.get('days_ahead', 7)) # Custom field or default
    params = {
        "start": datetime.utcnow().date().isoformat(),
        "end": (datetime.utcnow() + timedelta(days=days)).date().isoformat()
    }
    try:
        r = requests.get(url, headers=headers, params=params, timeout=10)
        if r.status_code == 200:
            episodes = r.json()
            meta_items = []
            seen_series = set()
            for ep in episodes:
                series = ep.get('series', {})
                sid = series.get('id')
                if sid and sid not in seen_series:
                    tvdb_id = series.get('tvdbId')
                    tmdb_id = None
                    # Try resolve TMDB ID if possible
                    if tvdb_id: tmdb_id = resolve_tmdb_from_tvdb(tvdb_id, config)
                    
                    if tmdb_id:
                        details = fetch_tmdb_details(tmdb_id, 'tv', config)
                        if details:
                            details['id'] = sid
                            details['source'] = "Sonarr"
                            meta_items.append(details)
                            seen_series.add(sid)
                            continue
                    
                    # Fallback
                    meta_items.append({
                        "id": sid,
                        "title": series.get('title'),
                        "year": series.get('year'),
                        "overview": series.get('overview', ''),
                        "imdb_id": series.get('imdbId'),
                        "source": "Sonarr"
                    })
                    seen_series.add(sid)
            return meta_items
    except: pass
    return []

def resolve_tmdb_from_tvdb(tvdb_id, config):
    """Helper to resolve TMDB ID from TVDB ID using TMDB API."""
    tmdb_api_key = config.get('tmdb', {}).get('api_key')
    if not tmdb_api_key: return None
    
    find_url = f"https://api.themoviedb.org/3/find/{tvdb_id}?api_key={tmdb_api_key}&external_source=tvdb_id"
    try:
        r_tmdb = requests.get(find_url, timeout=5)
        if r_tmdb.status_code == 200:
            results = r_tmdb.json().get('tv_results', [])
            if results: return results[0]['id']
    except: pass
    return None

def fetch_radarr_cron(config, job):
    r_conf = config.get('radarr', {})
    if not r_conf.get('url') or not r_conf.get('api_key'): return []
    url = f"{r_conf['url'].rstrip('/')}/api/v3/movie"
    headers = {"X-Api-Key": r_conf['api_key']}

    # --- Handle 'Missing' Filter Mode ---
    if job.get('filter_mode') == 'missing':
        url = f"{r_conf['url'].rstrip('/')}/api/v3/wanted/missing"
        params = {"page": 1, "pageSize": 100, "sortKey": "releaseDate", "sortDir": "desc"}
        
        try:
            r = requests.get(url, headers=headers, params=params, timeout=15)
            if r.status_code == 200:
                data = r.json()
                records = data.get('records', [])
                meta_items = []
                
                for m in records:
                    tmdb_id = m.get('tmdbId')
                    if tmdb_id:
                        details = fetch_tmdb_details(tmdb_id, 'movie', config)
                        if details:
                            details['id'] = m.get('id')
                            details['source'] = "Radarr Missing"
                            meta_items.append(details)
                
                limit = int(job.get('limit', 0))
                if limit > 0: return meta_items[:limit]
                return meta_items
        except Exception as e:
            log(f"Radarr Missing fetch error: {e}")
        return []
    # ------------------------------------

    try:
        r = requests.get(url, headers=headers, timeout=10)
        if r.status_code == 200:
            movies = r.json()
            meta_items = []
            days = int(job.get('days_ahead', 7))
            start = datetime.utcnow().date()
            end = start + timedelta(days=days)
            
            for m in movies:
                # Filter for upcoming/missing
                if not m.get('monitored') or m.get('hasFile'): continue
                
                # Check release dates
                digital = m.get('digitalRelease')
                physical = m.get('physicalRelease')
                in_range = False
                for d_str in [digital, physical]:
                    if d_str:
                        try:
                            d_dt = datetime.strptime(d_str, "%Y-%m-%dT%H:%M:%SZ").date()
                            if start <= d_dt <= end: in_range = True; break
                        except: pass
                
                if not in_range: continue
                
                tmdb_id = m.get('tmdbId')
                if tmdb_id:
                    details = fetch_tmdb_details(tmdb_id, 'movie', config)
                    if details:
                        details['id'] = m.get('id')
                        details['source'] = "Radarr"
                        meta_items.append(details)
                        continue
                
                # Fallback
                meta_items.append({
                    "id": m.get('id'),
                    "title": m.get('title'),
                    "year": m.get('year'),
                    "overview": m.get('overview', ''),
                    "imdb_id": m.get('imdbId'),
                    "source": "Radarr"
                })
            return meta_items
    except: pass
    return []

def fetch_tmdb_cron(config, job):
    t = config.get('tmdb', {})
    api_key = t.get('api_key')
    if not api_key: return []
    
    # Default limit for trending if not specified
    limit = int(job.get('limit', 20))
    if limit == 0: limit = 20
    
    url = f"https://api.themoviedb.org/3/trending/all/week?api_key={api_key}"
    meta_items = []
    try:
        r = requests.get(url, timeout=10)
        if r.status_code == 200:
            results = r.json().get('results', [])
            for item in results[:limit]:
                media_type = item.get('media_type')
                if media_type not in ['movie', 'tv']: continue
                
                details = fetch_tmdb_details(item['id'], media_type, config)
                if details:
                    details['source'] = "TMDB"
                    meta_items.append(details)
    except: pass
    return meta_items


def fetch_seerr_cron(config, job):
    conf = seerr_client.get_seerr_conf(config)
    if not conf.get("url") or not conf.get("api_key"):
        return []

    # source_mode trending is default for seerr jobs
    time_window = job.get("seerr_time_window") or conf.get("trending_window") or "week"
    availability = job.get("seerr_availability") or job.get("filter_value") or "all"
    if job.get("filter_mode") in ("available", "not_available", "requestable"):
        availability = job.get("filter_mode")
    limit = job.get("limit", 20)
    try:
        limit_n = int(limit) if str(limit) != "0" else 20
    except Exception:
        limit_n = 20

    item_types = job.get("item_types", "Movie,Series")
    lang = (config.get("tmdb") or {}).get("language")
    meta_items = []
    try:
        items = seerr_client.fetch_trending_items(
            conf["url"],
            conf["api_key"],
            media_types=item_types,
            time_window=time_window,
            availability=availability,
            limit=limit_n,
            language=lang,
        )
        for it in items:
            mapped = format_seerr_item(it, config)
            if mapped:
                meta_items.append(mapped)
    except Exception as e:
        log(f"Seerr cron fetch error: {e}")
    return meta_items


def fetch_items_and_process(job=None):
    if not job: return
    job_name = job.get('name', 'Unnamed Job')
    log(f"Starting Cron Job: {job_name}")
    config = load_config()
    layout_name = job.get('layout_name', 'Default')
    layout_full_path = os.path.join(os.path.dirname(__file__), 'layouts', f"{layout_name}.json")
    if not os.path.exists(layout_full_path):
        log(f"Layout not found: {layout_name}"); return

    providers = job.get('providers', ['jellyfin'])
    all_meta = []
    for p in providers:
        p = p.strip().lower()
        if p == 'jellyfin': all_meta.extend(fetch_jellyfin_cron(config, job))
        elif p == 'plex': all_meta.extend(fetch_plex_cron(config, job))
        elif p == 'trakt': all_meta.extend(fetch_trakt_cron(config, job))
        elif p == 'sonarr': 
            all_meta.extend(fetch_sonarr_cron(config, job))
        elif p == 'radarr': 
            all_meta.extend(fetch_radarr_cron(config, job))
        elif p == 'tmdb': all_meta.extend(fetch_tmdb_cron(config, job))
        elif p in ('jellyseerr', 'seerr'):
            all_meta.extend(fetch_seerr_cron(config, job))


    log(f"Processing {len(all_meta)} items from {', '.join(providers)}...")

    # --- CLEANUP LOGIC ---
    if job.get('cleanup', False):
        if len(all_meta) > 0:
            log("Cleanup active: Removing orphan files...")
            target_dir = os.path.join(os.path.dirname(__file__), 'editor_backgrounds', layout_name)
            if os.path.exists(target_dir):
                valid_filenames = set()
                valid_ids = set()
                
                for meta in all_meta:
                    # 1. Track valid IDs
                    if meta.get('id'):
                        valid_ids.add(str(meta.get('id')))
                    
                    # 2. Track valid Filenames (Fallback)
                    safe_title = "".join(c for c in meta.get('title', '') if c.isalnum() or c in " ._-").strip()
                    base = f"{safe_title} - {meta.get('year')}"
                    valid_filenames.add(base)
                
                for f in os.listdir(target_dir):
                    if f.endswith('.json'):
                        json_path = os.path.join(target_dir, f)
                        should_delete = False
                        try:
                            with open(json_path, 'r', encoding='utf-8') as jf:
                                data = json.load(jf)
                                meta_id = str(data.get('metadata', {}).get('id', ''))
                                
                                if meta_id and meta_id in valid_ids:
                                    should_delete = False # ID match -> Keep
                                else:
                                    # No ID match (or no ID in file). Check filename as fallback.
                                    base_name = f.replace('.json', '')
                                    if base_name not in valid_filenames:
                                        should_delete = True
                        except:
                            should_delete = False # Error reading -> Skip to be safe
                        
                        if should_delete:
                            base = f.replace('.json', '')
                            for ext in ['.json', '.jpg', '.ambilight.jpg']:
                                try: os.remove(os.path.join(target_dir, base + ext))
                                except: pass
        else:
            log("Cleanup skipped: No items found (Safety check).")

    for meta in all_meta:
        if os.path.exists(STOP_SIGNAL_FILE): break

        # Check if job still exists/enabled
        if job.get('id'):
            try:
                curr_conf = load_config()
                active = next((j for j in curr_conf.get('cron_jobs', []) if j.get('id') == job['id']), None)
                if not active or not active.get('enabled', True):
                    log(f"Job {job.get('name')} changed state. Stopping."); break
            except: pass

        safe_title = "".join(c for c in meta.get('title', '') if c.isalnum() or c in " ._-").strip()
        if job.get('dry_run'):
            log(f"[Dry Run] Processing: {safe_title}"); continue
            
        output_base_name = f"{safe_title} - {meta.get('year')}"
        filename_for_api = f"{output_base_name}.jpg"

        # Refresh watch status forces overwrite so badges update on schedule
        do_overwrite = bool(job.get('overwrite', False) or job.get('refresh_watch_status', False))
        if not do_overwrite:
            target_dir = os.path.join(os.path.dirname(__file__), 'editor_backgrounds', layout_name)
            if os.path.exists(os.path.join(target_dir, filename_for_api)):
                log(f"Skipping {safe_title} (Exists)"); continue
        
        log(f"Rendering: {meta['title']} ({meta.get('source', 'Unknown')}) [{meta.get('watch_state') or meta.get('library_state') or '-'}]")
        
        # Enrich with OMDb data before rendering
        meta = enrich_with_omdb(meta, config)
        
        with tempfile.TemporaryDirectory() as temp_dir:
            temp_output_base_path = os.path.join(temp_dir, 'output')
            img_b64, ambilight_b64, json_data, _ = run_node_renderer(layout_full_path, meta, temp_output_base_path)
            if img_b64 and json_data:
                payload = {"image": img_b64, "layout_name": layout_name, "metadata": meta, "canvas_json": json_data, "overwrite_filename": filename_for_api, "target_type": "gallery"}
                if ambilight_b64: payload['ambilight_image_data'] = ambilight_b64
                try: requests.post(API_URL, json=payload)
                except Exception as e: log(f"Upload failed: {e}")
            else: log("Rendering failed.")
    log("Batch Finished.")


def run_scheduler():
    log("Scheduler Mode Started")
    last_run_minutes = {}

    while True:
        if os.path.exists(STOP_SIGNAL_FILE):
            log("Stop signal received. Exiting scheduler.")
            os.remove(STOP_SIGNAL_FILE)
            break
            
        try:
            config = load_config()
            jobs = config.get('cron_jobs', [])
            
            for i, job in enumerate(jobs):
                job_id = job.get('id', str(i))
                
                if not job.get('enabled', True): continue

                if job.get('force_run'):
                    log(f"Force Run triggered for: {job.get('name')}")
                    fetch_items_and_process(job)
                    jobs[i]['force_run'] = False
                    config['cron_jobs'] = jobs
                    save_config(config)
                    continue

                now = datetime.now()
                start_str = job.get('start_time', '00:00')
                try:
                    start_h, start_m = map(int, start_str.split(':'))
                except:
                    start_h, start_m = 0, 0
                
                freq_raw = job.get('frequency', '1')
                should_run = False
                
                current_total_minutes = now.hour * 60 + now.minute
                
                if str(freq_raw) == 'weekly':
                    # Run on Monday (0) at start_time
                    if now.weekday() == 0 and now.hour == start_h and now.minute == start_m:
                        should_run = True
                elif str(freq_raw) == 'monthly':
                    # Run on 1st day of month at start_time
                    if now.day == 1 and now.hour == start_h and now.minute == start_m:
                        should_run = True
                else:
                    # Numeric frequency (times per day)
                    try: freq = int(freq_raw)
                    except: freq = 1
                    if freq < 1: freq = 1
                    
                    interval_minutes = (24 * 60) / freq
                    start_total_minutes = start_h * 60 + start_m
                    
                    for k in range(freq):
                        target = (start_total_minutes + (k * interval_minutes)) % (24 * 60)
                        if int(target) == current_total_minutes:
                            should_run = True
                            break
                
                if should_run:
                    if last_run_minutes.get(job_id) != current_total_minutes:
                        log(f"Schedule Trigger: {job.get('name')} ({freq_raw})")
                        fetch_items_and_process(job)
                        last_run_minutes[job_id] = current_total_minutes

        except Exception as e:
            log(f"Scheduler Error: {e}")
        
        time.sleep(10)

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument('--scheduler', action='store_true', help='Run in scheduler mode')
    args = parser.parse_args()
    
    if args.scheduler:
        run_scheduler()
    else:
        config = load_config()
        jobs = config.get('cron_jobs', [])
        for i, job in enumerate(jobs):
            if job.get('force_run'):
                fetch_items_and_process(job)
                jobs[i]['force_run'] = False
                config['cron_jobs'] = jobs
                save_config(config)
        
        if os.path.exists(STOP_SIGNAL_FILE):
            os.remove(STOP_SIGNAL_FILE)