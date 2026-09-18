# TV Background Suite & Web Editor

**TV Background Suite** is a web-based tool for generating customized background images and posters for media servers like **Jellyfin**, **Plex**, and **Seerr/Jellyseerr**, or for Android TV launchers.

It includes a full WYSIWYG editor, streaming-style layout presets (Netflix / Prime / Google TV), watch-status badges, scheduled generation, and ID-based skip/replace so daily cron jobs stay fresh without duplicating titles.

| Editor Interface | Saved Layouts |
| :---: | :---: |
| ![Editor Preview](https://github.com/user-attachments/assets/9b536c40-632c-4d3d-901b-485116c68781) | ![Saved Layouts](https://github.com/user-attachments/assets/391a7fbf-f3ae-4ff8-b536-a01ee4f4ebba) |

| Guide Overlay (Google TV) | Guide Overlay (ProjectIvy) |
| :---: | :---: |
| ![Google TV](https://github.com/user-attachments/assets/b1525643-8a44-43dc-beaf-5f95b1d9de2a) | ![ProjectIvy](https://github.com/user-attachments/assets/72942128-19cf-4b17-9273-291ab7efe823) |

## Features

- **Web editor:** Drag-and-drop layouts, fonts, textures, overlays, and icons.
- **Providers:** Jellyfin, Plex, Seerr/Jellyseerr, Radarr, Sonarr, Trakt, TMDB, OMDb.
- **Streaming presets:** Netflix Hero, Prime Cinematic, Google TV Clean, Status Focus, Jellyfin Dense (left-top chrome).
- **Watch status:** Unwatched / Partly watched / Watched from Jellyfin (series use real episode counts).
- **Seerr integration:** Trending wallpapers, library state, request caption, ratings enrichment.
- **Cron & batch:** Schedule daily runs; **skip titles already generated** (IMDb/TMDB/Jellyfin id); **overwrite** replaces the same show; **cleanup** removes titles no longer in the list.
- **Gallery:** Browse, re-edit, and manage generated images.
- **Multi-language UI:** English, German, Italian, French, Polish, Czech, Spanish, Romanian.
- **Docker / Portainer ready.**

## Roadmap

- **Android TV App:** Fetch and rotate backgrounds on-device (planned).

---

## Projectivy Launcher Plugin

For **Projectivy Launcher**, use the dedicated plugin:

**[Projectivy TVBG Suite Plugin](https://github.com/iManunator/projectivy-tvbgsuite-plugin)** (fork) · upstream [z9m](https://github.com/z9m/projectivy-tvbgsuite-plugin)

Wallpaper pick modes use `/api/wallpaper/status` with `sort`, `pool`, and `exclude` (v1.6.1+). Optional **motion wallpapers** (v1.7+) bake short Ken-Burns MP4s beside JPEGs (`mediaType` / `videoUrl`); enable under Settings → Motion wallpapers (requires ffmpeg). After updating, rebuild the metadata cache so watch/library fields are available.

---

## Installation (Docker)

### GHCR image (this fork)

```text
ghcr.io/imanunator/androidtvbackgroundwebgui:latest
```

Also tagged: `jellyfin12`, `seerr`, and commit SHA tags from CI.

### Docker Compose

```yaml
services:
  tv-background:
    image: ghcr.io/imanunator/androidtvbackgroundwebgui:latest
    container_name: tv-background-editor
    ports:
      - "5000:5000"
    volumes:
      - ./config.json:/app/config.json
      - ./layouts:/app/layouts
      - ./overlays:/app/overlays
      - ./textures:/app/textures
      - ./fonts:/app/fonts
      - ./custom_icons:/app/custom_icons
      - ./output:/app/editor_backgrounds
    restart: unless-stopped
```

```bash
docker compose up -d
```

Open: `http://YOUR_SERVER_IP:5000/editor`

> Copy `config.example.json` → `config.json` and fill in API keys in the UI (Settings). Never commit `config.json` or `.env`.

### Docker Run

```bash
docker run -d \
  --name=tv-background-editor \
  -p 5000:5000 \
  -v /path/to/config.json:/app/config.json \
  -v /path/to/output:/app/editor_backgrounds \
  ghcr.io/imanunator/androidtvbackgroundwebgui:latest
```

---

## Configuration & volumes

| Container path | Description |
| :--- | :--- |
| `/app/config.json` | API keys, URLs, cron jobs (keep private). |
| `/app/layouts` | Saved layouts (includes bundled streaming presets). |
| `/app/overlays` | Guide overlays (PNG). |
| `/app/textures` | Text textures. |
| `/app/fonts` | Custom fonts (`.ttf` / `.otf`). |
| `/app/custom_icons` | Custom icons/logos. |
| `/app/editor_backgrounds` | **Output** gallery images. |

### Networking (DNS)

If the container cannot resolve a LAN hostname:

**Use IP** in settings, or:

```yaml
    extra_hosts:
      - "host.docker.internal:host-gateway"
```

Then use `http://host.docker.internal:8096` (or map your NAS hostname → IP).

---

## Usage

### Settings

Connect **Jellyfin**, **Seerr/Jellyseerr**, Plex, TMDB, etc. Use **Test connection** where available. Leave Jellyfin User ID blank to auto-resolve an admin user.

### Layouts

1. Click a streaming preset (e.g. **Netflix Hero**), or design your own.
2. **Shuffle** to preview random Jellyfin / Seerr / Plex / TMDB items.
3. Change **Layout Name** and **Save Layout** to keep a copy (built-in presets can be reseeded on upgrade).

### Cron (daily fresh wallpapers)

Recommended for Seerr trending or Jellyfin libraries:

| Option | Effect |
| :--- | :--- |
| **Overwrite off** (default) | Skip shows that already have a wallpaper (matched by IMDb / TMDB / Jellyfin id). Only **new** titles are generated. |
| **Overwrite / replace same show** | Delete prior wallpapers for that title, then recreate. |
| **Cleanup titles not in list** | Remove gallery files whose media is no longer in today’s Seerr/Jellyfin list. |
| **Refresh watch status** | Forces overwrite so watch badges update. |

Run daily (or more often): keep overwrite **off** + cleanup **on** to accumulate new titles and drop ones that left the list.

### Batch

Same skip / replace / cleanup behavior as cron when generating from the Batch tab.

---

## Security notes

- Store secrets only in **`config.json`** or a local **`.env`** (both gitignored).
- Use **`config.example.json`** / **`.env.example`** as templates (placeholders only).
- Do not commit real API keys, tokens, or user IDs.
- GHCR login in CI uses `GITHUB_TOKEN` (Actions secret), not a personal token in the repo.

---

## Gallery examples

| Predator (Magic Texture) | Freies Land (Clean Layout) |
| :---: | :---: |
| ![Predator Example](https://github.com/user-attachments/assets/a9d0beaf-222b-4a06-937c-5dace988dd3a) | ![Freies Land Example](https://github.com/user-attachments/assets/1a55062f-063d-4b4f-bb85-8aef3cd1d005) |
| **Indiana Jones (Logo Integration)** | **Amsterdam (Custom Font)** |
| ![Indiana Jones Example](https://github.com/user-attachments/assets/db6581c9-26b5-41f2-a787-05637e474632) | ![Amsterdam Example](https://github.com/user-attachments/assets/6751beb0-566b-45f3-9940-73e289394105) |

## Contributing

1. Fork the project  
2. Create a feature branch (`git checkout -b feature/AmazingFeature`)  
3. Commit (`git commit -m 'Add some AmazingFeature'`)  
4. Push and open a Pull Request  

## Credits

- **Original project:** [androidtvbackground](https://github.com/adelatour11/androidtvbackground) by adelatour11  
- **Upstream suite / Docker:** community forks including butch708’s TV Background Suite  
- **This fork:** Jellyfin 12 auth, Seerr, streaming layouts, watch status, cron ID skip/replace  

## License

Distributed under the MIT License.
