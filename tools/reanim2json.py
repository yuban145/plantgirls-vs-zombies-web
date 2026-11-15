#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
reanim2json.py -- convert PlantGirlsVsZombies compiled "reanim" animations
(Content\\reanim\\*.xnb, read by Sexy.TodLib.ReanimReader) into JSON for the
web port.

The binary layout implemented here is taken 1:1 from the decompiled game:

  Sexy/TodLib/ReanimReader.cs        -- XNB payload reader (the format)
  Sexy/TodLib/CustomContentReader.cs -- string / primitive helpers
  Sexy/TodLib/ReanimatorXnaHelpers.cs-- DEFAULT_FIELD_PLACEHOLDER = -99999f,
                                        ReanimationLoadDefinition() fill-in pass
  Sexy/TodLib/ReanimatorTrack.cs     -- track name is lower-cased on load
  Sexy/TodLib/Reanimation.cs         -- GetFramesForLayer() frame-window rule
  Sexy/Constants.cs                  -- InvertAndScale / S / ISUI
  Sexy/ResourceManager.cs            -- LoadReanimation() calls ExtractImages()
                                        *before* the fill-in pass

XNB wrapper (MonoGame, uncompressed):
  'X''N''B', platform u8, version u8, flags u8, declaredSize i32
  readerCount u7, [string u7len+utf8, i32 version] * readerCount
  sharedResourceCount u7, rootReaderIndex u7
  then the ReanimatorDefinition payload (see parse_reanim_payload()).

Payload (ReanimReader.Read / ReadReanimTrack / ReadReanimTransform):
  u8  doScale          (ReanimScaleType: 0=NoScale, 1=InvertAndScale, 255=ScaleFromPC)
  f32 mFPS
  i32 mTrackCount
  per track:
    str name                      (i32 charCount + UTF-16LE, see CustomContentReader.ReadString)
    i32 transformCount
    per transform:
      u8 optimizationType         (0=New, 1=CopyPrevious, 2=Placeholder)
      New:         str fontName, str imageName, str text,
                   f32 alpha, f32 frame, f32 scaleX, f32 scaleY,
                   f32 skewX, f32 skewY, f32 transX, f32 transY
      CopyPrevious: nothing (reader aliases the previous transform object)
      Placeholder:  nothing (all fields = DEFAULT_FIELD_PLACEHOLDER)

Output: one .json per .xnb.  Values are *resolved* exactly like the game
does at load: CopyPrevious / Placeholder fields inherit from the previous
transform of the same track (per field); track-local defaults are
trans=(0,0), skew=(0,0), scale=(1,1), frame=0, alpha=1.

Usage:
  python reanim2json.py --in Content/reanim/Agave.xnb --out data/reanim/Agave.json
  python reanim2json.py --batch Content/reanim --outdir data/reanim
  python reanim2json.py --verify --data data/reanim
"""

import argparse
import glob
import json
import math
import os
import struct
import sys

# ---------------------------------------------------------------------------
# Runtime constants (this build runs Constants.Load480x800(), Constants.cs:524)
# ---------------------------------------------------------------------------
PLACEHOLDER = -99999.0          # ReanimatorXnaHelpers.cs:228
S = 1.0                         # Constants.cs:528 (Load480x800)
ISUI = 1.25                     # Constants.cs:531 (Load480x800)
INVERT_LOW_RES_FACTOR = 1.875   # Constants.InvertLowResValue, Constants.cs:494-497

SCALE_TYPE_NAMES = {0: "NoScale", 1: "InvertAndScale", 255: "ScaleFromPC"}
OPT_NAMES = {0: "New", 1: "CopyPrevious", 2: "Placeholder"}

# Per-field track-local defaults, ReanimatorXnaHelpers.cs:44-51
FIELD_DEFAULTS = {
    "tx": 0.0, "ty": 0.0, "kx": 0.0, "ky": 0.0,
    "sx": 1.0, "sy": 1.0, "frame": 0.0, "alpha": 1.0,
}
NUMERIC_FIELDS = ("alpha", "frame", "sx", "sy", "kx", "ky", "tx", "ty")


class ReanimError(Exception):
    pass


# ---------------------------------------------------------------------------
# Byte reader for the XNB wrapper (MonoGame / XNA conventions)
# ---------------------------------------------------------------------------
class XnbReader(object):
    def __init__(self, data, pos=0):
        self.data = data
        self.pos = pos

    def read_bytes(self, n):
        if self.pos + n > len(self.data):
            raise ReanimError("unexpected end of XNB at offset %d (+%d bytes)" % (self.pos, n))
        b = self.data[self.pos:self.pos + n]
        self.pos += n
        return b

    def read_u8(self):
        return self.read_bytes(1)[0]

    def read_i32(self):
        (v,) = struct.unpack_from("<i", self.data, self.pos)
        self.pos += 4
        return v

    def read_f32(self):
        (v,) = struct.unpack_from("<f", self.data, self.pos)
        self.pos += 4
        return v

    def read_u7(self):
        """7-bit encoded integer (System.IO.BinaryReader.Read7BitEncodedInt)."""
        result = 0
        shift = 0
        while True:
            b = self.read_u8()
            result |= (b & 0x7F) << shift
            if not (b & 0x80):
                return result
            shift += 7
            if shift > 35:
                raise ReanimError("bad 7-bit integer at offset %d" % self.pos)

    def read_xnb_string(self):
        """XNB string: 7-bit byte length + UTF-8 (BinaryWriter.Write(string))."""
        n = self.read_u7()
        return self.read_bytes(n).decode("utf-8")

    def read_dotnet_string(self):
        """CustomContentReader.ReadString(): i32 char count + UTF-16LE chars."""
        n = self.read_i32()
        if n < 0 or n > 0x7FFFFFFF:
            raise ReanimError("bad .NET string length %d at offset %d" % (n, self.pos - 4))
        raw = self.read_bytes(2 * n)
        return raw.decode("utf-16-le", errors="replace")


# ---------------------------------------------------------------------------
# XNB wrapper
# ---------------------------------------------------------------------------
def parse_xnb(path):
    with open(path, "rb") as f:
        data = f.read()
    if len(data) < 10 or data[0:3] != b"XNB":
        raise ReanimError("%s: not an XNB file (magic %r)" % (path, data[0:3]))
    platform = data[3]
    version = data[4]
    flags = data[5]
    declared_size = struct.unpack_from("<i", data, 6)[0]
    if flags & 0x80:
        raise ReanimError(
            "%s: XNB is LZ4-compressed (flags=0x%02x). This converter only supports "
            "uncompressed XNB (all 150 shipped reanim files are uncompressed). "
            "Decompress the XNB first (e.g. with XNBExporter) and retry." % (path, flags)
        )
    if flags & 0x40:
        raise ReanimError("%s: XNB is LZX-compressed (flags=0x40); unsupported." % path)
    r = XnbReader(data, 10)
    reader_count = r.read_u7()
    readers = []
    for _ in range(reader_count):
        name = r.read_xnb_string()
        ver = r.read_i32()
        readers.append((name, ver))
    shared_resources = r.read_u7()
    root_reader = r.read_u7()   # 1-based index into the type-reader list
    return {
        "data": data,
        "path": path,
        "platform": platform,
        "version": version,
        "flags": flags,
        "declaredSize": declared_size,
        "readers": readers,
        "sharedResources": shared_resources,
        "rootReader": root_reader,
        "payloadOffset": r.pos,
    }


# ---------------------------------------------------------------------------
# Translation scaling done by ReanimReader.ReadReanimTransform()
# ---------------------------------------------------------------------------
def scale_translation(value, scale_byte, is_ground):
    """Replicate ReanimReader.cs:89-110.

    * every track named "_ground" keeps the raw value (ReanimReader.cs:33,91-95)
    * InvertAndScale : Constants.InvertAndScale(x) = 1.875 * S * x   (=1.875*x here)
    * ScaleFromPC    : Constants.S * x                              (=x here)
    * NoScale        : Constants.ISUI * x                           (=1.25*x here)
      ^ NOTE: the decompiled reader's `else` branch multiplies by ISUI, not 1;
        see ReanimReader.cs:106-110 and Constants.cs:506-509/531.
    """
    if is_ground or value == PLACEHOLDER:
        return value
    if scale_byte == 1:
        return INVERT_LOW_RES_FACTOR * S * value
    if scale_byte == 255:
        return S * value
    # scale_byte == 0 ("NoScale" per the enum, but the reader applies ISUI)
    return ISUI * value


# ---------------------------------------------------------------------------
# Reanim payload
# ---------------------------------------------------------------------------
def parse_reanim_payload(xnb):
    data = xnb["data"]
    r = XnbReader(data, xnb["payloadOffset"])

    scale_byte = r.read_u8()
    if scale_byte not in SCALE_TYPE_NAMES:
        raise ReanimError(
            "%s: unexpected ReanimScaleType byte %d at payload offset %d "
            "(expected 0, 1 or 255)" % (xnb["path"], scale_byte, r.pos - 1)
        )
    fps = r.read_f32()
    track_count = r.read_i32()
    if track_count < 0 or track_count > 4096:
        raise ReanimError("%s: implausible track count %d" % (xnb["path"], track_count))

    # `previous` is a *static* in ReanimReader (ReanimReader.cs:116). It survives
    # across tracks (and files, though every file starts with a New transform).
    previous = None
    tracks = []

    for ti in range(track_count):
        raw_name = r.read_dotnet_string()
        transform_count = r.read_i32()
        if transform_count < 0 or transform_count > 200000:
            raise ReanimError("%s: implausible transform count %d in track %r"
                              % (xnb["path"], transform_count, raw_name))
        # ReanimReader.cs:32 -- ReanimatorTrack name is lower-cased via Common.Lower()
        name = raw_name.lower()
        is_ground = (name == "_ground")   # ReanimReader.cs:33 / Reanimation.cs:2094

        transforms = []
        for ji in range(transform_count):
            opt = r.read_u8()
            if opt == 0:  # New
                font = r.read_dotnet_string()
                image = r.read_dotnet_string()
                text = r.read_dotnet_string()
                alpha = r.read_f32()
                frame = r.read_f32()
                sx = r.read_f32()
                sy = r.read_f32()
                kx = r.read_f32()
                ky = r.read_f32()
                raw_tx = r.read_f32()
                raw_ty = r.read_f32()
                t = {
                    "opt": 0,
                    "img": image,
                    "font": font,
                    "text": text,
                    "alpha": alpha,
                    "frame": frame,
                    "sx": sx,
                    "sy": sy,
                    "kx": kx,
                    "ky": ky,
                    # the reader scales translations while reading:
                    "tx": scale_translation(raw_tx, scale_byte, is_ground),
                    "ty": scale_translation(raw_ty, scale_byte, is_ground),
                    # raw values are kept for --keep-raw / debugging
                    "rtx": raw_tx,
                    "rty": raw_ty,
                }
            elif opt == 1:  # CopyPrevious -- ReanimReader.cs:72-76
                if previous is None:
                    # The game would Debug.ASSERT + NullReferenceException here.
                    raise ReanimError(
                        "%s: first transform of file is CopyPrevious (reader crash)" % xnb["path"])
                t = previous          # same object, exactly like the C# code
            elif opt == 2:  # Placeholder -- ReanimReader.cs:68-71
                t = {
                    "opt": 2, "img": "", "font": "", "text": "",
                    "alpha": PLACEHOLDER, "frame": PLACEHOLDER, "sx": PLACEHOLDER,
                    "sy": PLACEHOLDER, "kx": PLACEHOLDER, "ky": PLACEHOLDER,
                    "tx": PLACEHOLDER, "ty": PLACEHOLDER,
                    "rtx": PLACEHOLDER, "rty": PLACEHOLDER,
                }
            else:
                raise ReanimError("%s: unknown optimization byte %d in track %r transform %d"
                                  % (xnb["path"], opt, name, ji))
            transforms.append(t)
            previous = t
        tracks.append({"name": name, "rawName": raw_name, "transforms": transforms})

    consumed = r.pos
    trailing = len(data) - consumed
    if trailing != 0:
        # The reader stops after the definition; extra shared resources would be
        # read by MonoGame afterwards. All shipped files end exactly at EOF.
        raise ReanimError("%s: %d trailing bytes after reanim payload (offset %d)"
                          % (xnb["path"], trailing, consumed))

    return {
        "scaleByte": scale_byte,
        "scaleType": SCALE_TYPE_NAMES[scale_byte],
        "fps": fps,
        "trackCount": track_count,
        "tracks": tracks,
        "consumed": consumed,
    }


# ---------------------------------------------------------------------------
# Resolution pass -- ReanimatorXnaHelpers.ReanimationLoadDefinition (lines 38-99)
# and ResourceManager.LoadReanimation -> ExtractImages() (ResourceManager.cs:127-128)
# ---------------------------------------------------------------------------
def resolve_tracks(tracks):
    """Emulate, in order, what the game does after reading the XNB:

    1. ExtractImages(): transform.mImage is non-null iff mImageName resolved to an
       image (we can only approximate: non-empty image name -> image present).
    2. ReanimationLoadDefinition(): per track, walk transforms and replace every
       DEFAULT_FIELD_PLACEHOLDER by the previous value of the same field; the
       running values start at trans=(0,0), skew=(0,0), scale=(1,1), frame=0,
       alpha=1.  Images / fonts / text are inherited the same way when empty.

    CopyPrevious transforms are *the same object* as the previous transform, so
    mutating one mutates both; resolving in place reproduces that exactly.
    """
    for track in tracks:
        prev = dict(FIELD_DEFAULTS)
        prev_img = ""
        prev_font = ""
        prev_text = ""
        for t in track["transforms"]:
            for field in NUMERIC_FIELDS:
                v = t[field]
                if v == PLACEHOLDER:
                    t[field] = prev[field]
                else:
                    prev[field] = v
            if t["img"]:
                prev_img = t["img"]
            else:
                t["img"] = prev_img          # ReanimatorXnaHelpers.cs:71-80
            if t["font"]:
                prev_font = t["font"]
            else:
                t["font"] = prev_font        # ReanimatorXnaHelpers.cs:81-88
            if t["text"]:
                prev_text = t["text"]
            else:
                t["text"] = prev_text        # ReanimatorXnaHelpers.cs:89-96


def get_frames_for_layer(track):
    """Reanimation.GetFramesForLayer() (Reanimation.cs:1149-1178).

    frameStart = first transform whose (resolved) mFrame >= 0
    frameCount = last index with mFrame >= 0 minus frameStart + 1
    Quirks preserved: if no frame is valid the function returns (0, 1).
    """
    transforms = track["transforms"]
    n = len(transforms)
    if n == 0:
        return 0, 0
    frame_start = 0
    frame_count = 1
    num2 = 0
    for num2 in range(n):
        if transforms[num2]["frame"] >= 0.0:
            frame_start = num2
            break
    for i in range(n - 1, num2 - 1, -1):
        if transforms[i]["frame"] >= 0.0:
            frame_count = i - frame_start + 1
            break
    return frame_start, frame_count


# ---------------------------------------------------------------------------
# JSON emission
# ---------------------------------------------------------------------------
def _num(v):
    """Compact JSON number: ints when integral, otherwise rounded to 4 decimals."""
    if isinstance(v, int):
        return v
    if not math.isfinite(v):
        raise ReanimError("non-finite float in transform: %r" % (v,))
    if v == int(v) and abs(v) < 1e15:
        return int(v)
    return round(v, 4)


def _transform_json(t, keep_raw, compact):
    out = {}
    if t["img"]:
        out["img"] = t["img"]
    if t["font"]:
        out["font"] = t["font"]
    if t["text"]:
        out["text"] = t["text"]
    for field in NUMERIC_FIELDS:
        v = t[field]
        if compact and v == FIELD_DEFAULTS[field]:
            continue
        out[field] = _num(v)
    if keep_raw:
        out["rtx"] = _num(t["rtx"]) if t["rtx"] != PLACEHOLDER else None
        out["rty"] = _num(t["rty"]) if t["rty"] != PLACEHOLDER else None
    return out


def convert_file(xnb_path, keep_raw=False, compact=False, name=None, pretty=False):
    xnb = parse_xnb(xnb_path)
    payload = parse_reanim_payload(xnb)
    resolve_tracks(payload["tracks"])

    tracks_out = []
    total_transforms = 0
    for track in payload["tracks"]:
        frame_start, frame_count = get_frames_for_layer(track)
        transforms = track["transforms"]
        total_transforms += len(transforms)
        tracks_out.append({
            "name": track["name"],
            "frameStart": frame_start,
            "frameCount": frame_count,
            "transforms": [_transform_json(t, keep_raw, compact) for t in transforms],
        })

    if name is None:
        name = os.path.splitext(os.path.basename(xnb_path))[0]

    doc = {
        "name": name,
        "source": os.path.basename(xnb_path),
        "fps": _num(payload["fps"]),
        "scaleType": payload["scaleType"],
        "scaleByte": payload["scaleByte"],
        "trackCount": payload["trackCount"],
        # Length of the shared global frame timeline. Every track of a file is
        # expected to hold one transform per global frame (all 150 shipped files
        # follow this); it is *not* the length of a single animation -- use the
        # per-track frameCount for that.
        "globalFrameCount": max((len(t["transforms"]) for t in payload["tracks"]), default=0),
        "interpolate": True,   # Reanimation.mInterpolate = true, Reanimation.cs:1998
        "tracks": tracks_out,
    }
    text = json.dumps(doc, ensure_ascii=False, indent=1 if pretty else None,
                      separators=(",", ": ") if pretty else (",", ":"))
    stats = {
        "name": name,
        "trackCount": payload["trackCount"],
        "transforms": total_transforms,
        "fps": payload["fps"],
        "scaleType": payload["scaleType"],
        "globalFrameCount": doc["globalFrameCount"],
        "tracks": [(t["name"], t["frameStart"], t["frameCount"]) for t in tracks_out],
    }
    return doc, text, stats


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def do_single(args):
    doc, text, _ = convert_file(args.infile, keep_raw=args.keep_raw,
                                compact=args.compact, pretty=args.pretty)
    out = args.outfile
    if out is None:
        out = os.path.splitext(os.path.basename(args.infile))[0] + ".json"
    parent = os.path.dirname(os.path.abspath(out))
    if parent and not os.path.isdir(parent):
        os.makedirs(parent)
    with open(out, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)
        f.write("\n")
    print("wrote %s (%d tracks, %d bytes)" % (out, doc["trackCount"], len(text) + 1))


def do_batch(args):
    files = sorted(glob.glob(os.path.join(args.batch, "*.xnb")))
    if not files:
        sys.exit("no .xnb files under %s" % args.batch)
    if not os.path.isdir(args.outdir):
        os.makedirs(args.outdir)
    ok = 0
    failed = []
    total_bytes = 0
    total_transforms = 0
    rows = []
    for path in files:
        try:
            doc, text, stats = convert_file(path, keep_raw=args.keep_raw, compact=args.compact)
        except ReanimError as e:
            failed.append((path, str(e)))
            continue
        out = os.path.join(args.outdir, os.path.splitext(os.path.basename(path))[0] + ".json")
        with open(out, "w", encoding="utf-8", newline="\n") as f:
            f.write(text)
            f.write("\n")
        total_bytes += len(text) + 1
        total_transforms += stats["transforms"]
        rows.append(stats)
        ok += 1
    print("converted %d/%d files, %.2f MiB json, %d transforms"
          % (ok, len(files), total_bytes / 1048576.0, total_transforms))
    if failed:
        for path, msg in failed:
            print("FAILED %s: %s" % (path, msg), file=sys.stderr)
        return 1
    return 0


def do_verify(args):
    data_dir = args.data
    files = sorted(glob.glob(os.path.join(data_dir, "*.json")))
    if not files:
        sys.exit("no .json files under %s" % data_dir)
    print("verifying %d JSON files in %s" % (len(files), data_dir))
    errors = []
    names = []
    for path in files:
        with open(path, "r", encoding="utf-8") as f:
            doc = json.load(f)
        names.append(doc["name"])
        for key in ("name", "fps", "scaleType", "trackCount", "tracks"):
            if key not in doc:
                errors.append("%s: missing key %r" % (path, key))
        if doc["trackCount"] != len(doc["tracks"]):
            errors.append("%s: trackCount != len(tracks)" % path)
        for track in doc["tracks"]:
            if "name" not in track or "transforms" not in track:
                errors.append("%s: bad track %r" % (path, track.get("name")))
                continue
            for t in track["transforms"]:
                for key in ("alpha", "frame", "sx", "sy", "kx", "ky", "tx", "ty"):
                    if key not in t:
                        # compact mode omits default-valued fields
                        if args.compact:
                            continue
                        errors.append("%s: track %r transform missing %r"
                                      % (path, track["name"], key))
                        break
                    if not isinstance(t[key], (int, float)):
                        errors.append("%s: track %r transform %r not numeric"
                                      % (path, track["name"], key))
                        break
    # --- required sanity check: Agave / anim_idle -------------------------
    print()
    print("== sanity check: Agave ==")
    agave = next((p for p in files if os.path.basename(p) == "Agave.json"), None)
    if agave is None:
        errors.append("Agave.json not found under %s" % data_dir)
    else:
        with open(agave, "r", encoding="utf-8") as f:
            doc = json.load(f)
        idle = next((t for t in doc["tracks"] if t["name"] == "anim_idle"), None)
        if idle is None:
            errors.append("Agave.json: no track named 'anim_idle'")
        else:
            print("Agave.json: name=%r fps=%r scaleType=%r tracks=%d globalFrameCount=%d"
                  % (doc["name"], doc["fps"], doc["scaleType"], doc["trackCount"],
                     doc["globalFrameCount"]))
            print("  anim_idle: frameStart=%d frameCount=%d transforms=%d"
                  % (idle["frameStart"], idle["frameCount"], len(idle["transforms"])))
            first = idle["transforms"][idle["frameStart"]]
            print("  anim_idle[%d]: img=%r tx=%r ty=%r sx=%r sy=%r alpha=%r frame=%r"
                  % (idle["frameStart"], first.get("img"), first.get("tx"),
                     first.get("ty"), first.get("sx"), first.get("sy"),
                     first.get("alpha"), first.get("frame")))
            if idle["frameCount"] < 2:
                errors.append("Agave anim_idle frameCount implausible: %d" % idle["frameCount"])
            for track in doc["tracks"]:
                print("  track %-16r frameStart=%5d frameCount=%5d transforms=%d"
                      % (track["name"], track["frameStart"], track["frameCount"],
                         len(track["transforms"])))
    # --- zombie example ---------------------------------------------------
    zombies = sorted(p for p in files if "zombie" in os.path.basename(p).lower())
    print()
    print("== zombie files (%d) ==" % len(zombies))
    print("  " + ", ".join(os.path.basename(p) for p in zombies))
    zp = next((p for p in files if os.path.basename(p) == "Zombie.json"), None)
    if zp:
        with open(zp, "r", encoding="utf-8") as f:
            zdoc = json.load(f)
        print("Zombie.json: fps=%r scale=%r tracks=%d globalFrameCount=%d"
              % (zdoc["fps"], zdoc["scaleType"], zdoc["trackCount"],
                 zdoc["globalFrameCount"]))
        for track in zdoc["tracks"]:
            if track["name"].startswith("anim_") and track["frameCount"] > 1:
                print("  track %-24r frameStart=%4d frameCount=%4d transforms=%4d"
                      % (track["name"], track["frameStart"], track["frameCount"],
                         len(track["transforms"])))
    print()
    if errors:
        for e in errors:
            print("ERROR " + e, file=sys.stderr)
        return 1
    print("OK: %d files parse; %d unique names; no schema errors" % (len(files), len(set(names))))
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser(
        description="Convert PlantGirlsVsZombies reanim .xnb files to JSON.")
    mode = ap.add_mutually_exclusive_group(required=True)
    mode.add_argument("--in", dest="infile", help="single .xnb input file")
    mode.add_argument("--batch", help="directory with .xnb files")
    mode.add_argument("--verify", action="store_true",
                      help="validate already converted JSON under --data")
    ap.add_argument("--out", dest="outfile", help="output .json for --in")
    ap.add_argument("--outdir", help="output directory for --batch")
    ap.add_argument("--data", default=os.path.join(os.path.dirname(os.path.dirname(
        os.path.abspath(__file__))), "data", "reanim"),
        help="directory containing converted JSON (for --verify)")
    ap.add_argument("--keep-raw", action="store_true",
                    help="also emit rtx/rty: translation values as read from the file, "
                         "before the ReanimReader scale rule was applied")
    ap.add_argument("--compact", action="store_true",
                    help="omit numeric fields equal to the track-local defaults "
                         "(tx=ty=kx=ky=frame=0, sx=sy=alpha=1); the loader must fill "
                         "these defaults. Smaller files.")
    ap.add_argument("--pretty", action="store_true", help="indent JSON (bigger)")
    args = ap.parse_args(argv)

    try:
        if args.infile:
            if not os.path.isfile(args.infile):
                sys.exit("input not found: %s" % args.infile)
            do_single(args)
        elif args.batch:
            if not os.path.isdir(args.batch):
                sys.exit("batch dir not found: %s" % args.batch)
            if not args.outdir:
                sys.exit("--batch requires --outdir")
            return do_batch(args)
        else:
            return do_verify(args)
    except ReanimError as e:
        print("ERROR: %s" % e, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
