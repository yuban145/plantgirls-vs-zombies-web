"""Export web-ready game assets from the original PlantGirlsVsZombies content.

Run with the bundled python (has Pillow):
  python tools/build_assets.py

Inputs (read-only):
  D:\\逆向\\PlantGirlsVsZombies\\Content\\**                       original game assets
  D:\\逆向\\output\\PlantGirlsVsZombies\\decompiled\\Lawn\\**.cs     decompiled C# (for enums)
  data/atlas.json, data/resources.json                            generated manifests

Outputs (data/):
  tex/<Atlas>.webp            atlas textures
  tex/<image>.webp            standalone images
  sprites.json                image id -> atlas/rect, standalone image table
  fonts/*.ttf|otf             UI fonts
  music/*.ogg                 music tracks
  strings_zh.json             localized strings
  seedtypes.json              SeedType enum order (seed packet cel index)
"""

from __future__ import annotations

import glob
import json
import os
import re
import shutil
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import xnb  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
TEX = os.path.join(DATA, "tex")
CONTENT = r"D:\逆向\PlantGirlsVsZombies\Content"
IMAGES = os.path.join(CONTENT, "images", "600x1000")
DECOMPILED = r"D:\逆向\output\PlantGirlsVsZombies\decompiled\Lawn"
PY = sys.executable

# Atlases needed by the playable build: core entities + HUD art.
ATLASES = ["PlantsZombies", "SunFlower", "SeedAtlas", "Particles", "Loc_en", "Dialog"]

# Loc is a localized resource: the C# slicing table is named Loc_en but the
# shipped per-language texture holds the same layout with translated art.
LOC_TEXTURE = "zh_cn/loc"

# Standalone images (resources.xml path basename without extension).
STANDALONE = {
    "IMAGE_BACKGROUND1": "images/background1_hd",            # day lawn (1880x720)
    "IMAGE_BACKGROUND1UNSODDED": "images/background1unsodded_hd",
    "IMAGE_TITLESCREEN": "images/titlescreen",
    "IMAGE_SEEDPACKETS": "images/seedpackets_hd_2x",         # seed packet card art (modded, baked names)
    "IMAGE_PLANTSHADOW": "images/plantshadow",
    "IMAGE_PVZ_LOGO": "zh_cn/pvz_logo",
    "IMAGE_ZOMBIESWON": "zh_cn/zombieswon",
    "IMAGE_CONVEYORBELT_BELT": "images/belt",
    "IMAGE_CONVEYORBELT_BACKDROP": "images/conveyorbelt_backdrop",
    "IMAGE_SELECTORSCREEN_MAIN_BACKGROUND": "images/selector_main_background",
}

FONTS = {
    "LXGWWenKai-Bold.ttf": "LXGWWenKai-Bold.ttf",
    "SourceHanSansSC-Heavy.otf": "SourceHanSansSC-Heavy.otf",
    "TiejiliSC-Regular.ttf": "TiejiliSC-Regular.ttf",
}

MUSIC = ["day.ogg", "chooseyourseeds.ogg", "loonboon.ogg", "crazydave.ogg", "night.ogg", "pool.ogg"]

# Spine skeletons for the "plant girl" art (spine 4.2, .atlas + .skel + .png).
SPANIM = ["peashooter", "sunflower", "snowpea", "repeater", "chomper", "cattail", "agave"]

SEEDTYPE_ENUM = os.path.join(DECOMPILED, "Lawn", "SeedType.cs")


def log(msg: str) -> None:
    print(msg, flush=True)


def save_webp(img, path: str, quality: int = 92) -> tuple[int, int, int]:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    img.save(path, "WEBP", quality=quality, method=4)
    return img.width, img.height, os.path.getsize(path)


def resolve_atlas_texture(atlas_name: str, resources: dict, headers: dict) -> tuple[str, str]:
    """Return (xnb path, exported name) for an atlas name from the C# slicing table."""
    if atlas_name == "Loc_en":
        return os.path.join(IMAGES, *LOC_TEXTURE.split("/")) + ".xnb", "Loc"
    # Atlas name -> image resource whose path basename matches.
    for rid, entry in resources["images"].items():
        base = os.path.basename(entry["path"])
        if base.lower() == atlas_name.lower():
            path = entry["path"]  # e.g. images/PlantsZombies
            name = os.path.basename(path)
            localized = entry["attrs"].get("languageSpecific") == "true"
            if localized:
                return os.path.join(IMAGES, "zh_cn", name + ".xnb"), name
            return os.path.join(IMAGES, name + ".xnb"), name
    raise KeyError(f"no image resource for atlas {atlas_name}")


def resolve_standalone(resource_path: str) -> str:
    """resources.xml paths are relative to Content/ (with the 600x1000 subdir for images/)."""
    parts = resource_path.split("/")
    if parts[0] == "images" and len(parts) == 2:
        # 'zh_cn/pvz_logo' style handled by caller; plain images/xxx
        return os.path.join(IMAGES, parts[1] + ".xnb")
    raise KeyError(resource_path)


def main() -> None:
    t0 = time.time()
    os.makedirs(TEX, exist_ok=True)
    atlas = json.load(open(os.path.join(DATA, "atlas.json"), encoding="utf-8"))
    resources = json.load(open(os.path.join(DATA, "resources.json"), encoding="utf-8"))
    headers = json.load(open(os.path.join(DATA, "_image_headers.json"), encoding="utf-8"))
    image_index = atlas["imageIndex"]
    by_atlas = {}
    for name, entry in image_index.items():
        by_atlas.setdefault(entry["atlas"], {})[name] = entry

    sprites = {
        "_comment": "Generated by tools/build_assets.py. Rectangles are in texture pixels.",
        "atlases": {},
        "sprites": {},
        "images": {},
    }

    # ---- atlas textures -------------------------------------------------
    for atlas_name in ATLASES:
        xnb_path, out_name = resolve_atlas_texture(atlas_name, resources, headers)
        if not os.path.exists(xnb_path):
            log(f"!! missing atlas xnb: {xnb_path}")
            continue
        img, meta = xnb.load_texture(xnb_path)
        w, h, size = save_webp(img, os.path.join(TEX, out_name + ".webp"))
        log(f"atlas {atlas_name:14s} -> {out_name:14s} {w}x{h} {meta['surfaceName']:6s} {size/1e6:6.2f} MB")
        sprites["atlases"][atlas_name] = {"tex": out_name, "w": w, "h": h}
        for image_id, rect in by_atlas.get(atlas_name, {}).items():
            r = dict(rect)
            r.pop("atlas", None)
            r["a"] = atlas_name
            sprites["sprites"][image_id] = r

    # ---- standalone images ---------------------------------------------
    for image_id, rel in STANDALONE.items():
        # remaining language dirs for localized standalone art
        if rel.startswith("zh_cn/"):
            xnb_path = os.path.join(IMAGES, "zh_cn", rel.split("/", 1)[1] + ".xnb")
            out_name = rel.split("/", 1)[1]
        else:
            xnb_path = resolve_standalone(rel)
            out_name = os.path.basename(rel)
        if not os.path.exists(xnb_path):
            log(f"!! missing image xnb: {xnb_path}")
            continue
        img, meta = xnb.load_texture(xnb_path)
        w, h, size = save_webp(img, os.path.join(TEX, out_name + ".webp"), quality=95)
        res_entry = resources["images"].get(image_id, {})
        inv_scale = float(res_entry.get("attrs", {}).get("invscale", 1) or 1)
        rows = int(res_entry.get("attrs", {}).get("rows", 1) or 1)
        cols = int(res_entry.get("attrs", {}).get("cols", 1) or 1)
        sprites["images"][image_id] = {
            "tex": out_name,
            "w": w,
            "h": h,
            "invScale": inv_scale,
            "rows": rows,
            "cols": cols,
            "logicalW": w / inv_scale,
            "logicalH": h / inv_scale,
        }
        log(f"image {image_id:32s} {w}x{h} inv={inv_scale} rows={rows} cols={cols} {size/1e6:6.2f} MB")

    # ---- fonts ----------------------------------------------------------
    font_dir = os.path.join(DATA, "fonts")
    os.makedirs(font_dir, exist_ok=True)
    for dst, src in FONTS.items():
        src_path = os.path.join(CONTENT, "fonts", src)
        if os.path.exists(src_path):
            shutil.copyfile(src_path, os.path.join(font_dir, dst))
            log(f"font  {dst}")
        else:
            log(f"!! missing font {src_path}")

    # ---- music ----------------------------------------------------------
    music_dir = os.path.join(DATA, "music")
    os.makedirs(music_dir, exist_ok=True)
    for name in MUSIC:
        src_path = os.path.join(CONTENT, "music", name)
        if os.path.exists(src_path):
            shutil.copyfile(src_path, os.path.join(music_dir, name))
            log(f"music {name}")

    # ---- spine (plant girls) -------------------------------------------
    spanim_dir = os.path.join(DATA, "spanim")
    os.makedirs(spanim_dir, exist_ok=True)
    for stem in SPANIM:
        copied = 0
        # .atlas + .skel
        for ext in (".atlas", ".skel"):
            src_path = os.path.join(CONTENT, "spanim", stem + ext)
            if os.path.exists(src_path):
                shutil.copyfile(src_path, os.path.join(spanim_dir, stem + ext))
                copied += 1
        # every atlas texture page: <stem>.png, <stem>_2.png, <stem>_3.png ...
        pages = sorted(glob.glob(os.path.join(CONTENT, "spanim", stem + "*.png")))
        for page in pages:
            shutil.copyfile(page, os.path.join(spanim_dir, os.path.basename(page)))
            copied += 1
        log(f"spine {stem}: {copied} files ({len(pages)} page(s))")

    # ---- strings --------------------------------------------------------
    write_strings()

    # ---- seed type enum -------------------------------------------------
    write_seedtypes()

    with open(os.path.join(DATA, "sprites.json"), "w", encoding="utf-8") as fh:
        json.dump(sprites, fh, ensure_ascii=False, indent=0, separators=(",", ":"))
    log(f"sprites.json: {len(sprites['sprites'])} sprites, {len(sprites['atlases'])} atlases, "
        f"{len(sprites['images'])} images")
    log(f"done in {time.time()-t0:.1f}s")


def write_strings() -> None:
    """LawnStrings_zh_cn.txt: [KEY] blocks with a value line (may span lines)."""
    src = os.path.join(CONTENT, "LawnStrings_zh_cn.txt")
    text = open(src, encoding="utf-8-sig").read()
    strings: dict[str, str] = {}
    pos = 0
    pat = re.compile(r"^\[([^\]]+)\]\s*$", re.M)
    matches = list(pat.finditer(text))
    for i, m in enumerate(matches):
        key = m.group(1)
        end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        value = text[m.end():end].strip()
        # join wrapped lines but keep explicit \n escapes
        value = value.replace("\r\n", "\n")
        strings[key] = value
    out = os.path.join(DATA, "strings_zh.json")
    with open(out, "w", encoding="utf-8") as fh:
        json.dump(strings, fh, ensure_ascii=False, indent=0)
    log(f"strings_zh.json: {len(strings)} keys ({os.path.getsize(out)/1024:.0f} KB)")


def write_seedtypes() -> None:
    text = open(SEEDTYPE_ENUM, encoding="utf-8-sig").read()
    body = text[text.index("enum SeedType") + len("enum SeedType"):]
    body = body[body.index("{") + 1:body.index("}")]
    names = []
    for line in body.splitlines():
        line = line.strip()
        if not line or line.startswith("//"):
            continue
        name = line.split("=")[0].strip().rstrip(",")
        if not name or name.startswith("//"):
            continue
        names.append(name)
    out = os.path.join(DATA, "seedtypes.json")
    with open(out, "w", encoding="utf-8") as fh:
        json.dump(names, fh, ensure_ascii=False, indent=0)
    log(f"seedtypes.json: {len(names)} entries")


if __name__ == "__main__":
    main()
