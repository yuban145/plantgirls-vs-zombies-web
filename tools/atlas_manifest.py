#!/usr/bin/env python3
"""Resource + sprite-atlas manifest extractor for the PlantGirlsVsZombies web port.

Parses (read-only):
  - D:\\逆向\\PlantGirlsVsZombies\\Content\\resources.xml
  - D:\\逆向\\output\\PlantGirlsVsZombies\\decompiled\\Lawn\\Sexy\\AtlasResources_600x1000.cs
  - D:\\逆向\\output\\PlantGirlsVsZombies\\decompiled\\Lawn\\Sexy\\AtlasResources.cs

Writes:
  - D:\\逆向\\plangirls-web\\data\\atlas.json
  - D:\\逆向\\plangirls-web\\data\\resources.json

Stdlib only: re, xml.etree, json, os, sys, collections.
"""

import json
import os
import re
import sys
import xml.etree.ElementTree as ET
from collections import OrderedDict

RESOURCES_XML = r"D:\逆向\PlantGirlsVsZombies\Content\resources.xml"
ATLAS_CS = r"D:\逆向\output\PlantGirlsVsZombies\decompiled\Lawn\Sexy\AtlasResources_600x1000.cs"
STRINGTABLE_CS = r"D:\逆向\output\PlantGirlsVsZombies\decompiled\Lawn\Sexy\AtlasResources.cs"
OUT_DIR = r"D:\逆向\plangirls-web\data"
ATLAS_JSON = os.path.join(OUT_DIR, "atlas.json")
RESOURCES_JSON = os.path.join(OUT_DIR, "resources.json")

RE_UNPACK_METHOD = re.compile(r"public\s+override\s+void\s+Unpack(\w+)AtlasImages\s*\(\s*\)")
RE_MARRAYS = re.compile(r'mArrays\["([^"]+)"\]\s*=\s*array\s*;')
RE_UNPACK_INFO = re.compile(
    r"new\s+UNPACK_INFO\(\s*AtlasResources\.(IMAGE_\w+)\s*,\s*(-?\d+)\s*,\s*(-?\d+)\s*,"
    r"\s*(-?\d+)\s*,\s*(-?\d+)\s*,\s*(-?\d+)\s*,\s*(-?\d+)\s*,\s*AnimType\.(\w+)\s*,"
    r"\s*(-?\d+)\s*,\s*(-?\d+)\s*,\s*(-?\d+)\s*"
    r"(?:,\s*(?:new\s+float\?\(\s*(-?[\d.]+)f?\s*\)|(null)))?\s*\)"
)
RE_STRING_TABLE = re.compile(r'AtlasStringTable\(\s*"([^"]+)"\s*,\s*(\d+)\s*\)')


def parse_resources_xml(path):
    """Parse resources.xml into grouped dicts keyed by element id."""
    tree = ET.parse(path)
    root = tree.getroot()
    out = {
        "images": OrderedDict(),
        "sounds": OrderedDict(),
        "reanims": OrderedDict(),
        "fonts": OrderedDict(),
        "music": OrderedDict(),
        "other": [],
    }
    tag_to_bucket = {
        "Image": "images",
        "Sound": "sounds",
        "Reanim": "reanims",
        "Font": "fonts",
        "Music": "music",
    }
    tag_counts = {}
    duplicates = []
    for resources_group in root:
        if resources_group.tag != "Resources":
            out["other"].append({"tag": resources_group.tag, "attrs": dict(resources_group.attrib)})
            tag_counts[resources_group.tag] = tag_counts.get(resources_group.tag, 0) + 1
            continue
        group_id = resources_group.attrib.get("id", "")
        for elem in resources_group:
            tag = elem.tag
            attrs = dict(elem.attrib)  # raw strings
            tag_counts[tag] = tag_counts.get(tag, 0) + 1
            bucket = tag_to_bucket.get(tag)
            entry = {"path": attrs.get("path"), "group": group_id, "attrs": attrs}
            if bucket is None:
                entry["tag"] = tag
                out["other"].append(entry)
                continue
            elem_id = attrs.get("id")
            if elem_id is None:
                entry["tag"] = tag
                entry["id"] = None
                out["other"].append(entry)
                continue
            if elem_id in out[bucket]:
                duplicates.append(elem_id)
            else:
                out[bucket][elem_id] = entry
    return out, tag_counts, duplicates


def parse_atlas_cs(path):
    """Parse AtlasResources_600x1000.cs -> list of atlases with their UNPACK_INFO entries."""
    with open(path, "r", encoding="utf-8") as f:
        lines = f.readlines()

    atlases = []  # list of dicts: name, images[]
    current_name = None
    current_images = None
    unmatched_lines = []

    for lineno, line in enumerate(lines, 1):
        m = RE_UNPACK_METHOD.search(line)
        if m:
            current_name = m.group(1)
            current_images = []
            continue
        m = RE_UNPACK_INFO.search(line)
        if m:
            if current_images is None:
                unmatched_lines.append((lineno, "UNPACK_INFO outside any Unpack method"))
                continue
            (image_id, x, y, w, h, rows, cols, anim_type,
             frame_delay, begin_delay, end_delay, inv_scale, is_null) = m.groups()
            inv = 1.0 if (is_null is not None or inv_scale is None) else float(inv_scale)
            current_images.append({
                "id": image_id,
                "x": int(x), "y": int(y), "w": int(w), "h": int(h),
                "rows": int(rows), "cols": int(cols),
                "animType": anim_type,
                "frameDelay": int(frame_delay),
                "beginDelay": int(begin_delay),
                "endDelay": int(end_delay),
                "invScale": inv,
            })
            continue
        m = RE_MARRAYS.search(line)
        if m:
            array_name = m.group(1)
            if current_images is not None:
                if array_name != current_name:
                    unmatched_lines.append(
                        (lineno, "mArrays name %r != method name %r" % (array_name, current_name)))
                atlases.append({"name": array_name, "images": current_images})
                current_name = None
                current_images = None

    return atlases, unmatched_lines


def parse_string_table(path):
    table = OrderedDict()
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            m = RE_STRING_TABLE.search(line)
            if m:
                table[m.group(1)] = int(m.group(2))
    return table


def norm(s):
    """Normalize for fuzzy atlas-name matching: uppercase, strip underscores."""
    return s.replace("_", "").upper()


def resolve_atlas_resource(atlas_name, images_by_id):
    """Resolve an atlas name to an <Image> resource id/path.

    Strategy:
      1. id == "IMAGE_" + atlas_name.upper()
      2. path basename == atlas_name (case-insensitive)
      3. normalized (strip underscores, uppercase) match on id-suffix or path basename
    """
    guess = "IMAGE_" + atlas_name.upper()
    if guess in images_by_id:
        return guess, images_by_id[guess]["path"]
    lname = atlas_name.lower()
    for img_id, entry in images_by_id.items():
        p = entry["path"] or ""
        if os.path.basename(p.replace("\\", "/")).lower() == lname:
            return img_id, entry["path"]
    nname = norm(atlas_name)
    for img_id, entry in images_by_id.items():
        p = entry["path"] or ""
        base = os.path.basename(p.replace("\\", "/"))
        if norm(base) == nname or norm(img_id[len("IMAGE_"):] if img_id.startswith("IMAGE_") else img_id) == nname:
            return img_id, entry["path"]
    return None, None


def main():
    resources, tag_counts, duplicates = parse_resources_xml(RESOURCES_XML)
    images_by_id = resources["images"]

    atlases, unmatched = parse_atlas_cs(ATLAS_CS)
    string_table = parse_string_table(STRINGTABLE_CS)

    # Resolve atlas -> image resource, build imageIndex, and rect-fit checks.
    unresolved_atlases = []
    image_index = OrderedDict()
    index_collisions = []
    fit_violations = []
    total_sprites = 0

    for atlas in atlases:
        rid, rpath = resolve_atlas_resource(atlas["name"], images_by_id)
        atlas["resourceId"] = rid
        atlas["path"] = rpath
        if rid is None:
            unresolved_atlases.append(atlas["name"])
        # atlas texture dims from resources.xml (raw strings -> int when possible)
        aw = ah = None
        if rid is not None:
            attrs = images_by_id[rid]["attrs"]
            try:
                aw = int(attrs.get("atlasWidth", ""))
            except ValueError:
                aw = None
            try:
                ah = int(attrs.get("atlasHeight", ""))
            except ValueError:
                ah = None
        for img in atlas["images"]:
            total_sprites += 1
            if img["id"] in image_index:
                index_collisions.append(img["id"])
            else:
                image_index[img["id"]] = {
                    "atlas": atlas["name"],
                    "x": img["x"], "y": img["y"], "w": img["w"], "h": img["h"],
                    "rows": img["rows"], "cols": img["cols"],
                    "invScale": img["invScale"],
                }
            if aw is not None and (img["x"] + img["w"] > aw or img["x"] < 0):
                fit_violations.append((atlas["name"], img["id"], "x+w=%d > atlasWidth=%d" % (img["x"] + img["w"], aw)))
            if ah is not None and (img["y"] + img["h"] > ah or img["y"] < 0):
                fit_violations.append((atlas["name"], img["id"], "y+h=%d > atlasHeight=%d" % (img["y"] + img["h"], ah)))

    os.makedirs(OUT_DIR, exist_ok=True)
    atlas_doc = OrderedDict([
        ("atlases", atlases),
        ("imageIndex", image_index),
        ("stringIdTable", string_table),
    ])
    with open(ATLAS_JSON, "w", encoding="utf-8") as f:
        json.dump(atlas_doc, f, indent=1, ensure_ascii=False)
    with open(RESOURCES_JSON, "w", encoding="utf-8") as f:
        json.dump(resources, f, indent=1, ensure_ascii=False)

    # ---- verification output ----
    print("=== atlas_manifest.py verification ===")
    print("resources.xml tag counts: %s" % tag_counts)
    print("resources.xml duplicate ids (kept first): %d %s" % (len(duplicates), duplicates[:5]))
    print("resources.json: images=%d sounds=%d fonts=%d reanims=%d music=%d other=%d" % (
        len(resources["images"]), len(resources["sounds"]), len(resources["fonts"]),
        len(resources["reanims"]), len(resources["music"]), len(resources["other"])))
    print("atlases parsed: %d" % len(atlases))
    print("total sprite entries: %d" % total_sprites)
    print("stringIdTable entries: %d" % len(string_table))
    print("imageIndex entries: %d (collisions: %d %s)" % (
        len(image_index), len(index_collisions), index_collisions[:5]))
    print("unresolved atlas resource ids: %d %s" % (len(unresolved_atlases), unresolved_atlases))
    if unmatched:
        print("parser warnings: %d" % len(unmatched))
        for ln, msg in unmatched[:10]:
            print("  line %d: %s" % (ln, msg))

    # known-id checks
    # NOTE: stock-PvZ id IMAGE_REANIM_AGAVE_IDLE_000 does not exist in this PlantGirls
    # mod build (Agave frames are named IMAGE_REANIM_AGAVE_PARTICLE_*); report both.
    for check_id, expect_atlas in [("IMAGE_REANIM_AGAVE_IDLE_000", "Agave12"),
                                   ("IMAGE_REANIM_AGAVE_PARTICLE_ATK2_2_33", "Agave12"),
                                   ("IMAGE_TOMBSTONES", "Loc_en")]:
        e = image_index.get(check_id)
        if e is None:
            print("CHECK FAIL: %s not in imageIndex" % check_id)
        else:
            ok = "OK" if e["atlas"] == expect_atlas else "UNEXPECTED atlas"
            print("CHECK %s: %s -> atlas=%s x=%d y=%d w=%d h=%d invScale=%s" % (
                ok, check_id, e["atlas"], e["x"], e["y"], e["w"], e["h"], e["invScale"]))
    seed = next((a for a in atlases if a["name"] == "SeedAtlas"), None)
    if seed:
        print("CHECK OK: SeedAtlas atlas -> resourceId=%s path=%s sprites=%d (first: %s)" % (
            seed["resourceId"], seed["path"], len(seed["images"]), seed["images"][0]["id"]))
    else:
        print("CHECK FAIL: no SeedAtlas atlas")
    print("IMAGE_SEEDATLAS in resources.xml: %s" % ("IMAGE_SEEDATLAS" in images_by_id))

    # top-10 largest atlases
    print("--- top 10 atlases by image count ---")
    for a in sorted(atlases, key=lambda a: -len(a["images"]))[:10]:
        print("  %-28s %4d sprites  resourceId=%s" % (a["name"], len(a["images"]), a["resourceId"]))

    # rect fit
    print("--- rect-fit violations vs atlasWidth/atlasHeight: %d ---" % len(fit_violations))
    for v in fit_violations[:15]:
        print("  %s / %s: %s" % v)

    # reload check
    with open(ATLAS_JSON, "r", encoding="utf-8") as f:
        json.load(f)
    with open(RESOURCES_JSON, "r", encoding="utf-8") as f:
        json.load(f)
    print("both JSON files reload with json.load: OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
