/**
 * Reanim playback + Canvas2D rendering.
 * Implements docs/spec-reanim.md: top-left local transforms, track order = draw order,
 * 100 Hz fixed-step animation time, loop types, per-frame interpolation,
 * cel column selection by `frame`, and render-group hiding.
 */
import type { Assets, ReanimDoc, ReanimTrack, ReanimTransform, SpriteView } from './assets';

export type LoopType = 'loop' | 'hold' | 'once' | 'loopFull' | 'onceFull' | 'holdFull';

const DEG = Math.PI / 180;

interface SampledTransform extends ReanimTransform {
  img: string;
  frame: number;
}

export class Reanim {
  doc: ReanimDoc;
  tracks: ReanimTrack[];
  byName = new Map<string, ReanimTrack>();
  animStart = 0;
  animCount = 1;
  animTime = 0;
  loop: LoopType = 'loop';
  rate: number;
  dead = false;
  /** Track names starting with one of these prefixes are not drawn (render group -1). */
  hiddenPrefixes: string[] = [];
  private assets: Assets;
  private trackName: string | null = null;

  constructor(assets: Assets, doc: ReanimDoc) {
    this.assets = assets;
    this.doc = doc;
    this.tracks = doc.tracks;
    this.rate = doc.fps || 12;
    for (const t of doc.tracks) this.byName.set(t.name, t);
    const first = doc.tracks[0];
    if (first) {
      this.animStart = first.frameStart;
      this.animCount = first.frameCount;
      this.trackName = first.name;
    }
  }

  hasTrack(name: string): boolean {
    return this.byName.has(name.toLowerCase());
  }

  play(name?: string | null, loop: LoopType = 'loop', rate = 0): void {
    const track = (name && this.byName.get(name.toLowerCase())) || this.tracks[0];
    this.animStart = track ? track.frameStart : 0;
    this.animCount = track ? Math.max(1, track.frameCount) : 1;
    this.trackName = track ? track.name : null;
    this.animTime = 0;
    this.loop = loop;
    this.rate = rate || this.doc.fps || 12;
    this.dead = false;
  }

  /** Advance one simulation step (fixed 1/100 s in the original). */
  update(dtSeconds: number): void {
    if (!this.animCount) return;
    const full = this.loop === 'loopFull' || this.loop === 'onceFull' || this.loop === 'holdFull';
    const n = full ? this.animCount : this.animCount - 1;
    if (n <= 0) return;
    this.animTime += dtSeconds * this.rate / this.animCount;
    if (this.loop === 'loop' || this.loop === 'loopFull') {
      while (this.animTime >= 1) this.animTime -= 1;
    } else if (this.loop === 'once' || this.loop === 'onceFull') {
      if (this.animTime >= 1) {
        this.animTime = 1;
        this.dead = true;
      }
    } else {
      this.animTime = Math.min(this.animTime, 1);
    }
  }

  private sample(frames: ReanimTransform[], index: number): ReanimTransform | null {
    if (!frames.length) return null;
    return frames[Math.min(Math.max(index, 0), frames.length - 1)] ?? null;
  }

  /**
   * Frame indices for interpolation.
   *
   * The original C# (Reanimation.GetFrameTime, Reanimation.cs:601-604) truncates
   * `t` to an integer (floor for the non-negative frame axis) and uses the
   * fractional remainder for interpolation.  The spec document previously said
   * round(); the code below matches the actual C#.
   */
  private frameSample(): { before: number; after: number; frac: number } {
    const full = this.loop === 'loopFull' || this.loop === 'onceFull' || this.loop === 'holdFull';
    const n = full ? this.animCount : this.animCount - 1;
    const t = this.animStart + n * this.animTime;
    const last = this.animStart + this.animCount - 1;
    let base = Math.floor(t);
    let frac = t - base;
    if (base >= last) {
      base = last;
      frac = 0;
    }
    const before = Math.max(this.animStart, base);
    const after = Math.min(before + 1, last);
    const interpolate = this.doc.interpolate !== false;
    return { before, after, frac: interpolate ? frac : 0 };
  }

  get frameIndex(): number {
    return this.frameSample().before;
  }

  get finished(): boolean {
    return this.dead;
  }

  private hidePrefixes(): string[] {
    return this.hiddenPrefixes;
  }

  /**
   * Draw the current frame.
   * @param sx overlay horizontal scale (-1 mirrors; the zombie art is authored facing right)
   * @param sy overlay vertical scale
   * @param alphaMul extra alpha multiplier
   * @param filter optional CSS filter applied to every sprite (e.g. sun hue-rotate)
   */
  draw(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    sx = 1,
    sy = 1,
    alphaMul = 1,
    filter?: string,
  ): void {
    const { before, after, frac } = this.frameSample();
    const hidden = this.hidePrefixes();
    for (const track of this.tracks) {
      if (hidden.length && hidden.some((p) => track.name.startsWith(p))) continue;
      const t1 = this.sample(track.transforms, before);
      if (!t1) continue;
      if ((t1.frame ?? 0) < 0) continue;
      if (!t1.img) continue;
      // Truncate disappearing frames: if the interpolated target frame is
      // hidden, skip the track for this tick (spec §5.7, mTruncateDisappearingFrames).
      const t2 = frac > 0 ? this.sample(track.transforms, after) : null;
      if (t2 && (t2.frame ?? 0) < 0) continue;

      const alpha = lerp(t1.alpha ?? 1, t2 ? t2.alpha ?? 1 : t1.alpha ?? 1, frac) * alphaMul;
      if (alpha <= 0.004) continue;
      const col = Math.round(t1.frame ?? 0);
      const view: SpriteView | null = filter ? this.assets.filteredView(t1.img, filter, col) : this.assets.view(t1.img, col);
      if (!view) continue;

      // C# interpolates the cached sin/cos values; interpolating angles would
      // rotate the long way around when a track crosses the 360° boundary.
      const trig = (key: 'kx' | 'ky', fn: (v: number) => number) => lerp(
        fn((t1[key] ?? 0) * DEG), fn((t2?.[key] ?? t1[key] ?? 0) * DEG), frac);
      const scaleX = lerp(t1.sx ?? 1, t2 ? t2.sx ?? 1 : t1.sx ?? 1, frac);
      const scaleY = lerp(t1.sy ?? 1, t2 ? t2.sy ?? 1 : t1.sy ?? 1, frac);
      const tx = lerp(t1.tx ?? 0, t2 ? t2.tx ?? 0 : t1.tx ?? 0, frac);
      const ty = lerp(t1.ty ?? 0, t2 ? t2.ty ?? 0 : t1.ty ?? 0, frac);

      const a = trig('kx', Math.cos) * scaleX * sx;
      const b = trig('kx', Math.sin) * scaleX * sy;
      const c = -trig('ky', Math.sin) * scaleY * sx;
      const d = trig('ky', Math.cos) * scaleY * sy;
      const e = x + tx * sx;
      const f = y + ty * sy;

      ctx.save();
      ctx.transform(a, b, c, d, e, f);
      ctx.globalAlpha = Math.min(1, Math.max(0, alpha));
      const dw = view.dw;
      const dh = view.dh;
      // The C# renderer adds the transformed half-cel to the matrix before
      // drawing a centered quad. Together these make tx/ty the top-left origin.
      ctx.drawImage(view.img, view.sx, view.sy, view.sw, view.sh, 0, 0, dw, dh);
      ctx.restore();
    }
  }

  /** Approximate local bounding box of the current frame relative to (x,y). */
  bounds(): { x: number; y: number; w: number; h: number } {
    const { before } = this.frameSample();
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const track of this.tracks) {
      const tr = this.sample(track.transforms, before);
      if (!tr || !tr.img || (tr.frame ?? 0) < 0) continue;
      const view = this.assets.view(tr.img, Math.round(tr.frame ?? 0));
      if (!view) continue;
      if (this.hiddenPrefixes.some(prefix => track.name.startsWith(prefix))) continue;
      for (const [x, y] of [[0, 0], [view.dw, 0], [0, view.dh], [view.dw, view.dh]]) {
        const px = (tr.tx ?? 0) + Math.cos((tr.kx ?? 0) * DEG) * (tr.sx ?? 1) * x - Math.sin((tr.ky ?? 0) * DEG) * (tr.sy ?? 1) * y;
        const py = (tr.ty ?? 0) + Math.sin((tr.kx ?? 0) * DEG) * (tr.sx ?? 1) * x + Math.cos((tr.ky ?? 0) * DEG) * (tr.sy ?? 1) * y;
        minX = Math.min(minX, px); maxX = Math.max(maxX, px);
        minY = Math.min(minY, py); maxY = Math.max(maxY, py);
      }
    }
    if (!Number.isFinite(minX)) return { x: 0, y: 0, w: 0, h: 0 };
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Draw an atlas sprite centered. */
export function drawSpriteCentered(
  ctx: CanvasRenderingContext2D,
  assets: Assets,
  id: string,
  cx: number,
  cy: number,
  scale = 1,
  alpha = 1,
): void {
  const v = assets.view(id);
  if (!v) return;
  const w = v.dw * scale;
  const h = v.dh * scale;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.drawImage(v.img, v.sx, v.sy, v.sw, v.sh, cx - w / 2, cy - h / 2, w, h);
  ctx.restore();
}

/** Draw an atlas sprite with top-left anchoring (UI). */
export function drawSprite(
  ctx: CanvasRenderingContext2D,
  assets: Assets,
  id: string,
  x: number,
  y: number,
  scale = 1,
  alpha = 1,
  cel = 0,
): void {
  const v = assets.view(id, cel);
  if (!v) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.drawImage(v.img, v.sx, v.sy, v.sw, v.sh, x, y, v.dw * scale, v.dh * scale);
  ctx.restore();
}
