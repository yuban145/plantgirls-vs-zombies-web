/**
 * Spine (4.2) plant-girl renderer.
 *
 * The mod draws its plant girls with Spine skeletons stored in Content/spanim:
 *   <name>.atlas + <name>.skel (binary 4.2.43) + <name>.png
 * The C# game instantiates a Skeleton per plant, plays the "idle" animation and
 * renders it with spine-monogame (Reanimation.DrawSpineGroup). We reproduce that
 * with the official @esotericsoftware/spine-canvas runtime.
 */
import {
  AnimationState,
  AnimationStateData,
  AssetManager,
  AtlasAttachmentLoader,
  MeshAttachment,
  Physics,
  RegionAttachment,
  Skeleton,
  SkeletonBinary,
  SceneRenderer,
  ManagedWebGLRenderingContext,
  Vector2,
} from '@esotericsoftware/spine-webgl';
import type { SkeletonData } from '@esotericsoftware/spine-core';

export interface SpineAsset {
  name: string;
  data: SkeletonData;
  animations: string[];
  /** Skeleton bounds height in spine units (for automatic scale calibration). */
  height: number;
}

const assetCache = new Map<string, Promise<SpineAsset | null>>();

/** Load one spine character (atlas + png + binary skeleton). */
export function loadSpineAsset(name: string): Promise<SpineAsset | null> {
  const cached = assetCache.get(name);
  if (cached) return cached;
  const p = (async (): Promise<SpineAsset | null> => {
    try {
      const manager = new AssetManager(getRenderer().context, 'data/spanim/');
      manager.loadTextureAtlas(`${name}.atlas`);
      manager.loadBinary(`${name}.skel`);
      await manager.loadAll();
      const atlas = manager.require(`${name}.atlas`);
      const buffer = manager.require(`${name}.skel`) as Uint8Array;
      const attachmentLoader = new AtlasAttachmentLoader(atlas);
      const data = new SkeletonBinary(attachmentLoader).readSkeletonData(buffer) as SkeletonData;
      const animations = (data.animations ?? []).map((a) => a.name);
      console.info(`[spine] ${name}: ${animations.length} animations [${animations.slice(0, 6).join(', ')}] height=${data.height}`);
      return { name, data, animations, height: data.height ?? 0 };
    } catch (err) {
      console.warn(`[spine] failed to load ${name}`, err);
      return null;
    }
  })();
  assetCache.set(name, p);
  return p;
}

/** One live instance of a spine character (one per planted girl). */
export class SpineChar {
  readonly asset: SpineAsset;
  readonly skeleton: Skeleton;
  private state: AnimationState;
  private current = '';
  private fitCache: { target: number; scale: number } | null = null;

  constructor(asset: SpineAsset) {
    this.asset = asset;
    this.skeleton = new Skeleton(asset.data);
    this.state = new AnimationState(new AnimationStateData(asset.data));
    this.setAnimation(this.pickAnimation(['idle', 'anim_idle']), true);
  }

  private pickAnimation(candidates: string[]): string {
    for (const c of candidates) if (this.asset.animations.includes(c)) return c;
    return this.asset.animations[0] ?? '';
  }

  setAnimation(name: string, loop: boolean, force = false): void {
    if (!name) return;
    if (!this.asset.animations.includes(name)) return;
    if (name === this.current && !force) return;
    this.current = name;
    this.state.setAnimation(0, name, loop).mixDuration = 0.06;
  }

  /** True when the current track entry finished (only meaningful for loop=false). */
  currentComplete(): boolean {
    const entry = this.state.getCurrent(0);
    return !!entry && typeof entry.isComplete === 'function' ? entry.isComplete() : false;
  }

  currentAnimation(): string {
    return this.current;
  }

  playIdle(): void {
    this.setAnimation(this.pickAnimation(['idle', 'anim_idle']), true);
  }

  playAttack(): void {
    // Force a restart: with force=false a repeated "shooting" would keep the
    // previous (finished) track and the girl would freeze on the last frame.
    this.setAnimation(this.pickAnimation(['shooting', 'attack', 'bite', 'shoot', 'anim_shooting', 'idle']), false, true);
  }

  update(dt: number): void {
    this.skeleton.update(dt);
    this.state.update(dt);
    this.state.apply(this.skeleton);
    this.skeleton.updateWorldTransform(Physics.update);
  }

  /** World bounds of the current pose (spine units, y up). */
  bounds(): { x: number; y: number; w: number; h: number; regions: number; meshes: number } {
    this.state.apply(this.skeleton);
    this.skeleton.updateWorldTransform(Physics.pose);
    const offset = new Vector2();
    const size = new Vector2();
    let regions = 0;
    let meshes = 0;
    for (const slot of this.skeleton.slots) {
      const a = slot.getAttachment();
      if (a instanceof RegionAttachment) regions++;
      else if (a instanceof MeshAttachment) meshes++;
    }
    try {
      this.skeleton.getBounds(offset, size);
    } catch {
      /* older API */
    }
    return { x: offset.x, y: offset.y, w: size.x, h: size.y, regions, meshes };
  }

  /** Skeleton height in spine units, used to derive the draw scale. */
  get unitHeight(): number {
    return this.asset.height || 400;
  }

  /** Draw scale so the visible art is `targetHeight` logical px tall. */
  scaleForHeight(targetHeight: number): number {
    if (this.fitCache && this.fitCache.target === targetHeight) return this.fitCache.scale;
    const b = this.bounds();
    const scale = b.h > 1 ? targetHeight / b.h : targetHeight / this.unitHeight;
    this.fitCache = { target: targetHeight, scale };
    return scale;
  }
}

let sharedRenderer: SceneRenderer | null = null;
function getRenderer(): SceneRenderer {
  if (!sharedRenderer) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 512;
    const context = new ManagedWebGLRenderingContext(canvas, { alpha: true, premultipliedAlpha: true, antialias: true, preserveDrawingBuffer: true });
    sharedRenderer = new SceneRenderer(canvas, context);
  }
  return sharedRenderer;
}

export function drawSpine(
  ctx: CanvasRenderingContext2D,
  char: SpineChar,
  x: number,
  y: number,
  scale: number,
  mirror = false,
  alpha = 1,
): void {
  // Render mesh attachments with the GPU. Canvas triangle clipping creates
  // visible seams and does not implement Spine clipping/two-color tinting.
  const renderer = getRenderer();
  const gl = renderer.context.gl;
  gl.viewport(0, 0, 512, 512);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  renderer.camera.viewportWidth = 256 / scale;
  renderer.camera.viewportHeight = 256 / scale;
  renderer.camera.position.set(0, 80 / scale, 0);
  renderer.begin();
  renderer.drawSkeleton(char.skeleton, true);
  renderer.end();
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(mirror ? -1 : 1, 1);
  ctx.globalAlpha = alpha;
  ctx.drawImage(renderer.canvas, -128, -208, 256, 256);
  ctx.restore();
}
