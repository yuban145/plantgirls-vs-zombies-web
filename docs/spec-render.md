# PlantGirlsVsZombies — Rendering / Layout Spec for the TS+Canvas2D Port

Source of truth: decompiled C# under `D:\逆向\output\PlantGirlsVsZombies\decompiled\Lawn\`
(paths below are relative to that folder, e.g. `Lawn\Board.cs:5501` = `…\decompiled\Lawn\Lawn\Board.cs` line 5501).
Assets referenced from `D:\逆向\PlantGirlsVsZombies\Content\`.

The game loads `AtlasResources_600x1000` and then calls `Constants.Load480x800()` — this is the only layout
loaded in the shipping build (`Sexy\Main.cs:775-776`), so **every number in this document is from
`Constants.Load480x800()`** (`Sexy\Constants.cs:524-1036`) unless stated otherwise.

Scope: the normal **Day adventure lawn** (`BackgroundType.Num1Day`, adventure levels 1-10, i.e.
`PickBackground` maps `mLevel <= 10` to `Num1Day`, `Lawn\Board.cs:9444-9447`). Night/pool/roof/fog and
mini-games are intentionally not covered (one-line notes where a shared constant leaks into Day gameplay).

---

## 0. Coordinate systems, canvas and scale

### 0.1 Logical canvas = 1000 x 600

* `Constants.BackBufferSize = new Point(600, 1000)` (`Sexy\Constants.cs:548`, in Load480x800) — note the
  stored order is **(height, width)** because every consumer uses `.Y` for width and `.X` for height.
* `Main` sets `PreferredBackBufferWidth = 1000`, `PreferredBackBufferHeight = 600`
  (`Sexy\Main.cs:33-34`), and initialises the scaler with
  `mScreenScales.Init(ww, wh, Constants.BackBufferSize.Y, Constants.BackBufferSize.X)`
  (`Sexy\Main.cs:54,76,89,209,256`), i.e. virtual = (1000, 600).
* `BOARD_WIDTH = 1000`, `BOARD_HEIGHT = 600` (`Sexy\Constants.cs:555,549`).
* Default window from `config.json` is **1600 x 900** (fullscreen=false).
* The whole game is therefore authored in **logical pixels on a 1000x600 canvas**; the TS port should use
  `canvas.width = 1000`, `canvas.height = 600` (or the same virtual-camera model).

### 0.2 Logical → window pixels

`ScreenScales.Init(screenW, screenH, virtualW, virtualH)` (`Sexy\ScreenScales.cs:10-32`):

```
if screenH * virtualW >= screenW * virtualH:      // window relatively wider than 5:3
    scale = screenW / virtualW ; transX = 0
    transY = (screenH - virtualH*scale) / 2
else:                                             // window relatively taller
    scale = screenH / virtualH ; transY = 0
    transX = (screenW - virtualW*scale) / 2
windowPixel = logical * scale + (transX, transY)
```

For the shipped 1600x900 window: `900*1000 = 900000 < 1600*600 = 960000` → else-branch:
`scale = 1.5`, `transX = (1600-1500)/2 = 50`, `transY = 0` (pillarbox on the sides).
The scale matrix is applied when the sprite batch begins (`Sexy\Graphics.cs:270-278`).
Reverse mapping (used for mouse input): `logical = (window - trans) / scale`
(`Sexy\ScreenScales.cs:83-92`).

### 0.3 Update tick: **100 ticks / second** (10 ms / tick)

* `base.TargetElapsedTime = TimeSpan.FromSeconds(0.01)` (`Sexy\Main.cs:39`) with MonoGame's default
  `IsFixedTimeStep = true` ⇒ fixed 100 updates per second.
* Update path: `Main.Update` → `SexyAppBase.UpdateApp` (`Sexy\Main.cs:404`) →
  `SexyAppBase.DoUpdateFrames/UpdateFrames` (`Sexy\SexyAppBase.cs:312-369`) →
  `WidgetManager.UpdateFrame` → `Board.Update` (`Lawn\Board.cs:4605-4732`).
* `LawnApp.UpdateFrames` may run n updates per rendered frame: slow-mo/fast-forward debug
  (`Lawn\LawnApp.cs:1999-2030`) and the in-game **speed toggle**: `mAccelerationNumerator` ∈ {1,2,3}
  (default 1, `Lawn\Board.cs:14498`; cycled by `AccelerationIncrease/Decrease`, `Lawn\Board.cs:3499-3512`;
  0 = paused), so the loop calls the simulation 1-3 times per frame (`Lawn\Board.cs:4691-4729`).
* **All integer countdowns in data are ticks.** E.g. peashooter `refresh = 750` ⇒ 7.5 s; sun
  countdown 425-700 ⇒ 4.25-7.00 s; zombie first-wave countdown 1800 ⇒ 18 s. In the TS port use a fixed
  `dt = 1/100` simulation step and never integrate by screen refresh rate.

### 0.4 Widget translation stack (what you must replicate to get positions right)

* `WidgetManager.DrawWidgetsTo` draws each top-level widget with `g.Translate(widget.mX, widget.mY)`
  (`Sexy\WidgetManager.cs:306-323`); child widgets are translated again by their own `mX/mY`
  (`Sexy\WidgetContainer.cs:485-498`).
* The **Board widget** is created with `mX = Constants.Board_Offset_AspectRatio_Correction = 100`, `mY = 0`
  (`Lawn\Board.cs:705-710`; `Lawn\LawnApp.cs:904-910`), so:

```
screenX = 100 + boardLocalX          screenY = boardLocalY
boardLocalX = screenX - 100          boardLocalY = screenY
```

  (`Board_Offset_AspectRatio_Correction = 100` at `Sexy\Constants.cs:533`; `S = IS = 1`, `SUI = 0.8`,
  `ISUI = 1.25` at `Sexy\Constants.cs:528-531`.)
* The Board widget also owns a `Board.Camera` (`Lawn\Board.cs:898-903`, enabled at `Lawn\Board.cs:13961`).
  For Day play it is identity: `X=0, Y=0, Zoom=1` (`Lawn\Board.cs:14614-14624`, transform math
  `Lawn\Board.cs:14641-14650`). So in normal play there is **no camera offset/zoom**; ignore the camera in
  the port except for the cut-scene pan (section 3.2).
* Board clip/full-rect: `FullRect = (-100, mY, mWidth, mHeight)` (`Lawn\Board.cs:678-681`).

Unless explicitly marked "screen", all gameplay coordinates in the rest of this document are
**board-local**; add `(100, 0)` to obtain screen/logical coordinates.

### 0.5 Constant helpers (`Sexy\Constants.cs`)

```
InvertLowResValue(x) = 1.875 * x                      // line 494-497
InvertAndScale(x)    = 1.875 * x * S = 1.875*x        // S = 1 (lines 500-503, 528)
InvertAndScaleUI(x)  = 1.875 * x * SUI = 1.5*x        // SUI = 0.8 (lines 506-509, 530)
InvertAndScaleGame(x)= x                              // lines 512-515
```

C# `(int)` casts truncate toward zero (relevant for e.g. `(int)InvertAndScale(-3f) = -5`).

---

## 1. Lawn grid

| Quantity | Value | Citation |
|---|---|---|
| Columns `GRIDSIZEX` | 9 | `Sexy\Constants.cs:560` |
| Row array size `MAX_GRIDSIZEY` | 6 | `Sexy\Constants.cs:561` |
| Playable rows on Day | **5** (rows 0-4; row 5 = `PlantRowType.Dirt`) | `Lawn\Board.cs:9635-9642` |
| Cell width `Board_GridCellSizeX` | 80 | `Sexy\Constants.cs:3026` |
| Cell height, 5-row stages `Board_GridCellSizeY_5Rows` | **100** | `Sexy\Constants.cs:3026-3028` |
| Cell height, 6-row stages `Board_GridCellSizeY_6Rows` | 85 (not used on Day) | same |
| `LAWN_XMIN` (grid origin X) | 40 | `Sexy\Constants.cs:579` |
| `LAWN_YMIN` (grid origin Y) | 80 | `Sexy\Constants.cs:580` |
| `BOARD_HEIGHT_GAME` | 600 | `Sexy\Constants.cs:550` |
| `HIGH_GROUND_HEIGHT` | 30 (only high-ground stages) | `Sexy\Constants.cs:559` |
| `WIDE_BOARD_WIDTH` | 800 (logical "board right edge"; see mower) | `Sexy\Constants.cs:577` |

Day is not a "6 rows" stage (`StageHas6Rows()` false for `Num1Day`, `Lawn\Board.cs:5385-5388`), so the
5-row formula applies.

### 1.1 Grid → board-local pixels (authoritative)

`GridToPixelX` (`Lawn\Board.cs:5493-5502`) and `GridToPixelY` (`Lawn\Board.cs:5505-5536`):

```
cellLeft(col)      = 40 + 80 * col                         // col 0..8  → 40..680
cellTop(col,row)   = 80 + 100 * row                        // Day, row 0..4 → 80,180,280,380,480
                     (+ StageHas6Rows ? 85*row : 100*row; roof adds per-column extra — not Day)
                     (high-ground cells add -30; not Day)
cellSize           = 80 x 100 (Day)
```

A plant's anchor is this cell top-left (`PlantInitialize`: `mX = GridToPixelX`, `mY = GridToPixelY`,
`Lawn\Plant.cs:217-227`). Zombies use the same row Y (`GetPosYBasedOnRow` returns `GridToPixelY(0,row)`,
`Lawn\Board.cs:10986-10999`; `Zombie.ZombieInitialize` sets `mPosY` from it, `Lawn\Zombie.cs:306`).
Lawn start (left edge of column 0) at board-local x=40 = screen x=140; last column ends at
board-local x=760 = screen x=860.

**Pixel → grid** (mouse picking): `PixelToGridX = (x < 40) ? -1 : clamp((x-40)/80, 0, 8)`
(`Lawn\Board.cs:5451-5462`); `PixelToGridY = clamp((y-80)/100, 0, 4)` for 5-row stages
(`Lawn\Board.cs:5465-5490`). These functions receive **board-local** coordinates in normal play
(`Board.MouseHitTest` is called with widget-local coords, `Lawn\Board.cs:5624-5634`).

### 1.2 Separate "cel" Y table (art-aligned row tops)

`Constants.Board_Cel_Y_Values_Normal = { 80, 177, 280, 380, 470, 570, 610 }` (`Sexy\Constants.cs:898`).
Used only by `GetCelPosition` (`Lawn\Board.cs:7905-7979`) for the mouse hover cell highlight
(`DrawCelHighlight`, `Lawn\Board.cs:7879-7902`) and by ice overlays; it does **not** move plants/zombies.
Quirks worth knowing:
* Highlight quad for (col,row): `(40+80col, table[row]) → (col==8 ? 878 : 40+80col+80, table[row]) →
  same x, table[row+1])`; the `878` for the last column is in the code (`Lawn\Board.cs:7964-7976`) and
  makes the last-column highlight wider than 80 px. Treat as a legacy quirk.
* Snow/ice rows are drawn at `GridToPixelY(8,row)+20` (`Lawn\Board.cs:7840-7876`).

### 1.3 Handy resolved positions (board-local and screen)

| Grid cell | cell left (local/screen) | cell top (local/screen) |
|---|---|---|
| col 0 | 40 / 140 | row0 80 / 80 |
| col 8 | 680 / 780 | row1 180 / 180 |
|            |         | row2 280 / 280 |
|            |         | row3 380 / 380 |
|            |         | row4 480 / 480 |

The background image was created for exactly this: lawn cell (col,row) maps to background pixel
`(500 + 80*col, 140 + 100*row)` (see §2.2; verified by extracting the asset and overlaying the grid).

---

## 2. Background

### 2.1 Which image / when

* Day adventure (level 1-10, and quick-play 1-10): `BackgroundType.Num1Day` (`Lawn\Board.cs:9444-9447`).
* `DrawBackdrop` case `Num1Day`: `offsetX=-192, offsetY=-48`, `image = Resources.IMAGE_BACKGROUND1`
  (`Lawn\Board.cs:4918-4922`).
* For the *first-time* level 1-4 intro (sod-rolling cutscene) the same code path draws
  `Resources.IMAGE_BACKGROUND1UNSODDED` plus `AtlasResources.IMAGE_SOD1ROW` / `IMAGE_SOD3ROW` and for
  level 4 a rolling slice of `IMAGE_BACKGROUND1` (`Lawn\Board.cs:4993-5015`; resource group chosen in
  `LoadBackgroundImages`, `Lawn\Board.cs:13059-13074`). For normal (post-intro) Day play only
  `IMAGE_BACKGROUND1` is used.

### 2.2 Draw position, scale and mapping to the lawn

`DrawBackdrop` (`Lawn\Board.cs:4911-5046`):

```
offsetX = (int)(-192 * 1.25f) = -240          // lines 4919, 4990-4991
offsetY = (int)( -48 * 1.25f) =  -60
drawPosition(local) = (offsetX - BOARD_OFFSET*S, offsetY) = (-240 - 220, -60) = (-460, -60)
drawPosition(screen) = (-360, -60)
```

`BOARD_OFFSET = 220` (`Sexy\Constants.cs:557`), `S = 1`. The image is drawn **1:1, unscaled**
(`g.DrawImage(image, x, y)`, `Lawn\Board.cs:5024`).

Measured asset (extracted from `Content\images\600x1000\background1_hd.xnb`, XNB → LZ4 → RGBA):
**1880 x 720 px**, `invscale="1"` in `Content\resources.xml` ⇒ displayed at 1880x720 logical.
So the Day backdrop occupies logical pixels **x ∈ [-360, 1520], y ∈ [-60, 660]**; the visible
1000x600 screen shows the sub-rectangle art pixels `(360..1360, 60..660)`.

Mapping (verified by drawing the grid over the extracted background, cell boundaries line up):

```
backgroundPixelX = screenX + 360 = boardLocalX + 460
backgroundPixelY = screenY + 60  = boardLocalY + 60
grid cell (col,row) → background pixel (500 + 80*col, 140 + 100*row), cell 80x100
```

(equivalently `LAWN_XMIN 40 + 460 = 500`, `LAWN_YMIN 80 + 60 = 140`).

### 2.3 Intro/cut-scene backdrop extras (optional polish, not needed for gameplay)

* `IMAGE_BACKGROUND1UNSODDED` drawn at the same (-460,-60).
* `IMAGE_SOD1ROW` (atlas cell; unpack 771x127, `invscale 0.8`, `AtlasResources_600x1000.cs:13178`) drawn
  horizontally trimmed from the left according to `mSodPosition`:
  `src = (0,0,width = animate(0..1000, mSodPosition, 0..IMAGE_SOD1ROW.GetWidth()), height)`,
  dest board-local `(-220+239, 265) = (19, 265)` (`Lawn\Board.cs:4996-4998`).
* `IMAGE_SOD3ROW` (unpack 771x355, `invscale 0.8`, `AtlasResources_600x1000.cs:13168`) trimmed the same
  way, dest `(-220+235, 149) = (15, 149)` (`Lawn\Board.cs:5004-5006`, `5010-5014`).
* Exact displayed size of those two atlas sprites is not 100% resolved because of the atlas
  `mInvScale = 0.8` sampling convention (see §9); they are intro-only.

Other backdrop offsets (for reference): night/pool/fog/roof/boss = (-192,-48) too
(`Lawn\Board.cs:4923-4946`); zen/mushroom/greenhouse/aquarium = (-133,0) etc. (`Lawn\Board.cs:4948-4984`).
`DrawHouseDoorBottom/Top` draw game-over overlays for `IMAGE_BACKGROUND1_GAMEOVER_INTERIOR_OVERLAY` at
`(-126,225)` / `IMAGE_BACKGROUND1_GAMEOVER_MASK` at `(-130,178)` when the zombies reach the house
(`Lawn\Board.cs:6943-7000`, `11784-11823`, constants at `Sexy\Constants.cs:901-910`).

---

## 3. Camera, cut-scene board movement (Day intro only)

* Normal play: camera identity, Board widget at `mX=100,mY=0` (§0.4). Board shake effects temporarily
  animate `mX/mY` around that origin (`Lawn\Board.cs:4664-4677`).
* During the level-intro cut-scene the **whole Board widget is moved horizontally** to pan over the wide
  background (`Lawn\CutScene.cs:569-616`): start `mX = BOARD_OFFSET = 220` or 100, pan right to
  `-BOARD_OFFSET + ImageWidth - WIDE_BOARD_WIDTH + Board_Cutscene_ExtraScroll = -220+1400-800-180 = 200`,
  pan left back to `mX = 100` (`Board_Offset_AspectRatio_Correction`). `ImageWidth = 1400`
  (`Sexy\Constants.cs:578`, `Board_Cutscene_ExtraScroll = -180` at `:895`). The background art is actually
  1880 wide, so the pan just shows a different slice; cut-scene math is only approximate.
* Optional for the port; not part of gameplay layout.

---

## 4. Seed bank (left vertical column) + sun counter + shovel

The seed bank is a **vertical column on the left edge** (screen x 0..81), sun counter to its upper right.
During normal play `mSeedBank.mX = 0` (it is slid in by `CutScene` before play: `Move(0,0)` while still in
LevelIntro, `Lawn\CutScene.cs:387-390`; `SeedBank.Move` subtracts 100 only while `GameScene==Playing`,
`Lawn\SeedBank.cs:276-280`). Its draw calls compensate the Board offset, so packet coordinates are
**screen coordinates** (`SeedBank.Draw`: `g.mTransX -= Board_Offset_AspectRatio_Correction`,
`Lawn\SeedBank.cs:57-71`; the same applies to the sun count, `Lawn\SeedBank.cs:216-235`).

### 4.1 Packet size and layout

* `SMALL_SEEDPACKET_WIDTH = 81`, `SMALL_SEEDPACKET_HEIGHT = 52` (`Sexy\Constants.cs:571-572`,
  overriding 101x65 from `:569-570`).
* Source art `Resources.IMAGE_SEEDPACKETS` (`Content\resources.xml`, path `images/seedpackets_hd_2x`,
  rows=13, cols=4, invscale=2). Measured texture **648x2756** ⇒ image 324x1378 logical ⇒
  **cel = 81 x 106 logical**. The cel is the plant portrait + card; the card itself is the lower ~52 px,
  the upper ~53 px is transparent/portrait overhang (measured from the extracted atlas: opaque rows begin
  ≈ y 44-55 of the logical cel, i.e. the card top is at the cel's vertical middle).
* Cel index for a seed: `col = (int)seedType % 4`, `row = (int)seedType / 4`
  (`g.DrawImageCel(image, x, y - celHeight/2, (int)seedType)`, `Lawn\SeedPacket.cs:343-352`;
  `Image.GetCelRect`, `Sexy\Image.cs:71-78`).
* `SeedPacket.mWidth/Height = 81/52` (`Lawn\SeedPacket.cs:30-47`).

Packet drawing (`Lawn\SeedPacket.cs:155-214`): the packet is drawn in its own frame (origin = `mX,mY`,
`GameObject.BeginDraw` adds `mX,mY`; `SeedPacket.mPosScaled=false` so no scaling) with

```
cel top-left = (packet.mX + 0, packet.mY + mOffsetY - 53)
=> card top-left = (packet.mX, packet.mY)         // card occupies mY .. mY+52
```

Cost tab: `IMAGE_SEEDPACKETS_GREEN_TAB/…_GRAY_TAB/…_PURPLE_TAB` (33x20 atlas,
`AtlasResources_600x1000.cs:13227`) drawn at packet-origin `(42, 26)`
(`SeedPacket_Cost = (42,26)`, `Sexy\Constants.cs:667`; draw at `Lawn\SeedPacket.cs:437-465`).
Cost text drawn right-justified at packet-origin `(74, 22)` with `FONT_PICO129`
(`SeedPacket_CostText_Pos = (74,22)`, `Sexy\Constants.cs:669`; `Lawn\SeedPacket.cs:472-504`).
Selection overlay `IMAGE_SELECTED_PACKET` (atlas 92x60, `AtlasResources_600x1000.cs:2542`) at
offset `(-5, -2)` from the packet origin: x = `SeedPacket_Selector_Pos.X = -5`, y = `mOffsetY - SeedPacket_Selector_Pos.Y = -2`
(`Sexy\Constants.cs:583` stores `(-5,2)`; `Lawn\SeedPacket.cs:237-251` subtracts both components, x is added as-is and y is negated).

### 4.2 Packet Y positions (`Board.GetSeedPacketPositionY`)

`Lawn\Board.cs:6875-6896` (normal bank — not conveyor belt, not 500p mode):

```
h = SMALL_SEEDPACKET_HEIGHT = 52
n = mSeedBank.mNumPackets                       // 6 by default; up to 10 with packet upgrade
if n <= 7: h += (int)InvertAndScale(8f)  = +15  → 67
elif n==8: h += (int)InvertAndScale(5f)  = +9   → 61
elif n==10:h += (int)InvertAndScale(-3f) = -5   → 47
// n == 9 falls through: h stays 52
h += 10                                         // normal bank
spacing = h
packet[i].mY (card top) = 20 + i * spacing
```

Resolved spacings and 6/10-packet positions (screen coordinates; packet x = **0**):

| packets n | spacing | card tops (y) |
|---|---|---|
| 6 (default) | 77 | 20, 97, 174, 251, 328, 405 |
| 7 | 77 | 20, 97, 174, 251, 328, 405, 482 |
| 8 | 71 | 20, 91, 162, 233, 304, 375, 446, 517 |
| 9 | 62 | 20, 82, 144, 206, 268, 330, 392, 454, 516 |
| 10 (fully upgraded) | 57 | 20, 77, 134, 191, 248, 305, 362, 419, 476, 533 |

`n = min(mPlayerInfo.mPurchases[21] + 6, 10)` for normal levels (`GetNumSeedsInBank`,
`Lawn\Board.cs:5351-5357`), so a fresh save has 6 packets (max card bottom = 405+52 = 457).
`InitLevel` sets each packet `mIndex=i, mY=GetSeedPacketPositionY(i), mX=0`
(`Lawn\Board.cs:1679-1686`). Refresh/gray logic not part of this spec.

Packet hit area: `SeedBank.MouseHitTest` accepts board-local x in
`[-99, -18]` (= screen x 1..82) and the packet whose `CenterY()`
(=`mY+26`) is closest within 104 px (`Lawn\SeedBank.cs:238-273`) — i.e. packets are clickable in screen
x 0..82, matching the drawn column.

### 4.3 Sun counter (top-left, right of the packet column)

`SeedBank.DrawSun` (`Lawn\SeedBank.cs:216-235`), called from `Board.DrawUIBottom` (z=100001):

* `num = UISunBankPositionX - Board_Offset_AspectRatio_Correction = 119 - 100 = 19` (board-relative, then
  +100 board translation ⇒ **screen x = 119**). `UISunBankPositionX = 119` (`Sexy\Constants.cs:888`).
* `IMAGE_DAN_SUNBANK` atlas sprite **143 x 44** (`AtlasResources_600x1000.cs:13203`).
  Drawn at **screen (119, 0)** (y comes from `mSeedBank.mX` in the decompiled code, which is 0 in play;
  `Lawn\SeedBank.cs:230-232`).
* Sun count text: font `FONT_CONTINUUMBOLD14OUTLINE`, black (red flashing when out of money), centered at
  `num + UISunBankTextOffset.X = 19+92` and `UISunBankTextOffset.Y = 3` ⇒ **screen (211, 3)**, center
  justified. `UISunBankTextOffset = (92,3)` (`Sexy\Constants.cs:889`).

### 4.4 Shovel button

* Rect: `(UIShovelButtonPosition.X - Board_Offset_AspectRatio_Correction, UIShovelButtonPosition.Y)`
  = (270-100, 3) = board-local (170,3) ⇒ **screen (270, 3)**, `UIShovelButtonPosition = (270,3)`
  (`Sexy\Constants.cs:890`; `Board.GetShovelButtonRect`, `Lawn\Board.cs:12314-12322`).
* `IMAGE_SHOVELBANK_ZEN` atlas 70x72 at that rect; `IMAGE_SHOVEL_PLANTGIRL` atlas 76x71 at
  `(rect.x - 7, rect.y - 3)` ⇒ screen (263, 0) (`Lawn\Board.cs:7094-7111`; atlas sizes
  `AtlasResources_600x1000.cs:17256`, `13204`). Drawn only when `HasShovel()` and scene is Playing
  (`IsCombatToolVisible`, `Lawn\Board.cs:7246-7264`).

---

## 5. HUD right side and bottom (screen coordinates)

All of these are drawn by `Board.DrawUIBottom` (render order z=100001) / `Board.DrawUITop` (z=700000)
inside the Board frame; the constants already contain the -100 compensation, so the resolved values below
are final **screen** coordinates.

| Element | Screen position / size | Citation |
|---|---|---|
| `IMAGE_FLAGMETER` frame | cell 237x40 at **(450, 3)** | `UIProgressMeterPosition=(450,3)` `Sexy\Constants.cs:891`; subtract Board offset in `DrawProgressMeter` `Lawn\Board.cs:6574-6577`; atlas 237x80 rows=2 → cel 237x40 `AtlasResources_600x1000.cs:13183` |
| progress-bar fill | `num2 = animate(0..150, mProgressMeterWidth, 0..225)`; dst `(350+237-num2-7, 3, num2, 40)` board-local ⇒ screen x `680-num2`..680 | `UIProgressMeterBarEnd=225` `Sexy\Constants.cs:893`; src `(237-num2-7,40,num2,40)` `Lawn\Board.cs:6581-6584` |
| progress "head" | `num6 = animate(0..150, mProgressMeterWidth, 0..220)`; cel 38x38 of `IMAGE_FLAGMETERPARTS` (114x38, cols=3) at board-local `(350+237-num6-20, 0)` ⇒ screen `(667-num6, 0)` | `UIProgressMeterHeadEnd=220` `Sexy\Constants.cs:892`; `Lawn\Board.cs:6645-6649`; atlas `AtlasResources_600x1000.cs:13213` |
| flag icons on the meter | for each flag k: `x = animate(0, mNumWaves, k*numWavesPerFlag, 350+237-10, 350+6)` board-local; cel(1,0) at `(x, y-4)`, cel(2,0) at `(x, y-3)`, 38x38 | `Lawn\Board.cs:6631-6644` |
| progress text | `FONT_DWARVENTODCRAFT12`, color (224,187,98) at `(num+celWidth/2, Board_ProgressBarText_Pos=1)` board-local ⇒ screen `(568, 1)`, center | `Board_ProgressBarText_Pos=1` `Sexy\Constants.cs:912`; `Lawn\Board.cs:6579,6593` |
| Menu button | **(800, 3)**, 100 x 45 (3-slice `IMAGE_BUTTON_LEFT`, 29x45) | `UIMenuButtonPosition = (750-100+50, 3) = (700,3)` board-local `Sexy\Constants.cs:886`; width 100 `:887`; `Lawn\Board.cs:855-856`; atlas 29x45 `AtlasResources_600x1000.cs:2519` |
| Accelerate button | **(755, 3)**, 45 x 45 | `Resize(UIMenuButtonPosition.X - 45, …, 45, …)` `Lawn\Board.cs:865` |
| Pause button | **(710, 3)**, 45 x 45 (when `HasPauseButton()`, true by default except whack-a-zombie) | `Lawn\Board.cs:867-879`, `7180-7199` |
| Pause icon | `IMAGE_ACCELERATION_PAUSE` (22x31) at button + (12,5) | `Lawn\Board.cs:10234-10241` |
| Speed indicator | pause / 01 / 02 / 03 icons (`IMAGE_ACCELERATION_*`) at button + (12,5)/(4,0) etc. | `Lawn\Board.cs:10178-10232` |
| Level banner | right-justified text, anchor **screen (891, 565)**, font `FONT_HOUSEOFTERROR16`, color (224,187,98, alpha) | `UILevelPosition=(991-100,565)=(891,565)` `Sexy\Constants.cs:885`; `DrawLevel` subtracts correction again ⇒ board-local 791 ⇒ screen 891, y 565, `Lawn\Board.cs:7083-7090` |
| Level banner timing | shown while `mLevelFadeCount>0`; set to 1000 on level start, decremented 1/tick ⇒ 10 s; alpha = clamp(255*count/15) | `Lawn\Board.cs:1937-1938`, `4682-4685`, `7089` |
| Coin bank (`IMAGE_COINBANK` 192x47) | **screen (138, 551)** | `UICoinBankPosition=(138-100, 599)` `Sexy\Constants.cs:894`; y `= 599 - 47 - 1 = 551` `Lawn\Board.cs:7610-7611`; atlas `AtlasResources_600x1000.cs:72` |
| Coin count text | `FONT_CONTINUUMBOLD14`, color (180,255,90), right-aligned at `x = 138 + StoreScreen_Coinbank_TextOffset.X(180) - textWidth`, `y = 551 + StoreScreen_Coinbank_TextOffset.Y(8)` | `Sexy\Constants.cs:712`; `Lawn\Board.cs:7628-7632` |
| Tooltip/advice messages (`MessageWidget`) | drawn in `DrawUITop` (z=700000) after packets | `Lawn\Board.cs:9254` |

Notes:
* The flag meter only draws when `HasProgressMeter()`: `mProgressMeterWidth != 0` and not
  continuous/Zen/Tree/ScaryPotter (`Lawn\Board.cs:11458-11461`). `mProgressMeterWidth` is 0 until
  `UpdateProgressMeter` moves it (`Lawn\Board.cs:9096-9163`).
* Menu/accelerate/pause/shovel/progress/sun are drawn at **z = 100001**, i.e. *below* lawn objects; the
  seed packets and level banner/advice are drawn at **z = 700000**, above everything except the screen
  fade (see §8). Replicate that: the top-right buttons can be covered by zombies/projectiles.
* Progress meter internals: `mProgressMeterWidth` is 0..150 and is animated:
  `num = 150 - (#flags)*12`, `num4/num5 = (wave-1)*num/(numWaves-1)` .. `wave*num/(numWaves-1)` plus
  `12*(wave/wavesPerFlag)` if the meter has flags, blended by wave progress/health progress; the value
  increments by 1 only on ticks where `mMainCounter %5/..` or `%20` are in a ±1 window
  (`Lawn\Board.cs:9124-9160`).
* `Sun`/`CoinBank` etc. draw the “stone button” 3-slice for buttons: `GameButton.DrawStoneButton`
  (`Lawn\GameButton.cs:367+`); the total button height is `IMAGE_BUTTON_LEFT.mHeight = 45`.

---

## 6. Lawn mowers

`Lawn\LawnMower.cs`, one per playable row, created by `Board.InitLawnMowers` (`Lawn\Board.cs:12650-12662`)
during the intro (`CutScene.PlaceLawnItems`, `Lawn\CutScene.cs:1570-1589`). Created invisible, rolled in by
the cut-scene, then stays at rest until a zombie touches it.

* Rest / ready position (after intro): `mPosX = -21`, `mPosY = GetPosYBasedOnRow(row) + 23 = 103 + 100*row`
  (board-local). Roll-in animation target `-21` (`Lawn\CutScene.cs:694`); initialization at
  `mPosX = -160 + BOARD_EXTRA_ROOM = -160`, `mPosY = 103 + 100*row` (`Lawn\LawnMower.cs:94-108`,
  `BOARD_EXTRA_ROOM = 0` at `Sexy\Constants.cs:558`).
  ⇒ **screen**: x = 79, y = 103 + 100*row (rows 0..4 → 103, 203, 303, 403, 503).
* Trigger "hit box": `GetLawnMowerAttackRect = (int)posX, (int)posY, 50, 80` (`Lawn\LawnMower.cs:374-377`);
  a zombie in the same row triggers when `GetRectOverlap(mowerRect, zombieRect) > 0`
  (`Lawn\LawnMower.cs:197-220`). With the rest position this means a zombie’s hit rect reaching
  board-local x ≤ 29 triggers it (screen x ≤ 129).
* When triggered: `mMowerState = Triggered`, speed **3.33 px/tick** (pool cleaner 2.5;
  `Lawn\LawnMower.cs:225-236`), moves right, re-animates, kills zombies it overlaps; dies when
  `mPosX > WIDE_BOARD_WIDTH = 800` (`Lawn\LawnMower.cs:249-252`). Only one per row (a replacement is
  spawned if bonus mowers remain, `Lawn\LawnMower.cs:359-371`).
* Drawing (`Lawn\LawnMower.cs:264-356`):
  * Ready state: cached image `ReanimatorCache.MakeCachedMowerFrame`, canvas **90 x 100**
    (`Lawn\ReanimatorCache.cs:499-543`), drawn with:
    ```
    g.translate(posX + 6, posY - altitude - 14)          // Lawn\LawnMower.cs:311-313
    DrawCachedMower(g, 0, 19)                            // Lawn\LawnMower.cs:353
    => image top-left (board-local) = (posX - 14, posY + 5)
    ```
    i.e. for the ready mower: sprite (90x100) top-left ≈ screen **(65, 108 + 100*row)**.
  * Shadow: `IMAGE_PLANTSHADOW` cel centered at `(posX - 7 + 2, posY - altitude + 47 - 2)`
    (`Lawn\LawnMower.cs:281-309`).
  * Triggered state: same translate but draws the Lawnmower reanim (anim layer `anim_normal`, scaled 0.85)
    instead of the cached image; the reanim was added at `(0, 18)` with the mower’s render order
    (`Lawn\LawnMower.cs:125-133`).
* Render order: `MakeRenderOrder(LawnMower=306000, row, 0)` = 306000 + 10000*row (`Lawn\LawnMower.cs:99`);
  but the render list subtracts 5000, so it is actually drawn at **301000 + 10000*row**, between
  gravestones (301000) and plants (302000) (`Lawn\Board.cs:1092-1101`).
* Mower mower-type on Day = `LawnMowerType.Lawn` (`ReanimationType.Lawnmower`).

---

## 7. Sun tokens (the falling sun currency)

Sun coins are `Coin` objects (`Lawn\Coin.cs`) with `CoinType.Sun`, spawned by `Board.UpdateSunSpawning`
(`Lawn\Board.cs:7442-7518`).

### 7.1 Spawn

```
x = LAWN_XMIN + RandomNumbers.NextNumber(Board_SunCoinRange)
  = 40 + rand[0,550)  = 40..589            // board-local; screen 140..689
y = 60                                    // board-local
Board.AddCoin(theX, 60, CoinType.Sun, CoinMotion.FromSky)
```

`Board_SunCoinRange = 550` (`Sexy\Constants.cs:896`). Countdown: first sun starts at
`rand(425..700)` ticks and after each sun
`mSunCountDown = min(950, 425 + 10*numSunsFallen) + rand(0..274)` (`Lawn\Board.cs:1669-1671`,
`7476-7490`). Only sky-sun levels spawn (night/roof/no-sun modes excluded, `Lawn\Board.cs:7453-7467`).

### 7.2 Size / fall / animation

* `CoinInitialize`: `mWidth = mHeight = (int)InvertAndScale(23f) = 43` (`Lawn\Coin.cs:82-83`);
  from-sky motion: `mVelY = 0.67`, `mVelX = 0`, `mGroundY = rand(0..249) + 300 = 300..549`
  (`Lawn\Coin.cs:317-323`).
* The sun visual is a `ReanimationType.Sun` reanim attached at
  `(mPosX + mWidth*IS*0.5, mPosY + mHeight*IS*0.5) = (posX+21.5, posY+21.5)`, loop, anim rate 6
  (`Lawn\Coin.cs:107-116`; attachment update `Lawn\Coin.cs:518-536`). So the sun sprite is **centered**
  on `(posX+21.5, posY+21.5)`; the 43x43 box is only the logic/click box.
* Falls until `posY >= mGroundY`, then rests (`mPosY = mGroundY`, x snapped to int); after landing it
  counts `mDisappearCounter`; after `GetDisappearTime() = 750` ticks it starts a 15-tick fade and dies
  (`Lawn\Coin.cs:1199-1327`, `1639-1655`, `492-509`). While falling it may bounce off x<0 or x>800-width
  (`Lawn\Coin.cs:1211-1220`).
* It is a `Coin` render item with render order `MakeRenderOrder(CoinBank=600000,0,1) = 600001`
  (`Lawn\Coin.cs:94`) ⇒ sun tokens are drawn **on top of plants/zombies**, only below the top UI.

### 7.3 Collection

* Click/hit box (`Lawn\Coin.cs:448-482`): for `Sun`/`Smallsun`, extra margin `num2 = 50`; a click at
  board-local `(x,y)` hits when
  `posX-50 <= x < posX + 43/BoardCameraScaleMultiplier + 50` and
  `posY-50 <= y < posY + 43/BoardCameraScaleMultiplier + 50` (BoardCameraScaleMultiplier = 1 on Day).
* On collect (`Lawn\Coin.cs:1439-1553`): `mIsBeingCollected=true`, then each tick moves 1/21 of the
  remaining distance toward the target; for sun the target is
  `Constants.Board_SunCoin_CollectTarget = (115 - Board_Offset_AspectRatio_Correction, 5) = (15, 5)`
  board-local ⇒ **screen (115, 5)** (`Sexy\Constants.cs:897`; `Lawn\Coin.cs:1442-1448`). The sun is
  credited (`AddSunMoney`) when the remaining distance < 8 px; scale shrinks to
  `clamp(distance*0.05, 0.5, 1)` (`Lawn\Coin.cs:1541-1552`, `1421-1422`).
* Values: `Sun = 25`, `Smallsun = 15`, `Largesun = 50`, `Tinysun = 5` (`Lawn\Coin.cs:1106-1125`);
  sun sprite scale multiplier 1 / 0.5 / 2 / 0.333 (`Lawn\Coin.cs:1584-1599`).
* Collecting is also possible when clicking anywhere on the sun; the visible sun is drawn by the
  reanim, not by the coin’s `Draw` (early-returns for sun types, `Lawn\Coin.cs:610-615`).

---

## 8. Zombies

### 8.1 Spawn position

`Zombie.ZombieInitialize` (`Lawn\Zombie.cs:299-306`):

```
mPosX = 780 + RandomNumbers.NextNumber(Zombie_StartRandom_Offset=40) + Zombie_StartOffset
      = 780..819  (+0)                        // board-local
if (board.IsFlagWave(mFromWave)) mPosX += 40  // Lawn\Zombie.cs:379-382
mPosY = GetPosYBasedOnRow(row) = GridToPixelY(0,row) = 80 + 100*row
mWidth = mHeight = 120
```

`Zombie_StartOffset = 0`, `Zombie_StartRandom_Offset = 40` (`Sexy\Constants.cs:815-816`).
So zombies spawn **near the right edge of the visible screen**: board-local 780..819 (or 820..859 on
flag waves) ⇒ **screen x 880..919 / 920..959**; they are not far off-screen. Special types override
`mPosX` (e.g. Flag exactly 800, Polevaulter 870..879, Zamboni 800..809, Bobsled 880) —
`Lawn\Zombie.cs:407,423,508,546`.

### 8.2 Row Y and draw offsets

* Zombie anchor = `mPosY` = row top (§1.1). `mX/mY` are the integer truncations, refreshed each tick
  (`Lawn\Zombie.cs:1746-1747`).
* Draw position (`GetDrawPos`, `Lawn\Zombie.cs:3060-3126` and `UpdateReanim`, `Lawn\Zombie.cs:6697-6784`):
  the zombie is drawn inside a graphics frame translated by `(mX, mY)`, then the body reanim’s overlay
  matrix translation is
  ```
  scale = mScaleZombie (=1 for normal)
  imageOffsetX = mPosX - mX + GetReanimationDrawOffset(type).x
  imageOffsetY = mPosY - mY + GetReanimationDrawOffset(type).y
  anOffsetX = imageOffsetX + 15
  anOffsetY = imageOffsetY + bodyY - 28 + 20
  reanimRoot(local) = ( anOffsetX + 30 - 30*scale, anOffsetY + 120 - 120*scale )
  ```
  For a normal zombie (scale 1, `GetReanimationDrawOffset(Normal) = (0,0)`,
  `Lawn\Zombie.cs:2150-2209`, `bodyY = -mAltitude = 0` on the Day lawn):
  ```
  reanimRoot(board-local) ≈ (mPosX + 15, mPosY - 8)
  ```
  (the exact code keeps the sub-pixel remainder `mPosX-mX`, i.e. `x = mPosX + 15 + frac`).
  `GetReanimationDrawOffset` values for other types: Pogo (0,16), Balloon (0,17), Dancer (0,15),
  Zamboni (68,-23), Football (0,-16), Catapult (-25,-18), Gargantuar (0,-8), etc.
  `GetRowHeightOffset` (added to `mPosY` in `GetPosYBasedOnRow`): Balloon/Propeller -30, Pogo -16,
  others 0 (`Lawn\Zombie.cs:2133-2147,2241-2256`).
* `bodyY = -mAltitude` (+`-HIGH_GROUND_HEIGHT` on high-ground cells); used when jumping/dropping
  (`Lawn\Zombie.cs:3127-3315`).
* Shadow: `IMAGE_PLANTSHADOW` (86x36 atlas cel) drawn **centered** at
  `(mPosX + 23, mPosY + bodyY + 92)` for a normal zombie (`Lawn\Zombie.cs:5988-6223`; the +23 is the
  “reanim exists, walking left” branch, +92 the final y offset). Shadow render order is
  `200000 + 10000*row + 3` (under plants) (`Lawn\Board.cs:1053-1062`).

### 8.3 Collision / attack numbers used by the sim

* Hit box `mZombieRect = (36, 0, 42, 115)` (`Lawn\Zombie.cs:345`), offset by `(mX, mY + bodyY)`
  (`GetZombieRect`, `Lawn\Zombie.cs:3799-3818`) ⇒ for a normal zombie standing on the lawn the rect is
  `(mPosX+36, mPosY, 42, 115)`.
* Attack box `mZombieAttackRect = (50, 0, 20, 115)` (`Lawn\Zombie.cs:346`, `GetZombieAttackRect`
  `Lawn\Zombie.cs:3822-3841`) ⇒ `(mPosX+50, mPosY, 20, 115)`.
* Zombie eats a plant when `GetRectOverlap(zombieAttackRect, plant.GetPlantRect()) >= 20`
  (`FindPlantTarget`, `Lawn\Zombie.cs:2814-2830`; overlap helper `Lawn\GameConstants.cs:328-356`).
  It bites every `TICKS_BETWEEN_EATS = 4` ticks (8 when chilled), removing 4 plant HP per bite
  (`Lawn\Zombie.cs:1236-1244`, `1342-1343`; `TICKS_BETWEEN_EATS = 4` `Lawn\GameConstants.cs:1178`).
  Default plant HP is 300 (`Lawn\Plant.cs:239`; per-type health from `Plant.GetBaseHealth`, e.g. Wallnut
  8000, `Lawn\Plant.cs:2762+`), i.e. ~300 ticks (3 s) to eat an unprotected 300-HP plant.
* Walking speed `mVelX` (`PickRandomSpeed`, `Lawn\Zombie.cs:2473-2530`): normal zombies
  `RandRangeFloat(0.23, 0.37)` px/tick; chilled = ×`CHILLED_SPEED_FACTOR 0.4`
  (`Lawn\GameConstants.cs:1157`); special types 0.45 (Flag/Dancer/Pogo), 0.66-0.68 (Football,
  Polevaulter, Snorkel, JitB), 0.79-0.81 (Ladder), 0.89-0.91 (Newspaper-mad/Dolphin). The zombie moves
  **every tick** while it has a reanim (`UpdateZombieWalking`, `Lawn\Zombie.cs:3844-3949`):
  `mPosX -= mVelX` (normal walking direction; + for backwards walkers). Defender collision uses
  `mWidth=120` for mirroring backwards walkers.
* Zombie render order: `MakeRenderOrder(RenderLayer.Zombie=303000, row, 4)` = `303000 + 10000*row + 4`
  (`SetRow`, `Lawn\Zombie.cs:2125-2129`). Same-row zombies tie on z; `RenderItem` then sorts by list
  id (creation order) (`Lawn\RenderItem.cs:79-109`). Row lists are sorted by x for other logic
  (`SortZombieRowLists`, `Lawn\Board.cs:8285-8293`, `Zombie.CompareTo` `Lawn\Zombie.cs:290-296`).

---

## 9. Plants

* Anchor = cell top-left: `mX = 40+80*col`, `mY = 80+100*row`; `mWidth = mHeight = 80`
  (`Lawn\Plant.cs:217-227,262-263`).
* Body reanim position: added at `(0, PlantDrawHeightOffset(...))` with render order `mRenderOrder+1`
  (`Lawn\Plant.cs:292-293`) and then each update
  `reanimation.SetPosition((mShakeOffsetX)*S, (mShakeOffsetY + PlantDrawHeightOffset(...))*S)`
  (`Lawn\Plant.cs:8014-8162`). Because the reanim is drawn inside the plant’s `(mX,mY)` frame:
  ```
  plantReanimRoot(board-local) = (mX + shakeOffsetX, mY + heightOffset + shakeOffsetY)
  ```
  `PlantDrawHeightOffset` (`Lawn\Plant.cs:8583-8713`) is 0 for Peashooter, Sunflower, Snowpea,
  Repeater, Wallnut, etc.; +26 Flowerpot, +25 Lilypad, +10 Starfruit, +24 Tanglekelp, +28 Seashroom,
  -20 InstantCoffee, -30 flying plants, +5 Puffshroom, +8 Gravebuster, +15 Spikeweed/Spikerock on
  grass (and +6 on the bottom row), +15 Endoflame, etc.
* Collision hit box `GetPlantRect` (`Lawn\Plant.cs:3486-3506`): default `(mX+10, mY, 60, 80)`;
  Tallnut `(mX+10, mY, 80, 80)`; Pumpkin `(mX, mY, 60, 80)`; Cobcannon `(mX, mY, 140, 80)`.
* Plant shadow: `IMAGE_PLANTSHADOW` cel centered at `(mX - 3, mY + heightOffset + 51)` scale 1 (Day)
  (`Lawn\Plant.cs:5584-5773`, draw call `Lawn\Plant.cs:5770-5772`).
* Draw-order / z: `Plant.CalcRenderOrder` (`Lawn\Plant.cs:5085-5128`):
  ```
  layer = RenderLayer.Plant (302000)                       // WallnutBowling level uses Projectile layer
  order = PlantOrder.Normal(1) (Pumpkin=2, Flyer=3, Lilypad=0)
  extra = 0 (Cobcannon), 550 (Gravebuster), 200 (Pumpkin)
  mRenderOrder = 302000 + 10000*row + (order*5 - mX + extra)
  ```
  `PlantOrder` values: Lilypad 0, Normal 1, Pumpkin 2, Flyer 3 (`Lawn\PlantOrder.cs`).
  Because `-mX` shrinks with column, **left plants in a row draw on top of right plants**; a pumpkin
  shell draws above the plant inside it.
* Pre-rendered sprite convention (used by almanac/cursor preview, `ReanimatorCache`):
  `GetPlantImageSize` gives per-plant canvas rect starting from default `(-20,-20,120,120)`
  (`Lawn\ReanimatorCache.cs:159-227`; Gravebuster/Squash expand to (-200,-215,300,315), Tallnut grows
  vertically, etc.) and `MakeCachedPlantFrame` renders the reanim with its root at `-drawRect.mX,
  -drawRect.mY` in the 2x canvas (`Lawn\ReanimatorCache.cs:322-430`), i.e. in the cached image the
  **reanim root sits at `(-rect.x, -rect.y)`** (default (20,20)) and the sprite is drawn at
  `(root - (20,20))`. `Plant.DrawSeedType` applies exactly that: image drawn at
  `(posX-40, posY-64)` for a call with pos (40, height+64) (`Lawn\Plant.cs:4165-4203`).

---

## 10. Projectiles (peas etc.)

Only the layout-relevant facts; behaviour lives in `Lawn\Projectile.cs`.

* Render order `MakeRenderOrder(Projectile=305000, row, 0)` = 305000 + 10000*row
  (`Lawn\Projectile.cs:395-402`); projectile shadow is a separate render item at
  `305000 + 10000*row + 3` when low-framerate effects are on (`Lawn\Board.cs:1078-1090`).
* Peashooter spawn point (for art alignment): the projectile is created at the plant’s muzzle using
  plant/reanim data, not a constant; its z is above zombies (`Projectile` layer 305000 > Zombie 303000).

---

## 11. Global draw order (Board render list)

`Board.DrawGameObjects` builds one render list, sorts by `mZPos` then insertion id, and draws
(`Lawn\Board.cs:995-1425`). `MakeRenderOrder(layer,row,offset) = layer + offset + 10000*row`
(`Lawn\Board.cs:10020-10023`). `RenderLayer` values (`Lawn\RenderLayer.cs`):

| z | layer | what |
|---|---|---|
| 100000 | `UiBottom` (special) | **backdrop** (special-cased, drawn in the first pass together with ice/gravestone items) |
| thePosZ = 100001 (Playing) | BottomUi | **sun count + shovel + progress meter + top-right buttons** (`DrawUIBottom`, `Lawn\Board.cs:9172-9198`, pos chosen at `1175-1176`) |
| 200000+10000*row | Ground | zombie shadows (200000+row*10000+3), craters etc. |
| 301000+10000*row | GraveStone | gravestones; **mowers** (mower order 306000+… then -5000 ⇒ 301000+…) |
| 302000+10000*row | Plant | plants (sorted inside the row by `-mX`, see §9) |
| 303000+10000*row | Zombie | zombies (303000+…+4); boss parts 304000 |
| 305000+10000*row | Projectile | peas and other projectiles (+3 for their shadows) |
| 306000+10000*row | LawnMower | (see mower note: listed as 301000 after -5000) |
| 307000+10000*row | Particle | TodParticleSystems (explosions, dust…) |
| 308000+10000*row | CoverLayer | roof/cover layers (none on Day) |
| 500000 | Fog | fog overlay (night) |
| 600000 | CoinBank | coin bank HUD; **coins/suns are 600001** (drawn above all lawn objects) |
| 700000 | UiTop | **seed packets**, level banner, Crazy Dave, advice text (`DrawUITop`, `Lawn\Board.cs:9201-9255`) |
| 800000 | AboveUI | time-stop tint; award/other overlays |
| 900000 | ScreenFade | white/black level fade (`DrawFadeOut`, `Lawn\Board.cs:7816-7837`) |
| — | CursorPreview | uses `mCursorPreview.mRenderOrder`; the cursor object/ghost plant is drawn around/above the lawn (see `DrawCursorOnBackground`/`DrawCursorOverlay`, `Lawn\Board.cs:5049-5067`) |

Additional notes:
* Two-pass draw: the first pass (sorted) only handles `RenderObjectType.Backdrop` (draw backdrop +
  cursor-on-background), `Ice` and `GridItem == Gravestone`; the second pass draws every other render
  item in z order (`Lawn\Board.cs:1206-1232` and `1233-1424`). Consequence: ice/gravestones are drawn
  right after the backdrop even though their z would sort later; on a Day lawn there are no gravestones
  or ice, so pass 2 is the whole order.
* Backdrop is z=100000 and BottomUi z=100001; both are drawn before the lawn objects; UiTop (700000) is
  last before the screen fade.
* At level intro / non-playing scenes `thePosZ` for BottomUi becomes 800000
  (`Lawn\Board.cs:1162-1174`), i.e. bottom UI on top of everything while the seed chooser slides.
* `GlobalStaticVars.gLowFramerate` disables shadows (`Lawn\Board.cs:1053,1081`).

---

## 12. Day-lawn gameplay numbers useful for a faithful port

| Item | Value | Citation |
|---|---|---|
| Waves per Day level (adventure 1-10) | 4, 6, 8, 10, 8, 10, 20, 10, 20, 20 | `gZombieWaves` `Lawn\GameConstants.cs:787-794`; picked at `Lawn\Board.cs:8406-8409` |
| First wave countdown | 1800 ticks (18 s); level 2 first-time = 5000 | `Lawn\Board.cs:9921-9933` |
| Next-wave countdown after a wave | flag wave 4500 ticks; normal 2500 + rand[0,600) | `Lawn\Board.cs:7405-7429` |
| "Rush" shortcut | if wave health ≤ next-wave threshold and elapsed > 400 → countdown = 200 | `Lawn\Board.cs:7385-7389` |
| Flag wave | when countdown hits 5 → `mHugeWaveCountDown = 750` ("huge wave" banner), then countdown=1 → next wave | `Lawn\Board.cs:7277-7356,7390-7400` |
| Waves per flag | `numWaves` if first-time adventure and `numWaves < 10`, else 10 | `Lawn\Board.cs:12977-12988` |
| Flag wave definition | `wave % numWavesPerFlag == numWavesPerFlag-1`; never on first-time level 1 | `Lawn\Board.cs:11773-11781` |
| Level 1 tutorial overrides | first zombie delayed to countdown 99 after "zombie onslaught" advice; sun countdown 400 | `Lawn\Board.cs:11154-11161`, `1937-1938` |
| Progress meter width | 0..150, flags cost 12 each; wave interpolation + health interpolation | `Lawn\Board.cs:9096-9163` |
| Final-wave bookkeeping | on spawning the last wave: `mRiseFromGraveCounter = 210`; on flag waves `mFlagRaiseCounter = 100`; final-wave sound/reanim banners | `Lawn\Board.cs:2661-2672`, `11002-11042` |
| Starting sun | level1 first-time 150; otherwise 50 | `Lawn\Board.cs:1632-1651` |
| Plant default HP | 300 (per-type via `Plant.GetBaseHealth`; Wallnut 8000) | `Lawn\Plant.cs:239`, `Lawn\Plant.cs:2762+` |
| Zombie default body HP | 270 | `Lawn\Zombie.cs:384` (special types override) |
| Zombie eat cycle | 4 ticks / 4 HP (×2 chilled) | `Lawn\GameConstants.cs:1178`, `Lawn\Zombie.cs:1236-1244,1342` |
| Sun value | 25 | `Lawn\Coin.cs:1106-1111` |

> Tick conversions: 1 tick = 10 ms (`Sexy\Main.cs:39`). "750" = 7.5 s, "1800" = 18 s, etc.

---

## 13. Unresolved / careful items

1. **Background native size** is not in code (code draws 1:1). Measured from the shipped XNB:
   `background1_hd = 1880x720`, `background1unsodded_hd = 1880x720`. If the port re-extracts art with a
   different pipeline, scale it to 1880x720 at the documented offset to preserve the lawn mapping.
2. **Atlas `mInvScale = 0.8` sprites** (`IMAGE_SOD1ROW`, `IMAGE_SOD3ROW`, many selector images):
   `UNPACK_INFO` sizes are logical sizes (`Image` created with `(x,y,w,h)`,
   `AtlasResources_600x1000.cs:116-119`) and are drawn at that size; only intro cut-scene art is affected
   on the Day lawn, so this is a low-risk unresolved area.
3. **Reanim (TOD) sprites**: plant/zombie/sun art is `Reaktion` animation data; this spec gives the
   **root/hotspot transform** of every reanim (`plant`: `(mX, mY+heightOffset)`; `zombie`:
   `(mPosX+15, mPosY-8)` with sub-pixel remainder; `sun`: centered at `(posX+21.5,posY+21.5)`), not the
   per-track artwork. When the port converts reanims to sprite sheets, the hotspot must be the reanim
   root used above.
4. **Seed packet card sub-rect**: `IMAGE_SEEDPACKETS` cel is 81x106 logical (measured 648x2756, 4x13,
   invscale 2); card top is the cel's vertical middle (`y=53` of the cel). The exact opaque bounding box
   varies per plant portrait (measured first opaque row ≈ 83-110 px of the 212 px HD cel).
5. **Last-column cell highlight** uses x=878 instead of 760 (`Lawn\Board.cs:7964-7976`) — legacy quirk,
   only affects hover highlight drawing.
6. **Seed bank `mX` during play**: the code slides it in during the intro (`CutScene` calls
   `Move(0,0)` while the scene is still LevelIntro so `mX=0`), and the draw compensates the Board offset
   (`Lawn\SeedBank.cs:57-71`); the resolved screen positions in §4 are what the shipped code produces.
   `SeedBank.Move`’s `-100` branch (`Lawn\SeedBank.cs:276-280`) would apply if `Move` were called while
   `GameScene==Playing` (it is not, in the normal flow).
7. **Coin bank x**: constants are `UICoinBankPosition = (138-100, 599)`; drawing uses
   `(UICoinBankPosition.X, UICoinBankPosition.Y - IMAGE_COINBANK.mHeight - 1)` inside the board frame ⇒
   screen (138, 551) as listed; if the port draws in screen space, use the screen values in
   `layout.json`.
8. **Sun counter y**: `DrawSun` uses the decompiled variable `aX = this.mX` as the y coordinate
   (`Lawn\SeedBank.cs:230-233`), which is 0 in play. If the cut-scene seed bank slide is implemented,
   that y follows `mSeedBank.mX` (a decompiler artifact/bug); during normal play it is 0.

---

## 14. Quick “where to draw” cheat sheet (screen/logical px, 1000x600)

```
background1: draw at (-360,-60), native 1880x720 (no scaling)
grid:        cell (col,row) = (140+80*col, 80+100*row), 80x100, 9 cols x 5 playable rows
             (zombies/plants row Y = 80+100*row; plant cell art anchor = cell top-left)
mowers:      ready at screen (79, 103+100*row); hit box 50x80 from there; sprite 90x100 at (65,108+100row)
zombies:     spawn screen x 880..919 (+40 flag wave), row y 80+100*row; reanim root (mPosX+15, mPosY-8);
             hit box (mPosX+36,mPosY,42,115); shadow center (mPosX+23,mPosY+92)
suns:        spawn from (140..689, 60), fall at 0.67px/tick to y=300..549, 43x43 hit box (+50 margin),
             collect target screen (115,5)
seed bank:   packet cards x=0..81, card tops 20+77*i for 6 packets (77/71/62/57 spacing for 7/8/9/10);
             cel 81x106 drawn at (0, cardTop-53); selected overlay at (-5, cardTop-2)
sun counter: image (119,0) 143x44; count text centered at (211,3)
shovel:      bank (270,3) 70x72; icon (263,0) 76x71
progress:    flag meter (450,3) 237x40; fill from x=680-num2 width num2 (num2∈[0,225]);
             head 38x38 at (667-num6,0); flags 38x38 along meter
buttons:     pause (710,3) 45x45; accelerate (755,3) 45x45; menu (800,3) 100x45
coin bank:   (138,551) 192x47
level text:  right-justified at (891,565), visible 10 s after start
```
