# Reanim (`.xnb`) format & rendering spec for the PlantGirlsVsZombies web port

Status: format reverse-engineered and verified against **all 150** shipped reanim files
(2026-11-14). Converter: [`tools/reanim2json.py`](../tools/reanim2json.py) →
output in [`data/reanim/`](../data/reanim/).

All `file:line` citations are relative to the decompiled game sources in
`D:\逆向\output\PlantGirlsVsZombies\decompiled\Lawn\` (e.g.
`Sexy/TodLib/Reanimation.cs:437` means line 437 of that file).
The original game directory was not modified.

---

## 0. TL;DR for the implementation

1. Each `Content/reanim/<Name>.xnb` is one **reanimator definition**: a list of
   **tracks** (layers *and* animation markers mixed), each holding the same number of
   **transforms** = one shared **global frame timeline**.
2. A track whose name the game passes to `PlayReanim("anim_xxx")` defines an
   **animation window** `[frameStart, frameStart+frameCount-1]` inside that global
   timeline (computed from which frames have `frame >= 0`). The game plays one
   animation at a time; every track is sampled at the *same* global frame index.
3. Each transform is a 2D sprite placement: image name, cel index (`frame`, `-1` =
   hidden), alpha, scale, skew (degrees), translation. Sprites use a **top-left**
   local origin after simplifying the C# centered quad matrix, in **track order**, on a **1000×600, y-down** canvas;
   `trans`/`scale` are in canvas pixels. A reanim's position/scale/mirror is an
   overlay matrix (translation + optional `M11 = -1` mirror) applied on top.
4. Animation timing: `animTime += 0.01 * rate / frameCount` per 100 Hz update
   (`10 ms` fixed step), frame index = `floor(frameStart + N*animTime)` with interpolation fraction
   `N = frameCount-1` (or `frameCount` for `*FullLastFrame` loop types).
   Loop duration ≈ `frameCount / rate` seconds.
5. The JSON is **resolved** (CopyPrevious/Placeholder already filled in), 62.25 MiB
   total for 150 files, ~6.6 k unique image names. See §6 for the schema.

---

## 1. Where reanim data lives and how the game loads it

* Compiled assets: `D:\逆向\PlantGirlsVsZombies\Content\reanim\*.xnb`, 150 files,
  10.74 MiB total. Each was compiled by a custom `ContentTypeReader`
  `Sexy.TodLib.ReanimReader` (`Sexy/TodLib/ReanimReader.cs:7`).
* Type → file mapping: `Lawn/GameConstants.cs:151-300`
  (`new ReanimationParams(ReanimationType.Agave, "spanim/agave", 0, true, "reanim/Agave", 16f)`).
  Note: 34 entries are Spine-drawn (`isSpine = true`) and load the reanim `.xnb`
  only as `mOldFilename` fallback (`Sexy/ResourceManager.cs:109-130` +
  `Sexy/TodLib/Reanimation.cs:271-280` draws Spine when `mIsSpine`). Measured usage of the
  150 files against this table (case-insensitive): **116** are loaded as the primary
  reanim for at least one type, **27** are only `mOldFilename` Spine fallbacks
  (`Agave, Blover, Caltrop, Cattail, Chomper, Cornpult, FumeShroom, Garlic,
  GatlingPea, Gravebuster, HypnoShroom, IceShroom, Imitater, PeaShooter,
  PeaShooterSingle, Plantern, PuffShroom, Pumpkin, ScaredyShroom, SeaShroom,
  SnowPea, SpikeRock, SplitPea, Squash, SunFlower, Tallnut, Umbrellaleaf`), and 7 are
  unreferenced (`Jalapeno_orig`, `ScaredyShroom_orig`, `Zombie._orig`,
  `Zombie_credits_conehead`, `Zombie_credits_screendoor`, `menu_crow`, `moneybag`).
* Load chain:
  1. `ReanimatorXnaHelpers.ReanimatorEnsureDefinitionLoaded` →
     `ReanimationLoadDefinition` (`Sexy/TodLib/ReanimatorXnaHelpers.cs:160-177`, `:32-101`)
  2. `ResourceManager.LoadReanimation` loads the XNB and immediately calls
     `def.ExtractImages()` (`Sexy/ResourceManager.cs:127-129`), which resolves
     image/font objects from the name strings (`Sexy/TodLib/ReanimatorDefinition.cs:19-39`,
     `Sexy/TodLib/ReanimatorTransform.cs:64-83`).
  3. Then `ReanimationLoadDefinition` runs the **fill-in pass** (see §2.3) and
     precomputes `cos/sin` of the skew angles (`Sexy/TodLib/ReanimatorXnaHelpers.cs:56-98`).
* Track names are **lower-cased at load** (`Sexy/TodLib/ReanimReader.cs:32`,
  `Sexy/TodLib/ReanimatorTrack.cs:12-23`, `Sexy/Common.cs:122-143`).
  The JSON converter stores the lower-cased name, matching runtime lookups.
* `ReanimationType` only indexes the definition array
  (`Sexy/TodLib/ReanimationType.cs:6`, array size 150:
  `Sexy/TodLib/ReanimatorXnaHelpers.cs:246`); it carries no file data.
  `Lawn/ReanimationID.cs` is just `{ Null }` — an entity handle, not part of the format.

---

## 2. Binary format (confirmed)

### 2.1 XNB wrapper (uncompressed MonoGame format)

All 150 files: `platform = 0x6D` ('m' = Windows/MonoGame), `version = 5`,
`flags = 0x00` (uncompressed). The wrapper is standard XNB:

| offset | size | content |
| --- | --- | --- |
| 0 | 3 | `"XNB"` |
| 3 | 1 | platform `0x6D` |
| 4 | 1 | format version `5` |
| 5 | 1 | flags (`0x80` = LZ4, `0x40` = LZX; both unsupported — raise error) |
| 6 | 4 | declared file size (i32 LE) |
| 10 | var | type-reader count: 7-bit encoded int = `1` |
| 11 | var | reader string: 7-bit byte length + UTF-8 = `"Sexy.TodLib.ReanimReader, LAWN"` |
| … | 4 | reader version (i32 LE) = `0` |
| … | var | shared resource count: 7-bit int = `0` |
| … | var | **root object type-reader index**: 7-bit int = `1` (1-based) |
| … | — | reanim payload starts here |

Exact Agave.xnb prologue (verified byte-for-byte):

```
0000  58 4e 42 6d 05 00 5b 37 02 00 01 1e 53 65 78 79   XNBm..[7....Sexy
0010  2e 54 6f 64 4c 69 62 2e 52 65 61 6e 69 6d 52 65   .TodLib.ReanimRe
0020  61 64 65 72 2c 20 4c 41 57 4e 00 00 00 00 00 01   ader, LAWN......
0030  ff 00 00 70 42 09 00 00 00 09 00 00 00 61 00 6e   ...pB........a.n
0040  00 69 00 6d 00 5f 00 69 00 64 00 6c 00 65 00 0a   .i.m._.i.d.l.e..
0050  05 00 00 00 00 00 00 00 1b 00 00 00 49 00 4d 00   ............I.M.
```

Decoded: `payloadOffset = 0x30 (48)`, `doScale = 0xFF`, `fps = 60.0`,
`trackCount = 9`, track 0 name length `9`, name `"anim_idle"`,
`transformCount = 1290`, first optimization byte `0` (New), font/image/text = `""`,
`"IMAGE_REANIM_AGAVE_IDLE_000"`, `""`, then the float block.

The `ContentTypeReader.Read` receives a `ContentReader` positioned after the type
manifest **and** the root-reader index, then copies the rest of the stream
(`Sexy/TodLib/CustomContentReader.cs:10-14`) and parses from there. Our converter
starts at the same byte and requires the parse to consume the file *exactly*
(no trailing bytes) — true for all 150 files.

All multi-byte values are little-endian. `float` = IEEE-754 binary32.
Strings inside the payload are **not** XNB 7-bit strings but .NET
`BinaryWriter.Write(string)` style: `i32` **character count**, then that many UTF-16LE
code units (`Sexy/TodLib/CustomContentReader.cs:49-64`; an empty string is a single
`i32 0`, **no** terminator).

### 2.2 Payload layout (`ReanimReader.Read`, `Sexy/TodLib/ReanimReader.cs:10-25`)

```
u8   doScale                      // ReanimScaleType
f32  mFPS                         // animation rate in frames/second
i32  mTrackCount
repeat mTrackCount times (ReadReanimTrack, :28-40):
    str  name                     // i32 charCount + UTF-16LE; lower-cased on load
    i32  transformCount
    repeat transformCount times (ReadReanimTransform, :65-113):
        u8 optimizationType       // 0=New, 1=CopyPrevious, 2=Placeholder
        if New:
            str fontName, str imageName, str text
            f32 alpha, frame, scaleX, scaleY, skewX, skewY, transX, transY
        if CopyPrevious:  no bytes
        if Placeholder:   no bytes
```

`ReanimScaleType` (`Sexy/TodLib/ReanimReader.cs:132-141`):
`0 = NoScale`, `1 = InvertAndScale`, `255 = ScaleFromPC`.
`ReanimOptimisationType` (`:121-130`): `0 = New`, `1 = CopyPrevious`, `2 = Placeholder`.

### 2.3 Optimization records and the fill-in pass

* `New` — the 11 fields above are stored verbatim (any numeric field may be the
  placeholder sentinel `-99999.0f`).
* `CopyPrevious` — the reader **aliases the previous transform object**
  (`transform = ReanimReader.previous`, `Sexy/TodLib/ReanimReader.cs:72-76`), i.e. a
  byte-identical copy of the previous transform in load order. `previous` is a
  **static** field (`:112-116`) so it also survives track boundaries (and file
  loads). All 150 shipped files start every track with a `New` record, so no
  cross-track/cross-file aliasing actually occurs.
* `Placeholder` — fresh transform with all 11 fields = `DEFAULT_FIELD_PLACEHOLDER
  = -99999f` (`Sexy/TodLib/ReanimReader.cs:43-62`;
  `Sexy/TodLib/ReanimatorXnaHelpers.cs:228`). **No shipped file uses it**
  (counts over all files: 227,010 New + 405,832 CopyPrevious + 0 Placeholder).
* After all tracks are read, `ReanimationLoadDefinition` walks each track and
  replaces every remaining `-99999` by the previous *resolved* value of that field
  (`Sexy/TodLib/ReanimatorXnaHelpers.cs:56-98`; helper `:21-29`). Per-track initial
  values (`:44-51`): `trans = (0,0)`, `skew = (0,0)`, `scale = (1,1)`, `frame = 0`,
  `alpha = 1`.
  Images/fonts/text are inherited the same way when empty (`:71-96`): an empty
  `mImageName` (or an image name that fails to resolve to an atlas image) inherits
  the last non-null image of the track.
* Therefore a transform's `frame == -1` is always explicit (never inherited from the
  default 0); `frame = -1` means **hidden** and is the only way a track is not drawn.

### 2.4 Translation scaling rule (`Sexy/TodLib/ReanimReader.cs:89-110`)

`transX/transY` are scaled **while reading**, field by field (skew/scale/alpha are
never scaled). With `S = 1.0`, `ISUI = 1.25` in this build
(`Sexy/Constants.cs:524-531`, `Constants.Load480x800()`; `InvertLowResValue(x) =
1.875*x` at `:494-497`, `InvertAndScale(x) = 1.875*S*x` at `:500-503`):

| `doScale` byte | JSON `scaleType` | applied to `transX/transY` | 150-file count |
| --- | --- | --- | --- |
| `1` | `InvertAndScale` | `1.875 * S * x` = **`1.875 * x`** | 80 |
| `255` | `ScaleFromPC` | `S * x` = **`x`** | 69 |
| `0` | `NoScale` | `ISUI * x` = **`1.25 * x`** (quirk, see below) | 1 (`astronaut`) |

Two reader quirks worth knowing:

* The track named exactly `"_ground"` (case-insensitively) is special-cased: its
  translations are stored **raw/unscaled** (`Sexy/TodLib/ReanimReader.cs:33`, `:91-95`;
  track id `Sexy/TodLib/Reanimation.cs:2094`). 28 shipped files have such a track
  (27 zombie files + `Wallnut` + `Stinky`). For most of them `scaleType =
  ScaleFromPC` so the rule is a no-op, but **`Stinky` and `Wallnut` are
  `InvertAndScale`**: their `_ground` `tx/ty` stay raw while every other track of
  the same file is multiplied by 1.875 (e.g. `Stinky` `_ground[0].tx = -23.2`;
  `Wallnut`'s `_ground` is all zeros). This asymmetry exists in the shipped data and
  the JSON preserves it — do not re-scale `_ground` samples.
* `ReanimScaleType.NoScale (0)` does **not** mean "unscaled": the decompiled
  `else` branch multiplies by `Constants.ISUI` (`ReanimReader.cs:106-109`,
  `Constants.cs:506-509`). The separate XML loader
  (`Sexy/TodLib/ReanimXmlReader.cs:128-142`) uses the raw value for `NoScale`
  instead — do not confuse the two paths. Only `astronaut.xnb` ships with byte `0`.

The converter writes the post-scale values (what the runtime actually uses) and can
emit the pre-scale values as `rtx`/`rty` with `--keep-raw`.

### 2.5 What the shipped corpus contains (measured over all 150 files)

| property | value |
| --- | --- |
| files / total XNB size | 150 / 10.74 MiB |
| tracks | 2,872 (1 … 109 per file; `treeofWisdom` has 109) |
| transforms | 632,842 |
| optimization records | 227,010 New, 405,832 CopyPrevious, **0 Placeholder** |
| transforms with an image | 423,995; 6,659 unique `IMAGE_*` names |
| transforms with no image | 208,847 (animation-marker tracks and hidden frames) |
| `fontname` / `text` | **always empty** in shipped data |
| `attacher__*` tracks | **none** in shipped data |
| `frame` values | only `0.0` and `-1.0` (resolved); `-1` = hidden |
| tracks per file | every track in a file has the **same** transform count (verified all 150) |
| `fps` | 12 ×115, 15 ×4, 16, 17, 18 ×2, 20 ×9, 22, 24 ×6, 30 ×7, 33, 48, 60 ×2 (`Agave`, `AgaveParticle`) |
| `scaleType` | InvertAndScale 80, ScaleFromPC 69, NoScale 1 (`astronaut`) |
| track names | lower-cased, may repeat inside one file (e.g. `Cattail` has 4 × `anim_waterline`; lookup returns the **first**) |
| `"fullscreen"` track | 1 file (`ZombiesWon`) — special solid-fill fallback, see §5.8 |
| `alpha` range | −0.08 … 1.09 (clamped by the renderer); `1` in 624,817 cases |
| `scalex/scaley` | 0.007 … 49.999 (49.999 is the `fullscreen` fill trick) |
| `skewx/skewy` | −2176° … +2117° (degrees; `180`/`240` are common "flip" values) |
| extreme values | one parked transform (`ThreePeater/zombie_butter[0]`, `ty = -187516.9`) is `frame = -1`, so it is never drawn |

**Example A — `Agave.xnb`** (`fps=60`, `ScaleFromPC`, 9 tracks × 1290 global frames,
1,024,423 B JSON). Its 9 tracks are 9 animations that tile the timeline:

| track | frameStart | frameCount | global transforms |
| --- | --- | --- | --- |
| anim_idle | 0 | 200 | 1290 |
| anim_shooting | 200 | 222 | 1290 |
| anim_atk2_2 | 422 | 50 | 1290 |
| anim_enter | 472 | 180 | 1290 |
| anim_garden1 | 652 | 200 | 1290 |
| anim_idle2ready | 852 | 120 | 1290 |
| anim_ready2idle | 972 | 120 | 1290 |
| anim_ready | 1092 | 100 | 1290 |
| anim_atk2_1 | 1192 | 98 | 1290 |

`Agave.json` track `anim_idle`, first/last/hidden transforms of the window:

| global frame | img | alpha | frame | sx sy | kx ky | tx ty |
| --- | --- | --- | --- | --- | --- | --- |
| 0 | IMAGE_REANIM_AGAVE_IDLE_000 | 1 | 0 | 0.8 / 0.8 | 0 / 0 | −36 / −44 |
| 1 | IMAGE_REANIM_AGAVE_IDLE_001 | 1 | 0 | 0.8 / 0.8 | 0 / 0 | −36 / −44 |
| 199 | IMAGE_REANIM_AGAVE_IDLE_199 | 1 | 0 | 0.8 / 0.8 | 0 / 0 | −36 / −44 |
| 200 (outside window) | IMAGE_REANIM_AGAVE_IDLE_199 | 1 | **−1** | 0.8 / 0.8 | 0 / 0 | −36 / −44 |

(Observation from the parsed data: Agave stores one distinct image per animation
frame while all numeric values are inherited from frame 0, so visually the
animation only swaps images.)

**Example B — `Zombie.xnb`** (`fps=12`, `ScaleFromPC`, 42 tracks × 504 global
frames, 2,186,963 B JSON). Classic layered style: some tracks are animation markers
with no image, other tracks hold the body parts as single images animated by
transform. Animation windows (contiguous, sum = 504):

| track | frameStart | frameCount | | track | frameStart | frameCount |
| --- | --- | --- | --- | --- | --- | --- |
| anim_idle | 0 | 29 | | anim_eat | 138 | 40 |
| anim_idle2 | 29 | 15 | | anim_death | 178 | 39 |
| anim_walk | 44 | 47 | | anim_death2 | 217 | 33 |
| anim_walk2 | 91 | 47 | | anim_swim | 250 | 42 |
| anim_superlongdeath | 292 | 137 | | anim_waterdeath | 429 | 25 |
| anim_dance | 454 | 50 | | | | |

Layer tracks of the same file (`anim_head1` is visible for the whole 504-frame
timeline; note the smooth per-frame angles):

| global frame | img | alpha | frame | sx sy | kx ky (deg) | tx ty |
| --- | --- | --- | --- | --- | --- | --- |
| 44 | IMAGE_REANIM_ZOMBIE_HEAD | 1 | 0 | 0.8 / 0.8 | 0 / 0 | 6.7 / 8.8 |
| 45 | IMAGE_REANIM_ZOMBIE_HEAD | 1 | 0 | 0.799 / 0.799 | 4 / 4 | 8.5 / 6.1 |
| 46 | IMAGE_REANIM_ZOMBIE_HEAD | 1 | 0 | 0.799 / 0.799 | 8 / 8 | 10.4 / 3.6 |

**Example C — `Blover.xnb`** (`fps=12`, `InvertAndScale` — translations are already
×1.875 in the JSON): 11 tracks / 62 global frames; `anim_idle` 0–32,
`anim_blow` 33–51, `anim_loop` 52–61; the 8 layer tracks are visible for all 62
frames (`blover_head`: `tx = 21.915`, `ty = 15.3113`, `sx = sy = 0.797` at frame 0).

Animation-window rule (used by every file, including odd ones): see §3.2.
Beware: 10 files contain degenerate marker tracks (`frameCount <= 1` although the
track has many transforms — e.g. `PeaShooter/anim_idle` has exactly one visible
frame). Most of these are Spine-fallback files that the game never plays as reanim;
`PotatoMine`, `Zombie_backup`, `woodsign`, `ZombiesWon`, `SelectorScreen` also show
one or two such tracks. Treat the JSON `frameStart/frameCount` as authoritative.

---

## 3. Playback model (what the port must reproduce)

### 3.1 Global timeline and animation windows

`ReanimationInitialize` sets `mFrameCount = mDefinition.mTracks[0].mTransformCount`
(`Sexy/TodLib/Reanimation.cs:107-129`) — i.e. the number of global frames — and
`mAnimRate = mDefinition.mFPS` (`:117`). `PlayReanim(name, loopType, blendTime,
animRate)` then calls `SetFramesForLayer(name)` and overrides `mAnimRate` when
`animRate != 0` (`:1104-1117`).

`GetFramesForLayer(trackName)` (`Sexy/TodLib/Reanimation.cs:1149-1178`,
called from `SetFramesForLayer` `:709-726`):

```
frameStart = first index i where track[i].frame >= 0
frameCount = (last index j >= frameStart where track[j].frame >= 0) - frameStart + 1
if no frame >= 0:  return (0, 1)   // quirk
```

`FindTrackIndex` returns **0** when the name is not found (`:616-632`), so an unknown
animation name silently plays track 0's window. Names are compared lower-cased.

All tracks are then sampled at the same global frame index:
`GetTransformAtTime(track, frameTime)` reads `track.mTransforms[frame]`
(`:524-578`); the array lengths are equal in practice, but if a track were shorter
the runtime would index out of range — do not rely on equal lengths, clamp instead.

### 3.2 Frame selection & timing

Simulation is a **fixed 100 Hz** step: `TargetElapsedTime = 0.01 s`
(`Sexy/Main.cs:39`) and `SECONDS_PER_UPDATE = 0.01f`
(`Sexy/TodLib/ReanimatorXnaHelpers.cs:243`).

`Reanimation.Update()` (`Sexy/TodLib/Reanimation.cs:160-268`):

```
mAnimTime += 0.01 * mAnimRate / mFrameCount        // :177
```
Then, by loop type (`:178-240`) with `mAnimRate > 0`:

| `ReanimLoopType` (value, `Sexy/TodLib/ReanimLoopType.cs:6-21`) | behaviour |
| --- | --- |
| `Loop` (0) | `while (mAnimTime >= 1) { mAnimTime -= 1; mLoopCount++; }` |
| `LoopFullLastFrame` (1) | same as Loop, but frame mapping adds one extra last frame (see `N` below) |
| `PlayOnce` (2) | at `mAnimTime >= 1`: `mAnimTime = 1`, `mDead = true` |
| `PlayOnceAndHold` (3) | at `mAnimTime >= 1`: `mAnimTime = 1` (stays, not dead) |
| `PlayOnceFullLastFrame` (4) | like PlayOnce + full last frame |
| `PlayOnceFullLastFrameAndHold` (5) | like PlayOnceAndHold + full last frame |
| `PlayThenAction` (6) | at 1.0 runs a callback; dead if it returns false |

Negative rates are handled symmetrically (`:215-240`).

Frame index (`GetFrameTime`, `Sexy/TodLib/Reanimation.cs:581-613`):

```
N    = frameCount        if loopType is PlayOnceFullLastFrame | LoopFullLastFrame | PlayOnceFullLastFrameAndHold
     = frameCount - 1    otherwise
t    = frameStart + N * mAnimTime
frac = t - floor(t)          // fraction used for interpolation
before = floor(t)            // Reanimation.cs:601-604: (short)((int)t + 0.5f)
after  = min(before + 1, frameStart + frameCount - 1)
if before >= frameStart + frameCount - 1: before = after = frameStart + frameCount - 1

// NOTE (corrected 2026-11-15, Codex round-2 review): the earlier revision of
// this document said round(t). That is wrong: the C# truncates t to int first
// (`float num3 = (float)((int)num2)`), then `(short)(num3 + 0.5f)` stays
// num3 because adding 0.5 to an integer float and truncating keeps it - so
// `before` is floor(t) and `frac` is the fractional part. Using round(t) with
// this frac made sprites jump half a frame ahead. The TS port now matches C#.
```

The engine then **interpolates** the transform between `before` and `after` with
`frac` because `Reanimation.mInterpolate == true`
(`Sexy/TodLib/Reanimation.cs:1998`, interpolation `:541-577`): trans/scale/skew/alpha
are linear-lerped (`skew` cos/sin are lerped too, not recomputed); image/font/text/
`frame` come from the `before` transform. `mLastFrameTime` is kept for event timing
(`ShouldTriggerTimedEvent`, `:983-1009`).

Duration of one loop/pass ≈ `frameCount / mAnimRate` seconds. Typical `mAnimRate` in
game code = 0 (keep `mFPS`) or explicit values such as 12/15/18/24/30/35/60
(`PlayReanim` call sites, e.g. `Lawn/Plant.cs:773`, `:2672`, `Lawn/Zombie.cs:11078`,
`Lawn/LawnApp.cs:2874`). `*FullLastFrame` holds the last frame for one extra frame
period (`N = frameCount`), which is what the `Zombie` locomotion/idle code uses in
several places; usual plants use `Loop` / `PlayOnceAndHold`.

### 3.3 Per-track visibility and cel selection

`DrawTrack` (`Sexy/TodLib/Reanimation.cs:321-497`):

1. Get the (interpolated) transform; if `null` → skip.
2. If `transform.mFrame < 0` → **do not draw** (`:334-338`). (Also sampled `after`
   frame is used for `mTruncateDisappearingFrames`: `:534`, `:572-577`.)
3. `alpha = clamp((int)(transform.alpha * trackColor.a + 0.5), 0, 255)`;
   `alpha <= 0` → skip (`:356-362`).
4. If there is an image: cel column `i = (int)(mFrame + 0.5)`;
   `while (i >= image.mNumCols) i -= image.mNumCols;` (`:461-464`;
   `Image.GetCelWidth = mWidth/mNumCols`, `Sexy/Image.cs:28-38`). Cel row is
   **always 0** (`num11 = 0`, `:465-468`), source rect =
   `(celWidth*i, 0, celWidth, celHeight)`. So `frame` is a multi-column strip index;
   with `frame ∈ {0,-1}` in all shipped data it is effectively only a
   visible/hidden flag.
5. If there is no image but a font+text, it draws text with the same matrix
   (`:396-400`, `:476-486`, origin `(-StringWidth/2, ascent)`); **unused in data**.
6. If there is neither image nor font and the track is named exactly `"fullscreen"`,
   it fills the board rect `(0,0,1000,600)` with the track colour (`:401-409`,
   `:487-493`). Only `ZombiesWon.xnb` has this track.
7. Otherwise skip (`:405-406`).

Track visibility can also be forced off by render group `-1`
(`RENDER_GROUP_HIDDEN`, `Sexy/TodLib/ReanimatorXnaHelpers.cs:237-240`) — assigned
from game code via `AssignRenderGroupToTrack/ToPrefix` (`Reanimation.cs:927-966`),
e.g. `Zombie.cs:1115`, `Plant.cs:593/740`, `LawnApp.cs:2926`.

---

## 4. Coordinate system and units

* The game's back buffer is **1000×600**, y down, origin top-left
  (`Sexy/Main.cs:33-34`; ortho projection in `Sexy/PrimitiveBatch.cs:25-35` maps
  x ∈ [0,1000], y ∈ [0,600] top-down). The logical board is 1000×600
  (`Constants.BOARD_WIDTH = 1000`, `BOARD_HEIGHT = 600`, `Sexy/Constants.cs:549/555`).
* `Constants.Load480x800()` sets `S = 1`, `IS = 1`, `SUI = 0.8`, `ISUI = 1.25`
  (`Sexy/Constants.cs:524-531`; called from `Sexy/Main.cs:776` and
  `Lawn/LawnApp.cs:1119`). Therefore:
  * **1 reanim unit = 1 canvas pixel** after the reader scaling of §2.4
    (`ScaleFromPC` files are already pixels; `InvertAndScale` files are PvZ
    "480-space" units lifted by 1.875).
  * A sprite's on-screen size = `celWidth * transform.scaleX * overlayScaleX`
    (same for Y). `scale` in the JSON is a multiplier, not a size.
  * `skewX/skewY` are **degrees**. The engine precomputes
    `skewXCos = cos(-skewX*DEG_TO_RAD)`, `skewXSin = sin(-skewX*DEG_TO_RAD)`
    (`Sexy/TodLib/ReanimatorXnaHelpers.cs:67-70` with
    `DEG_TO_RAD = 0.017453292f` at `Sexy/TodLib/TodCommon.cs:899`; a local copy
    exists at `Sexy/TodLib/ReanimReader.cs:119`); with the y-down canvas this is a
    clockwise-positive rotation.
* Each live `Reanimation` has an **overlay matrix** `mOverlayMatrix`
  (`Sexy/TodLib/Reanimation.cs:2034`, type `Sexy/SexyTransform2D.cs:6-151`,
  an XNA `Matrix` used row-vector style: `v' = v * M`):
  * `SetPosition(x, y)` writes `M41/M42` (`Reanimation.cs:820-823`);
  * `OverrideScale(sx, sy)` writes `M11/M22` (`:825-830`);
  * the game calls these with board coordinates in pixels, e.g. plants
    `Plant.cs:8160-8161`, zombies build the matrix by hand
    `Zombie.cs:6771-6784` (M11 = ±`mScaleZombie`, M22 = `mScaleZombie`,
    M41/M42 = pixel offsets × `Constants.S`), projectiles `Projectile.cs:1467`.
* **Mirroring** = negative overlay `M11` (e.g. `OverrideScale(-x, y)` in
  `Lawn/Zombie.cs:7857`, `Lawn/TitleScreen.cs:282`, `Lawn/ZenGarden.cs:2087`;
  zombies walking left → `aOverlayMatrix.M11 = -mScaleZombie`, `Zombie.cs:6778`.
  Because sprites are drawn centered, mirroring needs no pivot fix-up.
* **High ground** is *not* encoded in the reanim data: `Constants.HIGH_GROUND_HEIGHT
  = 30` (`Sexy/Constants.cs:559`) and game logic shifts the draw position up by
  `mAltitude` (`Zombie.cs:3139-3142`, `:3322-3348`, `:4277-4287`). A renderer just
  draws the reanim at the position/scale the game gives it. Related: the `_ground`
  track's `transX` delta is used by game code to sync walk animation speed with
  movement (`Zombie.cs:5600-5612`; `Reanimation.AttacherSynchWalkSpeed`,
  `Reanimation.cs:1312-1362`; `Plant.cs:6606-6608`).

---

## 5. Rendering: exactly how a reanimation is drawn

### 5.1 Draw order

* Reanimations are inserted into the board render list with their `mRenderOrder`
  (`Lawn/Board.cs:1116-1129`) which is sorted (`Array.Sort`, `Board.cs:1203`;
  comparator by `mZPos` then `id`, `Lawn/RenderItem.cs:93-108`) and drawn in that
  order — so ordering **between** reanimations is by render order; the port keeps
  the game's render-order numbers.
* Inside one reanimation, `DrawRenderGroup(g, 0)` iterates tracks from index 0 to
  `mTrackCount-1` and draws those whose track-instance render group equals the
  requested group (`Sexy/TodLib/Reanimation.cs:283-318`) — i.e. **track order is
  draw order; later tracks paint over earlier ones** (e.g. `Zombie` head parts then
  outer arms).
* Every track defaults to render group `0` (`ReanimatorTrackInstance.Reset`,
  `Sexy/TodLib/ReanimatorTrackInstance.cs:63`). Game code reassigns selected
  track name prefixes to groups `1..8` and then calls `DrawRenderGroup` several
  times in a hand-tuned order — e.g. zombie shield group 1 / arms group 2 / over
  shield 3 (`Lawn/Zombie.cs:5250`, `:5294`, `:5302`, `:8898`;
  `Lawn/GameConstants.cs:1133-1154`; boss legs/arms `Zombie.cs:11049-11076`;
  pumpkin back `Plant.cs:659`, Challenge tree groups `Challenge.cs:7305-7310`).
  The port must copy those per-entity assignments from game code, not from the JSON.
* Reanimation **attachments** (child reanims attached to a track) draw right after
  the owner track (`Reanimation.cs:300-315`); attachment support exists in the
  runtime (`AttachToAnotherReanimation` `:634-651`, `UpdateAttacherTrack`
  `:1181-1241`, `attacher__` tracks `Sexy/TodLib/ReanimatorTrack.cs:19-22`) but
  **no shipped reanim file contains `attacher__` tracks or text**, so attachments
  only come from game code (`GlobalMembersAttachment`).

### 5.2 The per-transform matrix (`Reanimation.DrawTrack`, `:417-441`)

With `cx = celWidth/2`, `cy = celHeight/2` (the runtime uses `image.GetCelWidth()/2`,
`GetCelHeight()/2`, `:386-395`), and the transform's `kx,ky,sx,sy,tx,ty`:

```
kxr = kx * DEG_TO_RAD, kyr = ky * DEG_TO_RAD
num5 = cos(kxr) * sx          // affects +x axis
num6 = sin(kxr) * sx
num7 = -sin(kyr) * sy         // affects +y axis
num8 = cos(kyr) * sy
num9  = num5*cx + num7*cy + tx
num10 = num6*cx + num8*cy + ty

M11 = num5*O11 + num6*O21
M12 = num5*O12 + num6*O22
M21 = num7*O11 + num8*O21
M22 = num7*O12 + num8*O22
M41 = num9*O11 + num10*O21 + O41 + gTransX + shakeX - 0.5
M42 = num9*O12 + num10*O22 + O42 + gTransY + shakeY - 0.5
```

where `O = mOverlayMatrix` and `gTransX/gTransY` is the graphics translation
(normally 0 inside the board's render pass). `shakeX/Y` exist for game-code shake
effects (`SetShakeOverride` `:813-817`) and are 0 by default.

Because sprites are drawn **centered** (next section), the `num9/num10` and the
center subtraction cancel, so for the common diagonal overlay
(`O11 = overlaySX`, `O22 = overlaySY`, `O = translation P`) this simplifies to:

```
a = cos(kxr) * sx * overlaySX
b = sin(kxr) * sx * overlaySY
c = -sin(kyr) * sy * overlaySX
d = cos(kyr) * sy * overlaySY
e = P.x + tx * overlaySX
f = P.y + ty * overlaySY
```

and the sprite is drawn from local `(0, 0)` at `(e, f)` with local axes `(a,b)` (local +x) and
`(c,d)` (local +y). Canvas2D:
`ctx.setTransform(a, b, c, d, e, f); ctx.drawImage(img, sx, sy, cw, ch, 0, 0, cw, ch);`
(With `overlaySX = -1` this mirrors; `overlaySX = overlaySY = gameScale` scales.)

General case (if an overlay with rotation is ever used — e.g.
`TodCommon.TodScaleRotateTransformMatrix`, `Lawn/CutScene.cs:1717`):
`M' = localTransform * overlay` in XNA row-vector order; build the 2×2 as in the
formula above and multiply by the overlay, then subtract `cx,cy` from the
translation in the local frame.

### 5.3 Origin / centering / cel rectangle

* Correction verified 2026-11-15: `DrawTrack` first adds the transformed half-cel
  to `num9/num10`. The centered quad subtracts that same half-cel, leaving the
  sprite's **top-left** at the transformed `tx/ty`. Applying another half-cel
  subtraction in Canvas separates the body parts and sun layers.
* The original GPU sprite draw is centered on the **adjusted matrix point**: source rect is the cel
  (`celWidth × celHeight`), and the drawing call passes `center = true`, so the
  vertex quad is offset by half the *source rect* size before the matrix:
  `TodBltMatrix` → `g.DrawImageTransformed(..., center: true, ...)`
  (`Sexy/TodLib/TodCommon.cs:526-548`; `Sexy/Graphics.cs:799-809`:
  `center2 = (srcRect.mWidth*0.5, srcRect.mHeight*0.5)`), and `PrimitiveBatch.Draw`
  subtracts the center from the matrix translation (`Sexy/PrimitiveBatch.cs:80-93`).
* Half-pixel quirks of the D3D path (do not obsess over these; a web renderer can
  ignore them): `DrawTrack` adds `-0.5` to `M41/M42`
  (`Reanimation.cs:437-438`), and `PrimitiveBatch.AddVertex` subtracts another
  `0.5` from every vertex (`PrimitiveBatch.cs:301-302`) → the shipped engine draws
  sprites ~1.0 px up-left of the ideal center. Because the whole game uses the same
  convention (all `DrawImage` paths pass through `AddVertex`), the port cannot
  recover that 1 px from the reanim data alone; use exact centers
  (`e = P.x + tx*overlaySX`) and optionally subtract 0.5 px to match screenshots.
* Source rect: `(celWidth*i, 0, celWidth, celHeight)` with
  `i = round(frame) mod image.mNumCols` — column `i`, row 0 (§3.3). The JSON stores
  the image *name*; the port's atlas layer resolves name → rect + columns.

### 5.4 Colour, alpha, extra additive pass

* `trackColor` starts as the track instance's `mTrackColor` (white,
  `ReanimatorTrackInstance.cs:67`) and is multiplied by `mColorOverride`
  (default white, `Reanimation.cs:72`) component-wise /255
  (`Reanimation.cs:344-348`), unless the track ignores the override.
* Final alpha byte: `clamp(int(transform.alpha * trackColor.a + 0.5), 0, 255)`
  (`:356-362`); `0` skips the sprite. `transform.alpha` may be slightly outside
  [0,1] (data range −0.08 … 1.09) and must be clamped, not rejected.
* `g.mColorizeImages` (a global tint set by `SetColorizeImages`, used by e.g. the
  Dancer spotlight, `Zombie.cs:8828-8837`) multiplies R/G/B/A again.
* If `mEnableExtraAdditiveDraw`, the sprite is drawn a second time with
  `DRAWMODE_ADDITIVE` using `mExtraAdditiveColor` (`:363-371`, `:470-473`). Game
  code uses this for hit flashes / chilled (blue) / hypnotised (pink) tints
  (`Lawn/Zombie.cs:5224-5242`). Optional for the first web milestone.
* There is no per-pixel tint in the reanim data itself — all colour comes from the
  entity/board state.

### 5.5 Clipping

* Each track is drawn clipped to the current graphics clip rect (`g.mClipRect`,
  `Reanimation.cs:410-416`); tracks with `mIgnoreClipRect` use `(0,0,1000,600)`
  instead. `mClip` also feeds `TodBltMatrix`'s clip flag (`:1387-1416`), and the
  board sets clip rects per render pass (e.g. `Board.cs` draw loop, pool clipping in
  `Zombie.DrawReanim` `:5176-5179`). For the web port: implement a rectangular clip
  per draw pass; the per-track `mIgnoreClipRect` flag is set by game code only (not
  in the data).

### 5.6 Mirroring / facing

* Data is never pre-mirrored. Facing is the overlay `M11` sign (§4). Because the
  sprite origin is its center, no pivot correction is required. If a sprite must be
  mirrored about a track-local point instead (attachments), the engine multiplies
  matrices; ignore unless implementing attachments.

### 5.7 Special cases a static renderer must handle

| case | behaviour | citation |
| --- | --- | --- |
| `transform.frame < 0` | hidden (skip draw) | `Reanimation.cs:334-338` |
| `alpha <= 0` after clamp | skip | `:356-362` |
| image name empty | nothing is drawn (unless font/text/fullscreen rule) | `:389-409` |
| image name not found in atlas | runtime falls back to previous image of the same track during load, then draws whatever the name resolves to | `ReanimatorTransform.cs:64-83`, `ReanimatorXnaHelpers.cs:71-80` |
| track name `"fullscreen"` with no image | fill the whole 1000×600 canvas rect with the colour; matrix/scale ignored (only `ZombiesWon`) | `:401-409`, `:487-493` |
| `mFrameBasePose` | only affects attachment base-pose matrices, not normal drawing | `:2031`, `:645-648`, `:1047-1069` |
| `mTruncateDisappearingFrames` | if the "after" frame is hidden mid-interpolation the track is not drawn; default true | `:534`, `:572-577`, `:1085-1101` |
| image override | runtime may replace an image by track name (e.g. catapult pole damage) | `:449-452`, `Zombie.cs:6711-6722` |
| placeholder sentinel | already resolved by the converter; if ever re-parsing raw XNB, remember `-99999` never reaches the renderer | §2.3 |

### 5.8 Renderer pseudocode (JS, Canvas2D)

```js
const doc = await fetch(`data/reanim/${name}.json`).then(r => r.json());
const tracks = doc.tracks;                       // array order = draw order
const byName = new Map(tracks.map(t => [t.name, t]));

// --- playback state ------------------------------------------------------
let anim, animTime = 0, rate = doc.fps, loop = 'loop';

function play(trackName, loopType = 'loop', rateOverride = 0) {
  const t = byName.get(trackName.toLowerCase()) ?? tracks[0];  // FindTrackIndex -> 0
  anim = { start: t.frameStart, count: t.frameCount };
  animTime = 0;
  loop = loopType;
  rate = rateOverride || doc.fps;
}

function step(dtSeconds) {                      // 100 Hz fixed step in the original: dt = 0.01
  if (!anim || anim.count <= 0) return;
  animTime += dtSeconds * rate / anim.count;    // Reanimation.cs:177
  if (loop === 'loop')          { while (animTime >= 1) animTime -= 1; }
  else if (loop === 'hold')     { animTime = Math.min(animTime, 1); }
  else                          { if (animTime >= 1) animTime = 1; /* + dead flag */ }
}

function currentFrame() {                       // Reanimation.cs:581-613
  const full = (loop === 'fullLast');           // *FullLastFrame variants only
  const n = full ? anim.count : anim.count - 1;
  const t = anim.start + n * animTime;
  // C#: num3 = (int)t; before = (short)(num3 + 0.5f) === floor(t)
  return Math.min(Math.floor(t), anim.start + anim.count - 1);
}

// --- drawing -------------------------------------------------------------
function drawReanim(ctx, anchorX, anchorY, overlaySX = 1, overlaySY = 1) {
  const frame = currentFrame();
  for (const track of tracks) {
    const tr = track.transforms[frame];
    if (!tr || tr.frame < 0) continue;                    // hidden
    const atlas = resolveImage(tr.img);                   // name -> {canvas, x, y, cw, ch, cols}
    if (!atlas) continue;
    const alpha = Math.max(0, Math.min(255, Math.round((tr.alpha ?? 1) * 255)));
    if (alpha <= 0) continue;
    const kx = (tr.kx ?? 0) * Math.PI / 180;
    const ky = (tr.ky ?? 0) * Math.PI / 180;
    const sx = tr.sx ?? 1, sy = tr.sy ?? 1;
    const a =  Math.cos(kx) * sx * overlaySX;
    const b =  Math.sin(kx) * sx * overlaySY;
    const c = -Math.sin(ky) * sy * overlaySX;
    const d =  Math.cos(ky) * sy * overlaySY;
    const e = anchorX + (tr.tx ?? 0) * overlaySX;
    const f = anchorY + (tr.ty ?? 0) * overlaySY;
    const col = Math.round(tr.frame) % atlas.cols;
    ctx.save();
    ctx.setTransform(a, b, c, d, e, f);
    ctx.globalAlpha = alpha / 255;
    ctx.drawImage(atlas.canvas, atlas.x + col * atlas.cw, atlas.y, atlas.cw, atlas.ch,
                  -atlas.cw / 2, -atlas.ch / 2, atlas.cw, atlas.ch);
    ctx.restore();
  }
}
```

For smooth 60 fps playback, interpolate transforms between `before`/`after` frames
exactly as `GetTransformAtTime` does (lerp `tx,ty,sx,sy,alpha,kx,ky`; keep
`img/frame` from `before`) and step with real `dt` instead of 0.01 s.

---

## 6. JSON contract (`reanim2json.py` output)

### 6.1 Schema

```jsonc
{
  "name": "Agave",              // file stem
  "source": "Agave.xnb",
  "fps": 60,                    // mFPS; default animation rate
  "scaleType": "ScaleFromPC",   // ReanimScaleType name
  "scaleByte": 255,             // raw byte (0/1/255)
  "trackCount": 9,
  "globalFrameCount": 1290,     // length of the shared frame timeline (per-track transform count)
  "interpolate": true,          // Reanimation.mInterpolate
  "tracks": [
    {
      "name": "anim_idle",      // lower-cased, runtime semantics
      "frameStart": 0,          // GetFramesForLayer() result (§3.1)
      "frameCount": 200,
      "transforms": [           // exactly globalFrameCount entries
        { "img": "IMAGE_REANIM_AGAVE_IDLE_000", "alpha": 1, "frame": 0,
          "sx": 0.8, "sy": 0.8, "kx": 0, "ky": 0, "tx": -36, "ty": -44 }
        // {"font": "...", "text": "..."} only if a font/text name exists (none in shipped data)
      ]
    }
  ]
}
```

Field rules:

* `img`/`font`/`text` are omitted when empty (all shipped data: `font`/`text` never
  appear).
* `alpha, frame, sx, sy, kx, ky, tx, ty` are **always present** and already
  resolved (no `-99999`, no inheritance needed at load time) — except with
  `--compact`, which omits fields equal to their track defaults so the loader must
  fill `tx=ty=kx=ky=frame=0, sx=sy=alpha=1` and inherit empty strings.
* Numbers are integers when integral, otherwise rounded to 4 decimals.
* `tx/ty` are the post-scale values from §2.4 (so InvertAndScale files already
  contain ×1.875). `--keep-raw` additionally emits `rtx/rty` = the raw value read
  from the file (or `null` if that field was a placeholder and inherited).
* `"name"`/`"scaleType"`/`"trackCount"`/`"tracks"` follow the requested schema;
  `source/scaleByte/globalFrameCount/interpolate/frameStart/frameCount` are
  extensions documented above.
* The animation to play is found by **track name**; `frameStart/frameCount` give its
  window. `globalFrameCount` is *not* the animation length.

### 6.2 Mapping JSON ↔ runtime fields

| JSON | runtime | notes |
| --- | --- | --- |
| `fps` | `ReanimatorDefinition.mFPS` → `Reanimation.mAnimRate` | overridden by `PlayReanim(..., animRate)` when ≠ 0 |
| `scaleType/scaleByte` | `ReanimReader.ReanimScaleType` | only affects load-time `tx/ty` scaling |
| `tracks[].name` | `ReanimatorTrack.mName` | lower-cased by `Common.Lower` |
| `frameStart/frameCount` | `Reanimation.mFrameStart/mFrameCount` | from `GetFramesForLayer` |
| `img` | `ReanimatorTransform.mImageName` → `mImage` | atlas resolution happens in `ExtractImages` |
| `frame` | `ReanimatorTransform.mFrame` | `<0` hidden; else cel column |
| `alpha` | `mAlpha` | × `trackColor.a`, clamped |
| `sx/sy` | `mScaleX/mScaleY` | multiplies cel size |
| `kx/ky` | `mSkewX/mSkewY` | degrees; precomputed cos/sin at load |
| `tx/ty` | `mTransX/mTransY` | added to overlay position (after scale rule) |

---

## 7. Converter usage & verification

```bat
python tools\reanim2json.py --in  "D:\逆向\PlantGirlsVsZombies\Content\reanim\Agave.xnb" --out data\reanim\Agave.json
python tools\reanim2json.py --batch "D:\逆向\PlantGirlsVsZombies\Content\reanim" --outdir data\reanim
python tools\reanim2json.py --verify --data data\reanim
```

(`python` = `C:\Users\yuban\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe`)

Options: `--keep-raw` (add `rtx/rty`), `--compact` (omit default numerics),
`--pretty` (indented JSON). The parser **requires** the payload to end exactly at
EOF and errors on compressed XNB (`flags & 0x80`, LZ4) or unknown scale/optimization
bytes; it also validates the XNB magic/size and reports the reader manifest.

Batch result (2026-11-14):

* **150/150 converted**, 0 failures; parse of every file consumed exactly `len(file)`.
* output size **62.25 MiB (65,274,271 B)** of compact JSON; largest `Zombie_boss.json`
  (5.4 MiB, 72 tracks × 792 frames), smallest `LawnMoweredZombie.json` (937 B).
  `--compact` reduces the corpus to 43.09 MiB.
* 632,842 transforms, 2,872 tracks, 6,659 distinct image ids.
* `--verify` re-parses every JSON, checks the required keys/types, and prints the
  Agave/zombie sanity report; e.g.:

```
Agave.json: name='Agave' fps=60 scaleType='ScaleFromPC' tracks=9 globalFrameCount=1290
  anim_idle: frameStart=0 frameCount=200 transforms=1290
  anim_idle[0]: img='IMAGE_REANIM_AGAVE_IDLE_000' tx=-36 ty=-44 sx=0.8 sy=0.8 alpha=1 frame=0
...
OK: 150 files parse; 150 unique names; no schema errors
```

Zombie animation examples from `--verify` (`Zombie.json`: 42 tracks / 504 frames):

| animation | frameStart | frameCount |
| --- | --- | --- |
| anim_idle | 0 | 29 |
| anim_walk | 44 | 47 |
| anim_eat | 138 | 40 |
| anim_death | 178 | 39 |
| anim_dance | 454 | 50 |
| anim_superlongdeath | 292 | 137 |

---

## 8. Open items / decisions for the port

1. **Spine fallback files**: 27 of the 150 reanim files are only used when an entity
   is drawn via Spine (34 `ReanimationParams` entries have `isSpine=true`;
   `GameConstants.cs:151-300`). If the port renders those entities from reanim JSON
   anyway, they are usable, but some of those files are degenerate/incomplete
   (e.g. `PeaShooter/anim_idle` has a 1-frame window) — use only if needed.
2. **Track render-group assignments** are game logic, not data (`AssignRenderGroup*`
   calls in `Zombie.cs`, `Plant.cs`, `Challenge.cs`, …). Exact layering (zombie
   arms/shield, pumpkin back, boss limbs) requires porting those calls; the JSON has
   only the default group 0 track order.
3. **Half-pixel offsets**: the D3D path draws ~1 px up-left of the ideal center
   (§5.3). Decide one convention for the port (center exactly, or −0.5 px) and apply
   it everywhere so sprites stay aligned across entities.
4. **Atlas mapping**: reanim image names (`IMAGE_REANIM_*`) must be resolved to atlas
   slices + `mNumCols` by the port's resource layer (`Lawn/AtlasResources_600x1000.cs`
   contains the generated name→image table; `AtlasResources.GetIdByImageInAtlas` was
   not fully decompiled, `.il` dump in the analysis output). In shipped data `frame`
   is always 0/−1, so strip column selection is only needed for fidelity.
5. **Interpolation**: the original interpolates transforms at 100 Hz (`mInterpolate`
   true). If the port renders at 60 fps it should interpolate transforms (not
   sprite-swap) between `before/after` frames for matching smoothness.
6. **`fullscreen` track** (`ZombiesWon`) expects a solid-colour fill of the whole
   1000×600 board (with its fade alpha); implement it as a special case or ignore.
7. **`mFPS` vs explicit rates**: the effective animation speed is usually the
   `animRate` argument of `PlayReanim`, which lives in game code (examples above).
   The JSON `fps` is only the default.

---

## 9. Reference index (files cited)

| file | relevant lines |
| --- | --- |
| `Sexy/TodLib/ReanimReader.cs` | 10-25 Read; 28-40 track; 43-62 default; 65-113 transform; 89-110 scaling; 112-116 static previous; 121-141 enums |
| `Sexy/TodLib/CustomContentReader.cs` | 10-14 buffer; 17-38 primitives; 49-64 UTF-16 string |
| `Sexy/TodLib/ReanimatorXnaHelpers.cs` | 21-29 fill helper; 32-101 load/fill-in; 67-70 cos/sin; 71-96 inherit; 160-177 lazy load; 228 sentinel; 237-240 render groups; 243 SECONDS_PER_UPDATE; 246 def array |
| `Sexy/TodLib/ReanimatorDefinition.cs` | 11-16 ctor (fps 12); 19-39 ExtractImages |
| `Sexy/TodLib/ReanimatorTrack.cs` | 12-23 lower-case name / IsAttacher; 26-31 ctor |
| `Sexy/TodLib/ReanimatorTransform.cs` | 55-61 Reset; 64-83 ExtractImages; 86-137 fields |
| `Sexy/TodLib/ReanimatorTrackInstance.cs` | 49-70 defaults (render group 0, white colour, truncate) |
| `Sexy/TodLib/ReanimatorFrameTime.cs` | 6-16 frame time struct |
| `Sexy/TodLib/Reanimation.cs` | 107-129 init; 160-268 Update; 179 loop; 271-318 Draw; 321-497 DrawTrack; 417-441 matrix; 500-578 current transform/interp; 581-613 frame time; 616-632 FindTrackIndex; 709-726 SetFramesForLayer; 820-830 position/scale; 889-924 track matrix; 927-966 render groups; 969-980 colour propagation; 1047-1069 base pose; 1104-1117 PlayReanim; 1149-1178 GetFramesForLayer; 1181-1241 attacher; 1312-1362 walk sync; 1387-1416 ReanimBltMatrix; 1994-2162 fields/constants |
| `Sexy/TodLib/ReanimLoopType.cs` | 6-21 enum |
| `Sexy/TodLib/ReanimationType.cs` | 6 enum start (definition index; not file data) |
| `Sexy/TodLib/ReanimationParams.cs` | 21-48 params (isSpine/old filename) |
| `Sexy/TodLib/ReanimXmlReader.cs` | 14-48, 91-152 alternate XML source format (loader not used for shipped XNB) |
| `Sexy/Constants.cs` | 494-509 scale helpers; 524-559 Load480x800 (S/ISUI/1000×600/HIGH_GROUND_HEIGHT); 1546/1549/1690 statics |
| `Sexy/Main.cs` | 33-39 back buffer + 100 Hz fixed step; 776 Constants load |
| `Sexy/Graphics.cs` | 727-753 BeginPrimitiveBatch; 799-809 DrawImageTransformed (center=true) |
| `Sexy/PrimitiveBatch.cs` | 25-35 ortho; 60-133 transformed quad; 193-229 Begin; 284-314 AddVertex (half-pixel) |
| `Sexy/TodCommon.cs` | 526-548 TodBltMatrix; 899 DEG_TO_RAD |
| `Sexy/Common.cs` | 122-143 StringToLower/Lower |
| `Sexy/ResourceManager.cs` | 109-130 LoadReanimation (+ExtractImages) |
| `Sexy/Image.cs` | 28-42 cel size; 73-80 cel rect |
| `Lawn/GameConstants.cs` | 151-300 ReanimationParams table; 1133-1154 render group ids |
| `Lawn/Zombie.cs` | 5224-5242 colour/alpha override; 5250/5294/5302 draw groups; 5600-5612 ground sync; 6256 ground track; 6711-6722 image override; 6771-6784 overlay matrix/mirror; 7857 mirror; 8898 arms group; 11049-11076 boss groups; 3322-3348 high ground |
| `Lawn/Plant.cs` | 659 pumpkin group; 8160-8161 position/scale; 6606-6608 ground velocity |
| `Lawn/Board.cs` | 1116-1129 render list; 1203 sort; 1208-1302 draw |
| `Lawn/RenderItem.cs` | 93-108 sort comparator |
| `Lawn/GlobalMembersReanimIds.cs` | 10+ track-name constants used by game logic |
| `Lawn/ReanimationID.cs` | 6-10 handle enum (not format) |
