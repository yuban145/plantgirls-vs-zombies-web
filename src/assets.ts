/** Asset store: manifest, textures, reanim docs, data tables, strings, fonts. */
import { loadSpineAsset, type SpineAsset } from './spine';

export interface SpriteRect {
  a: string;
  x: number;
  y: number;
  w: number;
  h: number;
  rows: number;
  cols: number;
  invScale: number;
}

export interface ImageInfo {
  tex: string;
  w: number;
  h: number;
  invScale: number;
  rows: number;
  cols: number;
  logicalW: number;
  logicalH: number;
}

/** A drawable sprite slice: source pixels + logical destination size. */
export interface SpriteView {
  img: CanvasImageSource;
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  /** Logical size in game pixels (destination). */
  dw: number;
  dh: number;
}

export interface ReanimTransform {
  img?: string;
  alpha?: number;
  frame?: number;
  sx?: number;
  sy?: number;
  kx?: number;
  ky?: number;
  tx?: number;
  ty?: number;
}

export interface ReanimTrack {
  name: string;
  frameStart: number;
  frameCount: number;
  transforms: ReanimTransform[];
}

export interface ReanimDoc {
  name: string;
  fps: number;
  trackCount: number;
  globalFrameCount: number;
  /** Whether the original runtime interpolates between frames (default true). */
  interpolate?: boolean;
  tracks: ReanimTrack[];
}

export interface LevelWave {
  index: number;
  flag: boolean;
  zombies: string[];
}

export interface LevelSpecial {
  prePlantedPlants?: Array<{ gridX: number; gridY: number; seedType: string }>;
  [key: string]: unknown;
}

export interface LevelSeedBank {
  kind: string;
  packets: string[] | null;
  numPackets: number;
  chooserOffers?: string[];
  initialCards?: string[];
  cardPool?: Array<{ seed: string; weight: number }>;
  firstCardCountDownTicks?: number;
  replenishCountDownTicks?: Record<string, number>;
}

export interface LevelDef {
  level: number;
  stage: string;
  startingSun: number;
  numWaves: number;
  flagWaves: number[];
  wavesPerFlag: number;
  background: { imageResource: string };
  seedBank: LevelSeedBank;
  special: LevelSpecial | null;
  zombieSpawning: {
    initialWaveCountDownTicks: number;
    flagWaveCountDownTicks?: number | null;
    healthToNextWaveFractionRange?: [number, number];
    healthShortcut?: { minWaveAgeTicks: number; minCountDownTicks: number };
    hugeWaveCountDownTicks?: number;
  };
  waves: LevelWave[];
}

export interface PlantDef {
  seedType: string;
  displayNameKey: string;
  sunCost: number;
  refreshTicks: number;
  health: number;
  launchRateTicks: number;
  attack: null | {
    projectileType: string;
    projectileDamage: number;
    projectileSpeedPxPerTick: number;
    shotsPerAttackCycle: number;
    fireAnimationTicks: number;
    nextShotCountDownTicksRange: [number, number];
    firstShotCountDownTicksRange: [number, number];
    secondShotTriggerCounter?: number;
    chill?: { speedFactor: number; durationTicks: number };
  };
  production: null | {
    sunValue: number;
    firstSunCountDownTicksRange: [number, number];
    subsequentSunCountDownTicksRange: [number, number];
  };
  special: null | {
    kind: string;
    fuseTicks?: number;
    armTicks?: number;
    damage?: number;
    radius?: number;
    rowRange?: number;
    instaKill?: boolean;
    biteWindupTicks?: number;
    digestTicks?: number;
    attackRectOffsetX?: number;
  };
  reanimation: {
    type: string;
    resourcePath?: string;
    isSpine: boolean;
    legacyResourcePath: string | null;
  };
}

export interface ZombieDef {
  zombieType: string;
  bodyHealth: number;
  helmHealth: number;
  speed: { kind: string; minPxPerTick?: number; maxPxPerTick?: number; pxPerTick?: number; chilledFactor: number };
  eating: { damagePerBite: number; biteIntervalTicks: number; chilledBiteIntervalTicks: number };
  special?: { vault?: { triggersWhenPlantAhead: boolean; tallnutBlocks: boolean } } | null;
  reanimation: { type: string; resourcePath: string };
  rects: { zombieRect: [number, number, number, number]; attackRect: [number, number, number, number] };
}

export interface SpriteManifest {
  atlases: Record<string, { tex: string; w: number; h: number }>;
  sprites: Record<string, SpriteRect>;
  images: Record<string, ImageInfo>;
}

const DATA = 'data/';

export class Assets {
  manifest!: SpriteManifest;
  levels: LevelDef[] = [];
  plants = new Map<string, PlantDef>();
  zombies = new Map<string, ZombieDef>();
  strings: Record<string, string> = {};
  seedTypes: string[] = [];
  tex = new Map<string, HTMLImageElement>();
  reanimDocs = new Map<string, ReanimDoc>();
  private reanimPending = new Map<string, Promise<ReanimDoc | null>>();

  async load(onProgress: (fraction: number, label: string) => void): Promise<void> {
    onProgress(0.02, '读取清单');
    const [manifest, levels, plants, zombies, strings, seedTypes] = await Promise.all([
      fetchJson<SpriteManifest>('sprites.json'),
      fetchJson<{ levels: LevelDef[] }>('levels.json'),
      fetchJson<{ plants: PlantDef[] }>('plants.json'),
      fetchJson<{ zombies: ZombieDef[] }>('zombies.json'),
      fetchJson<Record<string, string>>('strings_zh.json'),
      fetchJson<string[]>('seedtypes.json'),
    ]);
    this.manifest = manifest;
    this.levels = levels.levels;
    for (const p of plants.plants) this.plants.set(p.seedType, p);
    for (const z of zombies.zombies) this.zombies.set(z.zombieType, z);
    this.strings = strings;
    this.seedTypes = seedTypes;

    const textures = new Set<string>();
    for (const a of Object.values(manifest.atlases)) textures.add(a.tex);
    for (const i of Object.values(manifest.images)) textures.add(i.tex);
    const texList = [...textures];
    onProgress(0.2, '加载贴图');
    await Promise.all(
      texList.map(async (name, i) => {
        const img = new Image();
        img.src = `${DATA}tex/${name}.webp`;
        await img.decode().catch(() => undefined);
        this.tex.set(name, img);
        onProgress(0.2 + (0.6 * (i + 1)) / texList.length, `加载贴图 ${i + 1}/${texList.length}`);
      }),
    );

    onProgress(0.85, '加载字体');
    await Promise.all([
      loadFont('LXGWWenKai', 'data/fonts/LXGWWenKai-Bold.ttf'),
      loadFont('SourceHan', 'data/fonts/SourceHanSansSC-Heavy.otf'),
      loadFont('Tiejili', 'data/fonts/TiejiliSC-Regular.ttf'),
    ]).catch(() => undefined);
    onProgress(1, '完成');
  }

  texture(tex: string): HTMLImageElement | null {
    return this.tex.get(tex) ?? null;
  }

  /**
   * Resolve an atlas sprite id to a drawable slice.
   *
   * The original packs atlas cells and then applies `mInvScale` when sampling
   * (Sexy/PrimitiveBatch.cs:109-117):
   *     uv = (srcCelOffset + atlasOffset / inv) * inv / textureSize
   * i.e. the sampled *texture* span is `inv * logicalCelSize`, starting at the
   * packed rect origin (plus `inv * celOffset` for multi-column strips), while
   * the destination size stays the logical cel size.  Sampling the full rect
   * (as a naive port does) bleeds neighbouring sprites into the image - that is
   * what produced the "extra wheels"/shredded limbs/sun debris artifacts.
   */
  view(id: string, cel = 0): SpriteView | null {
    const rect = this.manifest.sprites[id];
    if (!rect) return null;
    const atlas = this.manifest.atlases[rect.a];
    const img = this.texture(atlas.tex);
    if (!img) return null;
    const cols = Math.max(1, rect.cols);
    const rows = Math.max(1, rect.rows);
    const dw = rect.w / cols;
    const dh = rect.h / rows;
    const inv = rect.invScale || 1;
    const col = ((cel % cols) + cols) % cols;
    const row = Math.floor(cel / cols) % rows;
    return {
      img,
      sx: rect.x + inv * col * dw,
      sy: rect.y + inv * row * dh,
      sw: inv * dw,
      sh: inv * dh,
      dw,
      dh,
    };
  }

  /** Standalone image resource (resources.xml `invscale`): source is full texture cel. */
  imageView(id: string, cel = 0): SpriteView | null {
    const info = this.manifest.images[id];
    if (!info) return null;
    const img = this.texture(info.tex);
    if (!img) return null;
    const cols = Math.max(1, info.cols);
    const rows = Math.max(1, info.rows);
    const texCelW = info.w / cols;
    const texCelH = info.h / rows;
    const col = ((cel % cols) + cols) % cols;
    const row = Math.floor(cel / cols) % rows;
    return {
      img,
      sx: col * texCelW,
      sy: row * texCelH,
      sw: texCelW,
      sh: texCelH,
      dw: texCelW / (info.invScale || 1),
      dh: texCelH / (info.invScale || 1),
    };
  }

  private filterCache = new Map<string, SpriteView>();

  /**
   * CSS-filtered sprite. Produces a pre-rendered logical-size canvas.
   */
  filteredView(id: string, filter: string, cel = 0): SpriteView | null {
    const key = `${id}|${filter}|${cel}`;
    const cached = this.filterCache.get(key);
    if (cached) return cached;
    const view = this.view(id, cel);
    if (!view) return null;
    const w = Math.max(1, Math.ceil(view.dw));
    const h = Math.max(1, Math.ceil(view.dh));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const c = canvas.getContext('2d')!;
    c.filter = filter;
    c.drawImage(view.img, view.sx, view.sy, view.sw, view.sh, 0, 0, w, h);
    c.filter = 'none';
    const out: SpriteView = { img: canvas, sx: 0, sy: 0, sw: w, sh: h, dw: w, dh: h };
    this.filterCache.set(key, out);
    return out;
  }

  spriteSize(id: string): { w: number; h: number } | null {
    const rect = this.manifest.sprites[id];
    if (!rect) return null;
    return { w: rect.w / Math.max(1, rect.cols), h: rect.h / Math.max(1, rect.rows) };
  }

  image(id: string): { img: HTMLImageElement; info: ImageInfo } | null {
    const info = this.manifest.images[id];
    if (!info) return null;
    const img = this.texture(info.tex);
    return img ? { img, info } : null;
  }

  async reanim(name: string): Promise<ReanimDoc | null> {
    const cached = this.reanimDocs.get(name);
    if (cached) return cached;
    let pending = this.reanimPending.get(name);
    if (!pending) {
      pending = fetchJson<ReanimDoc>(`reanim/${name}.json`)
        .then((doc) => {
          this.reanimDocs.set(name, doc);
          return doc;
        })
        .catch(() => null);
      this.reanimPending.set(name, pending);
    }
    return pending;
  }

  reanimSync(name: string): ReanimDoc | null {
    return this.reanimDocs.get(name) ?? null;
  }

  /** Load every reanim needed by a level before it starts. */
  async preload(reanimNames: string[], onProgress?: (f: number) => void): Promise<void> {
    const unique = [...new Set(reanimNames)];
    let done = 0;
    await Promise.all(
      unique.map(async (n) => {
        await this.reanim(n);
        done += 1;
        onProgress?.(done / unique.length);
      }),
    );
  }

  private spineCache = new Map<string, SpineAsset | null>();

  async preloadSpine(name: string): Promise<boolean> {
    if (this.spineCache.has(name)) return this.spineCache.get(name) !== null;
    const asset = await loadSpineAsset(name);
    this.spineCache.set(name, asset);
    return asset !== null;
  }

  spine(name: string): SpineAsset | null {
    return this.spineCache.get(name) ?? null;
  }

  string(key: string, fallback = ''): string {
    return this.strings[key] ?? fallback;
  }
}

async function fetchJson<T>(path: string): Promise<T> {
  const res = await fetch(DATA + path);
  if (!res.ok) throw new Error(`fetch ${path} failed: ${res.status}`);
  return (await res.json()) as T;
}

async function loadFont(family: string, path: string): Promise<void> {
  const face = new FontFace(family, `url(${path})`);
  await face.load();
  (document.fonts as FontFaceSet).add(face);
}
