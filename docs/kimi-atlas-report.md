# Atlas / Resource Manifest Extraction Report

Worker: atlas + resource manifest extractor (independent of XNB texture decoding).

## Inputs parsed (read-only)

| Input | Content |
|---|---|
| `PlantGirlsVsZombies/Content/resources.xml` | 696 `<Image>`, 178 `<Sound>`, 9 `<Font>` (no `Reanim`/`Music`/other tags exist; 537 `Resources` groups) |
| `decompiled/Lawn/Sexy/AtlasResources_600x1000.cs` | 89 `Unpack<Name>AtlasImages()` methods, 5,150 single-line `UNPACK_INFO(...)` entries (12-arg form; last arg `new float?(x)` or `null` → invScale 1.0) |
| `decompiled/Lawn/Sexy/AtlasResources.cs` | 5,150 `AtlasStringTable("IMAGE_X", n)` id→numeric-id entries |

## Outputs

- `plangirls-web/data/atlas.json` (2.6 MB) — `atlases[]` (name, resolved `resourceId`/`path`, full sprite list incl. animType/delays), `imageIndex` (id → atlas+rect), `stringIdTable`.
- `plangirls-web/data/resources.json` (394 KB) — `images`/`sounds`/`fonts`/`reanims`/`music` dicts keyed by id; every entry keeps `path`, its `Resources` group id, and **all raw XML attributes** in `attrs`.
- `plangirls-web/tools/atlas_manifest.py` — stdlib-only generator (re-run any time).

## Verification numbers (script run end-to-end)

- **89 atlases**, **5,150 sprite entries**, 5,150 imageIndex entries, **0 collisions**, **0 unresolved atlas resource ids** (resolution: `IMAGE_`+upper, then path-basename match, then underscore-insensitive fuzzy).
- `IMAGE_TOMBSTONES` → atlas `Loc_en` (1,1,431,370, rows 4, cols 5, invScale 0.8) ✓
- `SeedAtlas` atlas → `IMAGE_SEEDATLAS` / `images/SeedAtlas`, 62 sprites (seed-packet slices, first: `IMAGE_SOD3ROW`) ✓; `IMAGE_SEEDATLAS` present in resources.xml ✓
- `IMAGE_REANIM_AGAVE_PARTICLE_ATK2_2_33` → atlas `Agave12` (805,1,263,96) ✓
- ⚠ `IMAGE_REANIM_AGAVE_IDLE_000` **does not exist** in this PlantGirls mod build — no `AGAVE_IDLE*` id appears in either decompiled file; the mod names Agave frames `IMAGE_REANIM_AGAVE_PARTICLE_ATK2_*` / `ENDOFLAME_*`. Reported, not an extractor bug.
- Both JSON files reload with `json.load`: OK.

## Top 10 atlases by sprite count

PlantsZombies 1228 · SunFlower 418 · ZombiesExtra 184 · CharredZombies 137 · Agave13 132 · Zengarden 121 · Kernalplut 91 · Loc_en 90 · Kernalplut2 90 · Garlic2 85.

## Rect-fit sanity check

313 of 5,150 rects exceed the declared `atlasWidth/atlasHeight` by 1–65 px (e.g. `Loc_en` selector-screen buttons x+w≈2064 > 2048; several Agave particle frames y+h≈2049–2109 > 2048). Reported only, run not failed — consistent with the 1 px `atlasExtrude` padding and slightly stale dims in resources.xml; consumers should clamp to actual texture size.

## Commands run

```
python D:\逆向\plangirls-web\tools\atlas_manifest.py   # dsh-primary-runtime python3, stdlib only
```

## Limitations

- Only the `600x1000` atlas class is parsed (other resolution variants, if any, are not).
- The `array[i].mpImage` re-assignment loop is intentionally ignored; the UNPACK_INFO first arg is authoritative.
- `stringIdTable` is id→numeric only (no reverse map emitted; invert client-side if needed).
- Duplicate XML ids: none found; script keeps first occurrence and would report dupes.
