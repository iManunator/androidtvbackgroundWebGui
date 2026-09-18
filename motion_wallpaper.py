"""Bake short Ken-Burns H.264 loops from wallpaper JPEGs for Projectivy VIDEO mode."""

from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
from typing import Any, Dict, Optional, Tuple

# light = TV-friendly size/bitrate; standard = slightly sharper
_QUALITY = {
    "light": {"w": 1920, "h": 1080, "fps": 24, "duration": 3.0, "bitrate": "1800k", "zoom": 1.035},
    "standard": {"w": 1920, "h": 1080, "fps": 25, "duration": 4.0, "bitrate": "2800k", "zoom": 1.045},
}


def ffmpeg_bin() -> Optional[str]:
    return shutil.which("ffmpeg")


def motion_enabled(config: Optional[dict] = None) -> bool:
    if config is None:
        try:
            from gui_editor import load_config
            config = load_config()
        except Exception:
            return False
    general = (config or {}).get("general") or {}
    return bool(general.get("motion_wallpapers", False))


def motion_quality(config: Optional[dict] = None) -> str:
    if config is None:
        try:
            from gui_editor import load_config
            config = load_config()
        except Exception:
            return "light"
    general = (config or {}).get("general") or {}
    q = str(general.get("motion_quality") or "light").strip().lower()
    return q if q in _QUALITY else "light"


def mp4_path_for_jpg(jpg_path: str) -> str:
    root, _ = os.path.splitext(jpg_path)
    return root + ".mp4"


def has_motion_clip(jpg_path: str) -> bool:
    mp4 = mp4_path_for_jpg(jpg_path)
    try:
        return bool(jpg_path and os.path.isfile(jpg_path) and os.path.isfile(mp4) and os.path.getsize(mp4) > 1000)
    except OSError:
        return False


def generate_motion_mp4(
    jpg_path: str,
    *,
    quality: str = "light",
    force: bool = False,
) -> Tuple[bool, str]:
    """
    Create sibling .mp4 for jpg_path.
    Returns (ok, message).
    """
    if not jpg_path or not os.path.isfile(jpg_path):
        return False, "jpeg missing"
    mp4 = mp4_path_for_jpg(jpg_path)
    if not force and has_motion_clip(jpg_path):
        return True, "already exists"

    ff = ffmpeg_bin()
    if not ff:
        return False, "ffmpeg not found"

    preset = _QUALITY.get(quality) or _QUALITY["light"]
    w, h = preset["w"], preset["h"]
    fps = int(preset["fps"])
    duration = float(preset["duration"])
    bitrate = preset["bitrate"]
    max_zoom = float(preset["zoom"])
    frames = max(int(round(duration * fps)), 2)

    # Smooth zoom pulse (no commas in expr → cleaner filtergraph parsing)
    # Amplitude = max_zoom - 1
    amp = max_zoom - 1.0
    zoompan = (
        f"zoompan=z='1+{amp}*sin(2*PI*on/{frames})':"
        f"x='iw/2-(iw/zoom/2)':"
        f"y='ih/2-(ih/zoom/2)+({amp}*20)*sin(2*PI*on/{frames})':"
        f"d=1:s={w}x{h}:fps={fps}"
    )
    vf = f"scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h},{zoompan}"

    tmp_fd, tmp_path = tempfile.mkstemp(suffix=".mp4")
    os.close(tmp_fd)
    try:
        cmd = [
            ff, "-y",
            "-loop", "1",
            "-i", jpg_path,
            "-vf", vf,
            "-t", str(duration),
            "-r", str(fps),
            "-c:v", "libx264",
            "-pix_fmt", "yuv420p",
            "-profile:v", "main",
            "-level", "4.0",
            "-b:v", bitrate,
            "-maxrate", bitrate,
            "-bufsize", "4M",
            "-movflags", "+faststart",
            "-an",
            tmp_path,
        ]
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=120,
        )
        if result.returncode != 0 or not os.path.isfile(tmp_path) or os.path.getsize(tmp_path) < 1000:
            err = (result.stderr or result.stdout or "ffmpeg failed").strip().splitlines()
            tail = err[-8:] if err else ["ffmpeg failed"]
            return False, " | ".join(tail)
        # Atomic-ish replace
        if os.path.exists(mp4):
            try:
                os.remove(mp4)
            except OSError:
                pass
        shutil.move(tmp_path, mp4)
        return True, mp4
    except subprocess.TimeoutExpired:
        return False, "ffmpeg timeout"
    except Exception as e:
        return False, str(e)
    finally:
        if os.path.exists(tmp_path):
            try:
                os.remove(tmp_path)
            except OSError:
                pass


def maybe_generate_after_save(jpg_path: str, config: Optional[dict] = None) -> Optional[str]:
    """If motion wallpapers enabled, bake MP4 next to JPEG. Returns mp4 path or None."""
    if not motion_enabled(config):
        return None
    ok, msg = generate_motion_mp4(jpg_path, quality=motion_quality(config), force=True)
    if ok and has_motion_clip(jpg_path):
        return mp4_path_for_jpg(jpg_path)
    if not ok:
        print(f"WARN: motion wallpaper failed for {jpg_path}: {msg}")
    return None


def backfill_layout(layout_dir: str, *, quality: str = "light", force: bool = False, limit: int = 0) -> Dict[str, Any]:
    """Generate missing motion clips under a layout folder."""
    created = 0
    skipped = 0
    failed = 0
    errors = []
    if not layout_dir or not os.path.isdir(layout_dir):
        return {"created": 0, "skipped": 0, "failed": 0, "errors": ["layout missing"]}
    count = 0
    for root, _, files in os.walk(layout_dir):
        for name in files:
            lower = name.lower()
            if not lower.endswith((".jpg", ".jpeg")):
                continue
            if ".ambilight" in lower:
                continue
            jpg = os.path.join(root, name)
            if not force and has_motion_clip(jpg):
                skipped += 1
                continue
            ok, msg = generate_motion_mp4(jpg, quality=quality, force=force)
            if ok:
                created += 1
            else:
                failed += 1
                errors.append(f"{name}: {msg}")
            count += 1
            if limit and count >= limit:
                return {"created": created, "skipped": skipped, "failed": failed, "errors": errors[:20]}
    return {"created": created, "skipped": skipped, "failed": failed, "errors": errors[:20]}
