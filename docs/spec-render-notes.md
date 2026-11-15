# spec-render — method, evidence and verification notes

Companion to `spec-render.md` / `layout.json`. Written by the render-spec subagent; nothing outside
`D:\逆向\plangirls-web\docs\` and `D:\逆向\plangirls-web\data\` was modified.

## What was read

* `decompiled/Lawn/Sexy/Constants.cs` — both layout loaders. The shipping build uses
  `Constants.Load480x800()` (`Sexy/Main.cs:775-776`), not `Load600x1000`, so all resolved numbers are from
  the former (S=1, SUI=0.8, BOARD_OFFSET=220, BOARD_EDGE=-100, GRIDSIZEX=9, MAX_GRIDSIZEY=6,
  LAWN_XMIN=40, LAWN_YMIN=80, cell 80x100 for 5-row stages, `Constants.New` cell sizes 80/85/100).
* `Sexy/Main.cs` — backbuffer 1000x600, `TargetElapsedTime = 0.01s` (100 ticks/s), ScreenScales init.
* `Sexy/ScreenScales.cs` — scale/letterbox math (1600x900 window ⇒ scale 1.5, transX 50).
* `Sexy/Graphics.cs`, `Sexy/WidgetManager.cs`, `Sexy/WidgetContainer.cs`, `Sexy/GameObject.cs` — how
  widget translations compose (`screen = board.mX(100) + boardLocal`), how DrawImage/Cel draws.
* `Lawn/Board.cs` — grid conversion, PickBackground, DrawBackdrop, DrawGameObjects/render order and all
  UI draw functions, seed packet Y, wave logic, mower init, sun spawning.
* `Lawn/SeedBank.cs`, `Lawn/SeedPacket.cs`, `Lawn/Coin.cs`, `Lawn/LawnMower.cs`, `Lawn/Plant.cs`,
  `Lawn/Zombie.cs`, `Lawn/ReanimatorCache.cs`, `Lawn/GameConstants.cs`, `Lawn/CutScene.cs`,
  `Lawn/LawnApp.cs`, `Lawn/GameObject.cs`.
* `Sexy/AtlasResources_600x1000.cs` — UNPACK_INFO entries give logical sprite sizes (DAN_SUNBANK 143x44,
  FLAGMETER 237x80 rows=2, COINBANK 192x47, SHOVELBANK_ZEN 70x72, BUTTON_LEFT 29x45, etc.).
* `Content/resources.xml` — resource ids → paths + `invscale` (background1_hd invscale=1,
  seedpackets_hd_2x invscale=2 rows 13 cols 4).

## Asset verification (background / seed packets)

The shipped `Content` media are plain MonoGame XNB files wrapped in this build's LZ4-block compression
(header: `XNBm`, version 5, flags 0x40, uint32 fileSize; then int32 decompressedSize; LZ4 raw-block from
offset 14). I decoded the XNB payloads with a small LZ4 raw-block decompressor and parsed the
`Texture2DReader` object (Color format):

* `background1_hd.xnb` → **1880 x 720** (unsodded variant identical). Drawn 1:1 at board-local (-460,-60);
  I rendered the grid formula over the extracted PNG and the 9x5 80x100 cell lines line up with the lawn
  art, giving the mapping `background pixel = (500+80*col, 140+100*row)`.
* `seedpackets_hd_2x.xnb` → 648 x 2756 ⇒ image 324x1378 logical (invscale 2) ⇒ cel 81x106, matching
  `SMALL_SEEDPACKET_WIDTH=81` / `SMALL_SEEDPACKET_HEIGHT=52`; the opaque card starts at the cel vertical
  middle (measured first opaque row 83-110 of the 212 px HD cel), i.e. `packet.mY` is the card top.

These are reported as "measured" in `layout.json.assets`.

## Verification performed

* JSON parses (`json.load`), 21 top-level sections, all cited constants resolved to numbers.
* Spot-checked ~45 cited `file:line` pairs against the decompiled sources; corrected one (camera enable
  is `Lawn/Board.cs:13961`, not 13960) and one derived value (packet selection overlay effective offset is
  (-5,-2), because y is subtracted).
* Cross-checked all resolved UI positions against their draw call sites (e.g. sun bank 119 = constant 119
  minus board offset 100 plus board translation 100; shovel 270; progress meter 450; menu 800; coin bank
  138,551; level text 891,565).

## Known approximations / unresolved

See `spec-render.md` §13 and `layout.json.unresolved`: background native size comes from the asset (not
code), atlas `mInvScale=0.8` sprites (intro sod rolls) could not be fully resolved, reanim artwork
hotspots are given but per-frame art must be converted separately, seed-packet card sub-rect varies per
portrait, and some game-over overlay sizes were not measured (out of scope).
