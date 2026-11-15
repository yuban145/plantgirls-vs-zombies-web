/**
 * Board simulation + rendering for a Day lawn level.
 *
 * Faithful to docs/spec-render.md / spec-reanim.md / spec-levels.md:
 *  - 1000x600 logical canvas, board widget offset x=+100
 *  - 9x5 grid, cell 80x100, grid origin board-local (40,80)
 *  - fixed 100 Hz simulation tick (10 ms)
 *  - original gameplay numbers (sun 25, zombie hp/speed, eat cycle, mower, waves)
 *  - conveyor-belt seed banks (1-5 / 1-10), pre-planted plants, player-chosen
 *    interactive seed selection and rolling Wall-nut Bowling
 */
import type { Assets, LevelDef, PlantDef, SpriteView, ZombieDef } from '../assets';
import type { Audio } from '../audio';
import { Reanim, drawSprite, drawSpriteCentered } from '../reanim';
import { SpineChar, drawSpine } from '../spine';

export const LOGICAL_W = 1000;
export const LOGICAL_H = 600;

const TICK = 1 / 100;
const BOARD_DX = 100;
const GRID_X = 40; // board-local
const GRID_Y = 80; // board-local == screen y
const CELL_W = 80;
const CELL_H = 100;
const COLS = 9;
const ROWS = 5;
const BG_X = -360;
const BG_Y = -60;
const SUN_VALUE = 25;
const MOWER_X = -21;
const MOWER_SPEED = 3.33;
const MOWERS_TRIGGER_X = 29;
const DEFAULT_SEEDS = ['Peashooter', 'Sunflower', 'Cherrybomb', 'Wallnut', 'Potatomine', 'Snowpea'];
const CONVEYOR_MAX_CARDS = 10;

export type BoardState = 'choosing' | 'playing' | 'paused' | 'won' | 'lost';

interface SeedPacket {
  seed: string;
  def: PlantDef;
  cooldown: number;
  maxCooldown: number;
}

interface ConveyorCard {
  seed: string;
  y: number;
}

interface ConveyorState {
  cards: ConveyorCard[];
  timer: number;
  pool: Array<{ seed: string; weight: number }>;
  replenish: { emptyBelt: number; gt4Cards: number; gt6Cards: number; gt8Cards: number };
}

interface Plant {
  seed: string;
  def: PlantDef;
  col: number;
  row: number;
  x: number; // board-local cell left
  y: number; // board-local cell top
  hp: number;
  maxHp: number;
  reanim: Reanim | null;
  spine: SpineChar | null;
  timer: number;
  fireTimer: number;
  armed: boolean;
  explodeAt: number;
  flash: number;
  chompPhase: 'idle' | 'windup' | 'digest';
  chompTimer: number;
  chompTarget: Zombie | null;
}

interface Zombie {
  def: ZombieDef;
  row: number;
  x: number; // board-local posX
  y: number; // board-local posY
  hp: number;
  maxHp: number;
  helmHp: number;
  speed: number;
  reanim: Reanim | null;
  state: 'walk' | 'eat' | 'die' | 'mowed' | 'vault';
  eatTarget: Plant | null;
  eatTimer: number;
  dieTimer: number;
  chillTicks: number;
  flash: number;
  flag: boolean;
  hidden: string[];
  vaulted: boolean;
  vaultTimer: number;
  vaultDuration: number;
  vaultFromX: number;
  vaultToX: number;
}

interface Projectile {
  x: number;
  y: number;
  row: number;
  damage: number;
  kind: string;
  chillTicks: number;
}

interface SunToken {
  x: number;
  y: number;
  targetY: number;
  value: number;
  state: 'fall' | 'rest' | 'collect';
  restTimer: number;
  reanim: Reanim | null;
  scale: number;
}

interface Mower {
  row: number;
  x: number;
  state: 'ready' | 'running' | 'gone';
  reanim: Reanim | null;
}

interface Explosion {
  x: number;
  y: number;
  radius: number;
  timer: number;
  max: number;
}

interface Loadout {
  kind: 'fixed' | 'playerChosen' | 'conveyor';
  seeds: string[];
  prePlanted: Array<{ gridX: number; gridY: number; seedType: string }>;
  conveyorPool: Array<{ seed: string; weight: number }>;
  initialCards: string[];
  firstCardCountDownTicks: number;
  replenish: { emptyBelt: number; gt4Cards: number; gt6Cards: number; gt8Cards: number };
}

export interface BoardCallbacks {
  onExit: () => void;
  onNav: (to: 'menu' | 'levelSelect') => void;
}

/** Track prefixes hidden by `Zombie.SetupReanimLayers` (Zombie.cs:8169-8220). */
const ZOMBIE_BASE_HIDDEN = [
  'anim_cone',
  'anim_bucket',
  'anim_screendoor',
  'zombie_flaghand',
  'zombie_duckytube',
  'anim_tongue',
  'zombie_mustache',
  'zombie_outerarm_screendoor',
  'zombie_innerarm_screendoor',
];

function zombieHiddenFor(type: string): string[] {
  const hidden = [...ZOMBIE_BASE_HIDDEN];
  if (type === 'Conehead' || type === 'TrafficCone') {
    return hidden.filter((p) => p !== 'anim_cone').concat(['anim_hair']);
  }
  if (type === 'Buckethead' || type === 'Pail') {
    return hidden.filter((p) => p !== 'anim_bucket').concat(['anim_hair']);
  }
  if (type === 'Flag') {
    return hidden.filter((p) => p !== 'zombie_flaghand').concat(['anim_innerarm']);
  }
  return hidden;
}

function helmetPrefixFor(type: string): string | null {
  if (type === 'Conehead' || type === 'TrafficCone') return 'anim_cone';
  if (type === 'Buckethead' || type === 'Pail') return 'anim_bucket';
  return null;
}

function stripReanimPath(path: string | null | undefined): string | null {
  if (!path) return null;
  return path.startsWith('reanim/') ? path.slice(7) : path;
}

function stripSpinePath(path: string | null | undefined): string | null {
  if (!path) return null;
  return path.startsWith('spanim/') ? path.slice(7) : path;
}

/** Reanim file for a plant's classic (fallback) art. */
function plantReanimName(def: PlantDef): string | null {
  const r = def.reanimation;
  if (!r) return null;
  if (r.isSpine) return stripReanimPath(r.legacyResourcePath);
  return stripReanimPath(r.resourcePath) ?? stripReanimPath(r.legacyResourcePath);
}

function plantSpineName(def: PlantDef): string | null {
  const r = def.reanimation;
  if (!r?.isSpine) return null;
  return stripSpinePath(r.resourcePath);
}

export class Board {
  readonly level: LevelDef;
  readonly levelIndex: number;
  private assets: Assets;
  private audio: Audio;
  private callbacks: BoardCallbacks;
  private loadout: Loadout;

  state: BoardState = 'playing';
  sun = 0;
  packets: SeedPacket[] = [];
  conveyor: ConveyorState | null = null;
  plants: (Plant | null)[][] = [];
  zombies: Zombie[] = [];
  projectiles: Projectile[] = [];
  suns: SunToken[] = [];
  mowers: Mower[] = [];
  explosions: Explosion[] = [];
  rollingNuts: Array<{ plant: Plant; direction: number; targetRow: number }> = [];
  private chosenSeeds: string[] = [];

  selectedPacket = -1;
  selectedCard = -1;
  shovelMode = false;
  tickCount = 0;

  private waveIndex = 0;
  private waveCountdown = 0;
  private waveStartHp = 0;
  private waveStartTick = 0;
  private nextWaveHealthThreshold = 0;
  private hugeWaveTimer = 0;
  private sunCountdown = 0;
  private sunsFallen = 0;
  private speedLevel = 1;
  private levelBannerTimer = 1000;
  private message = '';
  private messageTimer = 0;
  private hoverCell: { col: number; row: number } | null = null;
  private winTimer = 0;
  private loseTimer = 0;
  private bgImage: HTMLImageElement | null = null;
  private bgWidth = 1880;
  private bgHeight = 720;
  private spineTargetHeight = 0;
  private ghost: { seed: string; spine: SpineChar | null; reanim: Reanim | null } | null = null;

  private get activeRows(): number[] {
    return this.level.level === 1 ? [2] : this.level.level <= 3 ? [1, 2, 3] : [0, 1, 2, 3, 4];
  }

  constructor(
    assets: Assets,
    audio: Audio,
    level: LevelDef,
    levelIndex: number,
    callbacks: BoardCallbacks,
    loadout: Loadout,
  ) {
    this.assets = assets;
    this.audio = audio;
    this.level = level;
    this.levelIndex = levelIndex;
    this.callbacks = callbacks;
    this.loadout = loadout;
    const conveyorMode = loadout.kind === 'conveyor';
    this.sun = conveyorMode ? 0 : level.startingSun ?? 50;

    this.plants = Array.from({ length: ROWS }, () => Array<Plant | null>(COLS).fill(null));
    for (let r = 0; r < ROWS; r++) {
      const doc = assets.reanimSync('LawnMower');
      const mowerReanim = doc ? new Reanim(assets, doc) : null;
      mowerReanim?.play('anim_normal', 'loop');
      this.mowers.push({ row: r, x: MOWER_X, state: this.activeRows.includes(r) ? 'ready' : 'gone', reanim: mowerReanim });
    }

    const bg = assets.image(level.level <= 3 ? 'IMAGE_BACKGROUND1UNSODDED' : level.background?.imageResource ?? 'IMAGE_BACKGROUND1');
    if (bg) {
      this.bgImage = bg.img;
      this.bgWidth = bg.info.w;
      this.bgHeight = bg.info.h;
    }

    if (conveyorMode) {
      this.conveyor = {
        cards: loadout.initialCards.map((seed, i) => ({ seed, y: 490 + i * 90 })),
        timer: loadout.firstCardCountDownTicks,
        pool: loadout.conveyorPool,
        replenish: loadout.replenish,
      };
    } else {
      for (const seed of loadout.seeds) {
        const def = assets.plants.get(seed);
        if (!def) continue;
        this.packets.push({ seed, def, cooldown: def.refreshTicks === 5000 ? 3500 : def.refreshTicks === 3000 ? 2000 : 0, maxCooldown: Math.max(1, def.refreshTicks) });
      }
    }
    this.plantPrePlanted();
    if (loadout.kind === 'playerChosen') {
      this.state = 'choosing';
      this.packets = [];
    }

    this.waveCountdown = level.zombieSpawning?.initialWaveCountDownTicks ?? 1800;
    this.sunCountdown = randInt(425, 700);
    if (!conveyorMode) {
      if (level.special?.prePlantedPlants) this.setMessage('点击种子包，然后点击草地种下植物！', 420);
      else this.setMessage('点击种子包，然后点击草地种下植物！', 420);
    } else {
      this.setMessage('传送带模式：点击传送带上的卡片，再点击草地种植（免费）！', 420);
    }
    const params = new URLSearchParams(location.search);
    const heightOverride = Number(params.get('spineHeight'));
    if (heightOverride > 0) this.spineTargetHeight = heightOverride;
    const sunOverride = Number(params.get('sun'));
    if (sunOverride > 0 && !conveyorMode) this.sun = sunOverride;
    const speedOverride = Number(params.get('speed'));
    if (speedOverride >= 1 && speedOverride <= 3) this.speedLevel = Math.round(speedOverride);
    // Verification hook: ?spawn=Polevaulter&row=1 spawns a zombie immediately.
    const spawnType = params.get('spawn');
    if (spawnType) {
      const def = assets.zombies.get(spawnType);
      if (def) this.spawnZombie(def, Number(params.get('row') ?? 2), false);
    }
    this.publishDebugState();
  }

  // ------------------------------------------------------------ loadout plan
  private static resolveLoadout(assets: Assets, level: LevelDef): Loadout {
    const sb = level.seedBank;
    const kind = sb?.kind === 'conveyor' ? 'conveyor' : sb?.kind === 'playerChosen' ? 'playerChosen' : 'fixed';
    let seeds: string[] = [];
    if (kind === 'conveyor') {
      seeds = [...(sb.initialCards ?? []), ...(sb.cardPool ?? []).map((c) => c.seed)];
    } else if (sb?.packets?.length) {
      seeds = [...sb.packets];
    } else if (sb?.chooserOffers?.length) {
      // Preload every supported offer; the player chooses the actual packets.
      seeds = [...sb.chooserOffers];
    } else {
      seeds = [...DEFAULT_SEEDS];
    }
    seeds = [...new Set(seeds)].filter((s) => assets.plants.has(s));
    const prePlanted = level.special?.prePlantedPlants ?? [];
    for (const p of prePlanted) if (!seeds.includes(p.seedType)) seeds.push(p.seedType);
    const replenish = sb?.replenishCountDownTicks ?? {};
    return {
      kind,
      seeds,
      prePlanted,
      conveyorPool: sb?.cardPool ?? [],
      initialCards: sb?.initialCards ?? [],
      firstCardCountDownTicks: sb?.firstCardCountDownTicks ?? 400,
      replenish: {
        emptyBelt: replenish.emptyBelt ?? 400,
        gt4Cards: replenish.gt4Cards ?? 425,
        gt6Cards: replenish.gt6Cards ?? 500,
        gt8Cards: replenish.gt8Cards ?? 1000,
      },
    };
  }

  private static reanimNamesFor(assets: Assets, loadout: Loadout, level: LevelDef): string[] {
    const names = new Set<string>(['Sun', 'LawnMower', 'Puff']);
    for (const seed of loadout.seeds) {
      const def = assets.plants.get(seed);
      const reanim = def ? plantReanimName(def) : null;
      if (reanim) names.add(reanim);
    }
    for (const wave of level.waves ?? []) {
      for (const z of wave.zombies) {
        const def = assets.zombies.get(z);
        const path = stripReanimPath(def?.reanimation?.resourcePath);
        if (path) names.add(path);
      }
    }
    return [...names];
  }

  private static spineNamesFor(assets: Assets, loadout: Loadout): string[] {
    const names = new Set<string>();
    for (const seed of loadout.seeds) {
      const def = assets.plants.get(seed);
      const spine = def ? plantSpineName(def) : null;
      if (spine) names.add(spine);
    }
    return [...names];
  }

  static async create(
    assets: Assets,
    audio: Audio,
    level: LevelDef,
    levelIndex: number,
    callbacks: BoardCallbacks,
    onProgress?: (f: number) => void,
  ): Promise<Board> {
    const loadout = Board.resolveLoadout(assets, level);
    const reanims = Board.reanimNamesFor(assets, loadout, level);
    const spines = Board.spineNamesFor(assets, loadout);
    let done = 0;
    const total = reanims.length + spines.length;
    const tick = () => onProgress?.(++done / Math.max(1, total));
    await Promise.all([
      assets.preload(reanims, () => tick()),
      ...spines.map((n) => assets.preloadSpine(n).then(() => tick())),
    ]);
    return new Board(assets, audio, level, levelIndex, callbacks, loadout);
  }

  // ---------------------------------------------------------------- helpers
  private setMessage(text: string, ticks = 300): void {
    this.message = text;
    this.messageTimer = ticks;
  }

  private cellAt(screenX: number, screenY: number): { col: number; row: number } | null {
    const bx = screenX - BOARD_DX;
    if (bx < GRID_X || bx >= GRID_X + CELL_W * COLS) return null;
    if (screenY < GRID_Y || screenY >= GRID_Y + CELL_H * ROWS) return null;
    const row = Math.floor((screenY - GRID_Y) / CELL_H);
    return this.activeRows.includes(row) ? { col: Math.floor((bx - GRID_X) / CELL_W), row } : null;
  }

  private plantAt(col: number, row: number): Plant | null {
    if (row < 0 || row >= ROWS || col < 0 || col >= COLS) return null;
    return this.plants[row][col];
  }

  private makeReanim(path: string | null | undefined, fallbacks: string[] = []): Reanim | null {
    const candidates = [path, ...fallbacks]
      .filter((p): p is string => !!p)
      .map((p) => stripReanimPath(p) as string);
    for (const name of candidates) {
      const doc = this.assets.reanimSync(name);
      if (doc) return new Reanim(this.assets, doc);
    }
    return null;
  }

  private makeSpine(def: PlantDef): SpineChar | null {
    const name = plantSpineName(def);
    if (!name) return null;
    const asset = this.assets.spine(name);
    return asset ? new SpineChar(asset) : null;
  }

  private buildPlantVisual(def: PlantDef): { reanim: Reanim | null; spine: SpineChar | null } {
    const spine = this.makeSpine(def);
    const reanim = spine ? null : this.makeReanim(plantReanimName(def));
    return { reanim, spine };
  }

  private playPlantIdle(plant: Plant): void {
    plant.spine?.playIdle();
    const r = plant.reanim;
    if (!r) return;
    switch (plant.seed) {
      case 'Sunflower':
        r.play(r.hasTrack('anim_producing') ? 'anim_producing' : 'anim_idle', 'loop');
        break;
      case 'Wallnut':
      case 'ExplodeONut':
        r.play('anim_idle', 'loop');
        break;
      case 'Potatomine':
        r.play(plant.armed && r.hasTrack('anim_armed') ? 'anim_armed' : 'anim_idle', 'loop');
        break;
      case 'Chomper':
        r.play('anim_idle', 'loop');
        break;
      case 'Cherrybomb':
        r.play('anim_idle', 'loop');
        break;
      default:
        r.play(r.hasTrack('anim_idle') ? 'anim_idle' : undefined, 'loop');
    }
  }

  private playZombieAnim(z: Zombie, name: string, loop: 'loop' | 'once' | 'hold' | 'loopFull' | 'onceFull'): void {
    if (!z.reanim) return;
    if (name === 'anim_walk' && z.def.zombieType === 'Polevaulter' && !z.vaulted) name = 'anim_run';
    if (name !== 'anim_walk' && name !== 'anim_eat' && !z.reanim.hasTrack(name)) {
      z.reanim.play('anim_walk', loop);
      return;
    }
    z.reanim.play(name, loop);
    if (name === 'anim_jump') z.reanim.rate = 24;
    else if (name === 'anim_eat') z.reanim.rate = z.def.zombieType === 'Polevaulter' ? 20 : 36;
    else if (name === 'anim_walk' || name === 'anim_run') {
      const ground = z.reanim.byName.get('_ground');
      const start = z.reanim.animStart;
      const distance = ground ? (ground.transforms[start + z.reanim.animCount - 1]?.tx ?? 0) - (ground.transforms[start]?.tx ?? 0) : 0;
      if (distance > 0.000001) z.reanim.rate = z.speed * z.reanim.animCount / distance * 47;
    }
  }

  // ------------------------------------------------------------------ update
  update(): void {
    if (this.state === 'won' || this.state === 'lost') {
      this.tickCount++;
      if (this.state === 'won') this.winTimer++;
      else this.loseTimer++;
      // Let animations finish and remove corpses so the result screen looks alive.
      for (const s of this.suns) s.reanim?.update(TICK);
      for (const row of this.plants) {
        for (const p of row) {
          p?.reanim?.update(TICK);
          p?.spine?.update(TICK);
        }
      }
      for (let i = this.zombies.length - 1; i >= 0; i--) {
        const z = this.zombies[i];
        z.reanim?.update(TICK);
        if (z.state === 'die' || z.state === 'mowed') {
          z.dieTimer--;
          if (z.dieTimer <= 0 || (z.reanim && z.reanim.finished)) this.zombies.splice(i, 1);
        }
      }
      for (const m of this.mowers) {
        m.reanim?.update(TICK);
        if (m.state === 'running') {
          m.x += MOWER_SPEED;
          if (m.x > 800) m.state = 'gone';
        }
      }
      this.explosions = this.explosions.filter((e) => --e.timer > 0);
      return;
    }
    if (this.state === 'paused' || this.state === 'choosing') return;
    this.tickCount++;
    this.ghost?.spine?.update(TICK);
    this.ghost?.reanim?.update(TICK);
    if (this.levelBannerTimer > 0) this.levelBannerTimer--;
    if (this.messageTimer > 0) this.messageTimer--;

    for (const p of this.packets) if (p.cooldown > 0) p.cooldown--;
    for (const m of this.mowers) m.reanim?.update(TICK);

    this.updateConveyor();
    this.updateSunSpawning();
    this.updateWaves();
    this.updatePlants();
    this.updateBowling();
    this.updateZombies();
    this.updateProjectiles();
    this.updateSuns();
    this.updateMowers();
    this.updateExplosions();
    this.checkLevelEnd();
  }

  private updateConveyor(): void {
    const belt = this.conveyor;
    if (!belt) return;
    if (this.tickCount % 4 === 0) {
      belt.cards.forEach((card, i) => { card.y = Math.max(20 + i * 57, card.y - 1); });
    }
    if (belt.timer > 0) belt.timer--;
    if (belt.timer > 0 || belt.cards.length >= CONVEYOR_MAX_CARDS) return;
    const card = this.pickConveyorCard();
    if (card) belt.cards.push({ seed: card, y: Math.max(490, (belt.cards.at(-1)?.y ?? 400) + 90) });
    const n = belt.cards.length;
    belt.timer = n > 8 ? belt.replenish.gt8Cards : n > 6 ? belt.replenish.gt6Cards : n > 4 ? belt.replenish.gt4Cards : belt.replenish.emptyBelt;
  }

  private pickConveyorCard(): string | null {
    const pool = this.conveyor?.pool ?? [];
    if (!pool.length) return null;
    const total = pool.reduce((s, c) => s + c.weight, 0);
    let roll = Math.random() * total;
    for (const card of pool) {
      roll -= card.weight;
      if (roll <= 0) return card.seed;
    }
    return pool[0].seed;
  }

  private updateSunSpawning(): void {
    if (this.conveyor) return; // conveyor levels have no natural sun
    if (this.sunCountdown <= 0) return;
    this.sunCountdown--;
    if (this.sunCountdown > 0) return;
    const x = GRID_X + randInt(0, 549);
    this.spawnFallingSun(x, 60, randInt(300, 549), SUN_VALUE, 1);
    // Original order: count this sun first, then compute the next countdown (spec §7.1).
    this.sunCountdown = Math.min(950, 425 + 10 * this.sunsFallen) + randInt(0, 274);
    this.sunsFallen++;
  }

  private liveZombieHp(): number {
    let hp = 0;
    for (const z of this.zombies) {
      if (z.state === 'die' || z.state === 'mowed') continue;
      hp += Math.max(0, z.hp) + Math.max(0, z.helmHp);
    }
    return hp;
  }

  private updateWaves(): void {
    const waves = this.level.waves ?? [];
    const spawnCfg = this.level.zombieSpawning ?? {};
    // Huge-wave warning gates the spawn: while the banner runs the wave
    // countdown is frozen at 5 (Board.UpdateZombieSpawning, Board.cs:7304-7334).
    // Only when the 750-tick warning ends is the countdown set to 1.
    if (this.hugeWaveTimer > 0) {
      this.hugeWaveTimer--;
      if (this.hugeWaveTimer > 0) return;
      // Warning finished: the original continues into the normal countdown
      // path in the same UpdateZombieSpawning call (Board.cs:7306-7334).
      this.waveCountdown = 1;
    }
    if (this.waveIndex >= waves.length) return;
    const shortcut = spawnCfg.healthShortcut;
    const minAge = shortcut?.minWaveAgeTicks ?? 400;
    const minCountdown = shortcut?.minCountDownTicks ?? 200;
    if (this.waveCountdown > 0) {
      this.waveCountdown--;
      // "Rush" shortcut (Board.cs:7336-7341): a nearly-cleared wave lets the
      // next one start after 200 ticks instead of the full countdown.
      if (
        this.waveIndex > 0 &&
        this.waveCountdown > 5 &&
        this.tickCount - this.waveStartTick > minAge &&
        this.nextWaveHealthThreshold > 0 &&
        this.liveZombieHp() <= this.nextWaveHealthThreshold &&
        this.waveCountdown > minCountdown
      ) {
        this.waveCountdown = minCountdown;
      }
      const upcoming = waves[this.waveIndex];
      // At countdown 5 a flag wave shows the huge-wave banner for 750 ticks and
      // the countdown is frozen (returns) until the banner finishes.
      if (this.waveCountdown === 5 && upcoming?.flag) {
        this.hugeWaveTimer = spawnCfg.hugeWaveCountDownTicks ?? 750;
        return;
      }
      if (this.waveCountdown !== 0) return;
    } else {
      return;
    }
    const wave = waves[this.waveIndex];
    if (!wave) return;
    this.spawnWave(wave.zombies, wave.flag);
    this.waveIndex++;
    this.waveStartHp = this.liveZombieHp();
    this.waveStartTick = this.tickCount;
    if (this.waveIndex >= waves.length) {
      this.waveCountdown = Number.POSITIVE_INFINITY;
      this.setMessage('最后一波僵尸！守住你的草坪！', 400);
      return;
    }
    const flagTicks = spawnCfg.flagWaveCountDownTicks ?? null;
    if (wave.flag && flagTicks != null) {
      // After spawning a flag wave: 4500 ticks and no rush shortcut
      // (Board.cs:7406-7411).
      this.waveCountdown = flagTicks;
      this.nextWaveHealthThreshold = 0;
    } else {
      this.waveCountdown = 2500 + randInt(0, 599);
      const fracRange = spawnCfg.healthToNextWaveFractionRange ?? [0.5, 0.65];
      this.nextWaveHealthThreshold = randFloat(fracRange[0], fracRange[1]) * this.waveStartHp;
    }
  }

  private spawnWave(types: string[], flagWave: boolean): void {
    types.forEach((type) => {
      const def = this.assets.zombies.get(type);
      if (!def) {
        console.warn(`[board] unknown zombie type in level data: ${type}`);
        return;
      }
      const rows = this.activeRows;
      const row = rows[randInt(0, rows.length - 1)];
      this.spawnZombie(def, row, flagWave);
    });
  }

  private spawnZombie(def: ZombieDef, row: number, flagWave: boolean): void {
    if (!this.activeRows.includes(row)) row = this.activeRows[0];
    let x = 780 + randInt(0, 39);
    if (flagWave) x += 40;
    // Zombie.GetPosYBasedOnRow is the lawn row origin minus 30.
    const y = GRID_Y + CELL_H * row - 30;
    const speed =
      def.speed.kind === 'fixed'
        ? (def.speed.pxPerTick ?? 0.45)
        : (def.speed.minPxPerTick ?? 0.23) + Math.random() * ((def.speed.maxPxPerTick ?? 0.37) - (def.speed.minPxPerTick ?? 0.23));
    const reanim = this.makeReanim(def.reanimation?.resourcePath);
    const hp = def.bodyHealth ?? 270;
    const z: Zombie = {
      def,
      row,
      x,
      y,
      hp,
      maxHp: hp,
      helmHp: def.helmHealth ?? 0,
      speed,
      reanim,
      state: 'walk',
      eatTarget: null,
      eatTimer: 0,
      dieTimer: 0,
      chillTicks: 0,
      flash: 0,
      flag: flagWave || def.zombieType === 'Flag',
      hidden: zombieHiddenFor(def.zombieType),
      vaulted: false,
      vaultTimer: 0,
      vaultDuration: 1,
      vaultFromX: 0,
      vaultToX: 0,
    };
    if (z.reanim) this.playZombieAnim(z, 'anim_walk', 'loopFull');
    this.zombies.push(z);
  }

  private plantPrePlanted(): void {
    for (const pre of this.loadout.prePlanted) {
      const def = this.assets.plants.get(pre.seedType);
      if (!def) continue;
      const col = pre.gridX;
      const row = pre.gridY;
      if (col < 0 || col >= COLS || row < 0 || row >= ROWS) continue;
      this.addPlant(def, col, row);
    }
  }

  private addPlant(def: PlantDef, col: number, row: number): Plant | null {
    if (this.plantAt(col, row)) return null;
    const visual = this.buildPlantVisual(def);
    const plant: Plant = {
      seed: def.seedType,
      def,
      col,
      row,
      x: GRID_X + col * CELL_W,
      y: GRID_Y + row * CELL_H,
      hp: def.health ?? 300,
      maxHp: def.health ?? 300,
      reanim: visual.reanim,
      spine: visual.spine,
      timer: 0,
      fireTimer: 0,
      armed: false,
      explodeAt: 0,
      flash: 0,
      chompPhase: 'idle',
      chompTimer: 0,
      chompTarget: null,
    };
    if (def.production) {
      const range = def.production.firstSunCountDownTicksRange ?? [300, 1250];
      plant.timer = randInt(range[0], range[1]);
    }
    if (def.special?.kind === 'mine') plant.timer = def.special.armTicks ?? 1500;
    if (def.attack) {
      const range = def.attack.firstShotCountDownTicksRange ?? [0, 150];
      plant.timer = randInt(range[0], range[1]);
    }
    if (def.special?.kind === 'instantExplosion') {
      plant.explodeAt = def.special.fuseTicks ?? 100;
      plant.reanim?.play('anim_explode', 'once');
    }
    if (!visual.spine) this.playPlantIdle(plant);
    this.plants[row][col] = plant;
    return plant;
  }

  private updatePlants(): void {
    for (let row = 0; row < ROWS; row++) {
      for (let col = 0; col < COLS; col++) {
        const plant = this.plants[row][col];
        if (!plant) continue;
        plant.reanim?.update(TICK);
        plant.spine?.update(TICK);
        plant.flash = Math.max(0, plant.flash - 1);
        const special = plant.def.special;

        if (plant.explodeAt > 0) {
          plant.explodeAt--;
          if (plant.explodeAt === 0) this.explodePlant(plant, special);
          continue;
        }

        if (special?.kind === 'mine') {
          if (!plant.armed) {
            plant.timer--;
            if (plant.timer <= 0) {
              plant.armed = true;
              plant.reanim?.play('anim_armed', 'loop');
            }
          } else {
            const target = this.zombies.find(
              (z) => z.row === row && z.state !== 'die' && z.state !== 'mowed' && Math.abs(z.x - (plant.x + CELL_W / 2)) < 55,
            );
            if (target) plant.explodeAt = 1;
          }
          continue;
        }

        if (special?.kind === 'chomper') {
          this.updateChomper(plant, special);
          continue;
        }

        if (plant.def.production) {
          plant.timer--;
          if (plant.timer <= 0) {
            const prod = plant.def.production;
            this.spawnPlantSun(plant.x + CELL_W / 2, plant.y + CELL_H * 0.35, prod.sunValue);
            const range = prod.subsequentSunCountDownTicksRange ?? [2350, 2500];
            plant.timer = randInt(range[0], range[1]);
          }
        }

        if (plant.def.attack) this.updateShooter(plant);
      }
    }
  }

  private updateChomper(plant: Plant, special: NonNullable<PlantDef['special']>): void {
    if (plant.chompPhase === 'windup') {
      plant.chompTimer--;
      if (plant.chompTimer <= 0) {
        const target = plant.chompTarget;
        if (target && target.state !== 'die' && target.state !== 'mowed') {
          this.damageZombie(target, special.instaKill ? 99999 : 1800);
        }
        plant.chompPhase = 'digest';
        plant.chompTimer = special.digestTicks ?? 4000;
        plant.chompTarget = null;
        plant.spine?.playIdle();
      }
      return;
    }
    if (plant.chompPhase === 'digest') {
      plant.chompTimer--;
      if (plant.chompTimer <= 0) plant.chompPhase = 'idle';
      return;
    }
    const reach = special.attackRectOffsetX ?? 80;
    const target = this.zombies.find(
      (z) =>
        z.row === plant.row &&
        z.state !== 'die' &&
        z.state !== 'mowed' &&
        z.x + 78 >= plant.x + 20 &&
        z.x + 36 <= plant.x + reach,
    );
    if (target) {
      plant.chompPhase = 'windup';
      plant.chompTimer = special.biteWindupTicks ?? 70;
      plant.chompTarget = target;
      if (plant.spine) plant.spine.playAttack();
      else plant.reanim?.play('anim_bite', 'once');
    }
  }

  private updateShooter(plant: Plant): void {
    const attack = plant.def.attack;
    if (!attack) return;
    if (plant.timer > 0) plant.timer--;
    // Spine: return to idle only when the shooting track really finished (its
    // duration is ~1 s, longer than fireAnimationTicks).
    if (plant.spine && plant.spine.currentAnimation() !== 'idle' && plant.spine.currentComplete()) {
      plant.spine.playIdle();
    }
    if (plant.fireTimer > 0) {
      plant.fireTimer--;
      if (plant.fireTimer === 0 && !plant.spine) {
        if (plant.seed !== 'Sunflower') this.playPlantIdle(plant);
      }
      return;
    }
    const target = this.zombies.find((z) => z.row === plant.row && z.state !== 'die' && z.state !== 'mowed' && z.x + 36 > plant.x + 10);
    if (!target) return;
    if (plant.timer > 0) return;
    this.fireProjectile(plant);
    plant.fireTimer = attack.fireAnimationTicks ?? 25;
    plant.timer = (() => {
      const range = attack.nextShotCountDownTicksRange ?? [136, 150];
      return randInt(range[0], range[1]);
    })();
  }

  private fireProjectile(plant: Plant): void {
    const attack = plant.def.attack;
    if (!attack) return;
    // Plant.Fire + GetPeaHeadOffset (Spine head offset is 24,24).
    const muzzleX = plant.x + (plant.seed === 'Peashooter' ? 63 : 90);
    const muzzleY = plant.y + (plant.seed === 'Repeater' ? 1 : plant.seed === 'Snowpea' ? 12 : 11);
    this.projectiles.push({
      x: muzzleX,
      y: muzzleY,
      row: plant.row,
      damage: attack.projectileDamage ?? 20,
      kind: attack.projectileType,
      chillTicks: attack.chill?.durationTicks ?? 0,
    });
    if (attack.shotsPerAttackCycle > 1) {
      // Repeater: second pea follows shortly after the first (data:
      // secondShotTriggerCounter); a short delay keeps the two peas from stacking.
      const delay = attack.secondShotTriggerCounter ?? 25;
      this.pendingSecondShots.push({ plant, row: plant.row, muzzleX, muzzleY, ticks: delay, attack });
    }
    if (plant.spine) plant.spine.playAttack();
    else if (plant.seed !== 'Sunflower') plant.reanim?.play('anim_shooting', 'once');
    this.audio.blip(880, 0.05, 'triangle', 0.12);
  }

  private pendingSecondShots: Array<{ plant: Plant; row: number; muzzleX: number; muzzleY: number; ticks: number; attack: NonNullable<PlantDef['attack']> }> = [];

  private updateSecondShots(): void {
    for (let i = this.pendingSecondShots.length - 1; i >= 0; i--) {
      const shot = this.pendingSecondShots[i];
      if (this.plantAt(shot.plant.col, shot.row) !== shot.plant) {
        this.pendingSecondShots.splice(i, 1);
        continue;
      }
      shot.ticks--;
      if (shot.ticks > 0) continue;
      this.pendingSecondShots.splice(i, 1);
      this.projectiles.push({
        x: shot.muzzleX,
        y: shot.muzzleY,
        row: shot.row,
        damage: shot.attack.projectileDamage ?? 20,
        kind: shot.attack.projectileType,
        chillTicks: shot.attack.chill?.durationTicks ?? 0,
      });
    }
  }

  private updateBowling(): void {
    for (let i = this.rollingNuts.length - 1; i >= 0; i--) {
      const nut = this.rollingNuts[i];
      const p = nut.plant;
      if (p.reanim) {
        const r = p.reanim;
        const ground = r.byName.get('_ground');
        const frame = r.frameIndex;
        const velocity = ground ? ((ground.transforms[Math.min(frame + 1, r.animStart + r.animCount - 1)]?.tx ?? 0) - (ground.transforms[frame]?.tx ?? 0)) * TICK * r.rate : -3;
        p.x -= Math.trunc(velocity);
        r.update(TICK);
      }
      p.y += nut.direction * 3;
      const targetY = GRID_Y + nut.targetRow * CELL_H;
      if (Math.abs(targetY - p.y) <= 3) {
        p.y = targetY;
        p.row = nut.targetRow;
        const z = this.zombies.find(z => z.row === p.row && z.state !== 'die' && z.state !== 'mowed' && z.state !== 'vault' && p.x + 65 >= z.x + 36 && p.x < z.x + 78);
        if (z && p.seed === 'ExplodeONut') {
          this.explodePlant(p, { kind: 'instantExplosion', damage: 1800, radius: 90, rowRange: 1 });
          this.rollingNuts.splice(i, 1);
          continue;
        }
        if (z) {
          // Bowling strips helmet health without spilling that hit into the body.
          const damage = z.helmHp > 0 ? Math.min(900, z.helmHp) : 1800;
          this.damageZombie(z, damage);
          nut.direction = p.row === 4 || nut.direction === 1 ? -1 : p.row === 0 || nut.direction === -1 ? 1 : Math.random() < 0.5 ? -1 : 1;
          this.audio.blip(180, 0.12, 'square', 0.16);
        }
        if (nut.direction) {
          if (p.row === 0) nut.direction = 1;
          if (p.row === 4) nut.direction = -1;
          nut.targetRow = p.row + nut.direction;
        }
      }
      if (p.x > 900) this.rollingNuts.splice(i, 1);
    }
  }

  private updateZombies(): void {
    for (let i = this.zombies.length - 1; i >= 0; i--) {
      const z = this.zombies[i];
      z.reanim?.update(TICK * (z.chillTicks > 0 ? z.def.speed.chilledFactor ?? 0.4 : 1));
      z.flash = Math.max(0, z.flash - 1);
      if (z.chillTicks > 0) z.chillTicks--;

      if (z.state === 'die' || z.state === 'mowed') {
        z.dieTimer--;
        if (!z.reanim || z.reanim.finished || z.dieTimer <= 0) this.zombies.splice(i, 1);
        continue;
      }

      if (z.state === 'vault') {
        z.vaultTimer -= z.chillTicks > 0 ? z.def.speed.chilledFactor ?? 0.4 : 1;
        const progress = 1 - Math.max(0, z.vaultTimer) / z.vaultDuration;
        z.x = z.vaultFromX + (z.vaultToX - z.vaultFromX) * Math.min(1, progress);
        if (z.vaultTimer <= 0) {
          z.state = 'walk';
          z.vaulted = true;
          z.speed = 0.23 + Math.random() * 0.14;
          this.playZombieAnim(z, 'anim_walk', 'loopFull');
        }
        continue;
      }

      const chilled = z.chillTicks > 0;
      const attackX = z.x + (z.def.zombieType === 'Polevaulter' && !z.vaulted ? -29 : 50);
      const target = this.findEatTarget(z, attackX);

      // Polevaulter: vault over the first plant it reaches (Tall-nut blocks it).
      const vault = z.def.special?.vault;
      if (vault?.triggersWhenPlantAhead && !z.vaulted && target && target.seed !== 'Tallnut' && z.def.zombieType === 'Polevaulter') {
        z.state = 'vault';
        z.vaultFromX = z.x;
        z.vaultToX = target.x - 60;
        this.playZombieAnim(z, 'anim_jump', 'onceFull');
        z.vaultDuration = z.vaultTimer = Math.ceil((z.reanim?.animCount ?? 43) / 24 * 100);
        continue;
      }

      if (target) {
        if (z.state !== 'eat') {
          z.state = 'eat';
          this.playZombieAnim(z, 'anim_eat', 'loopFull');
        }
        z.eatTimer--;
        if (z.eatTimer <= 0) {
          const dmg = z.def.eating?.damagePerBite ?? 4;
          this.damagePlant(target, dmg);
          const interval = chilled ? (z.def.eating?.chilledBiteIntervalTicks ?? 8) : (z.def.eating?.biteIntervalTicks ?? 4);
          z.eatTimer = interval;
        }
      } else {
        if (z.state !== 'walk') {
          z.state = 'walk';
          this.playZombieAnim(z, 'anim_walk', 'loopFull');
        }
        let speed = z.speed;
        if (chilled) speed *= z.def.speed.chilledFactor ?? 0.4;
        z.x -= speed;
        if (z.x < -160) z.x = -160;
      }

      const mower = this.mowers[z.row];
      if (z.x + 36 <= MOWERS_TRIGGER_X && mower.state === 'ready') {
        mower.state = 'running';
        if (mower.reanim) mower.reanim.rate = 30;
        this.setMessage('小推车启动！', 120);
        this.audio.sweep(200, 700, 0.25, 'square');
      }
      if (mower.state === 'gone' && z.x + 36 <= 0) {
        this.lose();
        return;
      }
    }
  }

  private findEatTarget(z: Zombie, attackX: number): Plant | null {
    for (let col = COLS - 1; col >= 0; col--) {
      const p = this.plants[z.row][col];
      if (!p) continue;
      const overlap = Math.min(attackX + 20, p.x + 70) - Math.max(attackX, p.x + 10);
      if (overlap >= 20) return p;
    }
    return null;
  }

  private damagePlant(plant: Plant, dmg: number): void {
    plant.hp -= dmg;
    plant.flash = 6;
    if (plant.hp > 0) return;
    const special = plant.def.special;
    if (special?.kind === 'deathExplosion') {
      this.explodePlant(plant, special);
      return;
    }
    this.plants[plant.row][plant.col] = null;
  }

  private updateProjectiles(): void {
    this.updateSecondShots();
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i];
      p.x += 3.33;
      if (p.x > 1000) {
        this.projectiles.splice(i, 1);
        continue;
      }
      // Hit the closest zombie *ahead*: choose the leftmost overlapping zombie
      // (it is the first one the pea reaches on its path).
      let hit: Zombie | null = null;
      for (const z of this.zombies) {
        if (z.row !== p.row || z.state === 'die' || z.state === 'mowed' || z.state === 'vault') continue;
        if (p.x + 14 >= z.x + 36 && p.x - 14 <= z.x + 78) {
          if (!hit || z.x < hit.x) hit = z;
        }
      }
      if (hit) {
        this.projectiles.splice(i, 1);
        this.damageZombie(hit, p.damage);
        if (p.chillTicks > 0) hit.chillTicks = Math.max(hit.chillTicks, p.chillTicks);
        this.audio.blip(p.kind === 'Snowpea' ? 520 : 420, 0.05, 'triangle', 0.08);
      }
    }
  }

  private damageZombie(z: Zombie, dmg: number): void {
    z.flash = 4;
    if (z.helmHp > 0) {
      const absorbed = Math.min(z.helmHp, dmg);
      z.helmHp -= absorbed;
      dmg -= absorbed;
      if (z.helmHp <= 0) {
        const prefix = helmetPrefixFor(z.def.zombieType);
        if (prefix && !z.hidden.includes(prefix)) z.hidden.push(prefix);
        this.audio.blip(300, 0.12, 'square', 0.2);
      }
    }
    if (dmg > 0) z.hp -= dmg;
    if (z.hp <= 0 && z.state !== 'die') {
      z.state = 'die';
      z.dieTimer = 220;
      this.playZombieAnim(z, 'anim_death', 'once');
    }
  }

  private updateSuns(): void {
    for (let i = this.suns.length - 1; i >= 0; i--) {
      const s = this.suns[i];
      s.reanim?.update(TICK);
      if (s.state === 'fall') {
        s.y += 0.67;
        if (s.y >= s.targetY) {
          s.y = s.targetY;
          s.state = 'rest';
          s.restTimer = 750;
        }
      } else if (s.state === 'rest') {
        s.restTimer--;
        if (s.restTimer <= 0) this.suns.splice(i, 1);
      } else if (s.state === 'collect') {
        const tx = 15;
        const ty = 5;
        const dx = tx - s.x;
        const dy = ty - s.y;
        const dist = Math.hypot(dx, dy);
        if (dist < 8) {
          this.sun += s.value;
          this.suns.splice(i, 1);
          continue;
        }
        s.x += dx / 21;
        s.y += dy / 21;
        s.scale = Math.max(0.5, Math.min(1, dist * 0.05));
      }
    }
  }

  private updateMowers(): void {
    for (const m of this.mowers) {
      if (m.state !== 'running') continue;
      m.x += MOWER_SPEED;
      for (const z of this.zombies) {
        if (z.row !== m.row || z.state === 'die' || z.state === 'mowed') continue;
        if (m.x + 45 >= z.x + 36 && m.x <= z.x + 78) {
          z.state = 'mowed';
          z.dieTimer = 25;
          this.playZombieAnim(z, 'anim_death2', 'hold');
        }
      }
      if (m.x > 800) m.state = 'gone';
    }
  }

  private updateExplosions(): void {
    for (let i = this.explosions.length - 1; i >= 0; i--) {
      this.explosions[i].timer--;
      if (this.explosions[i].timer <= 0) this.explosions.splice(i, 1);
    }
  }

  private spawnFallingSun(x: number, y: number, targetY: number, value: number, scale: number): void {
    const doc = this.assets.reanimSync('Sun');
    const reanim = doc ? new Reanim(this.assets, doc) : null;
    reanim?.play(undefined, 'loop', 6);
    this.suns.push({ x, y, targetY, value, state: 'fall', restTimer: 0, reanim, scale });
  }

  private spawnPlantSun(x: number, y: number, value: number): void {
    const doc = this.assets.reanimSync('Sun');
    const reanim = doc ? new Reanim(this.assets, doc) : null;
    reanim?.play(undefined, 'loop', 6);
    this.suns.push({ x, y, targetY: y + 10, value, state: 'rest', restTimer: 900, reanim, scale: 1 });
  }

  private explodePlant(plant: Plant, special: NonNullable<PlantDef['special']> | null): void {
    const radius = special?.radius ?? 115;
    const rowRange = special?.rowRange ?? 1;
    const cx = plant.x + CELL_W / 2;
    const cy = plant.y + CELL_H / 2;
    for (const z of this.zombies) {
      if (z.state === 'die' || z.state === 'mowed') continue;
      if (Math.abs(z.row - plant.row) > rowRange) continue;
      if (Math.abs(z.x + 57 - cx) <= radius + 40) this.damageZombie(z, special?.damage ?? 1800);
    }
    this.explosions.push({ x: cx, y: cy, radius, timer: 24, max: 24 });
    if (this.plants[plant.row][plant.col] === plant) this.plants[plant.row][plant.col] = null;
    this.audio.sweep(320, 60, 0.4, 'sawtooth');
  }

  private checkLevelEnd(): void {
    if (this.state !== 'playing') return;
    const waves = this.level.waves ?? [];
    if (this.waveIndex < waves.length) return;
    const alive = this.zombies.some((z) => z.state !== 'die' && z.state !== 'mowed');
    if (alive) return;
    this.state = 'won';
    this.winTimer = 0;
    this.audio.playMusic('chooseyourseeds.ogg', 0.3);
  }

  private lose(): void {
    if (this.state === 'lost') return;
    this.state = 'lost';
    this.loseTimer = 0;
    this.audio.sweep(400, 80, 1.2, 'sawtooth');
    this.audio.stopMusic();
  }

  // -------------------------------------------------------------------- input
  pointerMove(x: number, y: number): void {
    this.hoverCell = this.cellAt(x, y);
  }

  cancelSelection(): void {
    this.selectedPacket = this.selectedCard = -1;
    this.shovelMode = false;
    this.ghost = null;
  }

  pointerDown(x: number, y: number): void {
    if (this.state === 'choosing') {
      const offers = this.loadout.seeds;
      const i = Math.floor((x - 140) / 100) + Math.floor((y - 180) / 125) * 7;
      if (x >= 140 && x < 840 && y >= 180 && y < 430 && i < offers.length && (x - 140) % 100 < 81 && (y - 180) % 125 < 106) {
        const seed = offers[i];
        const selected = this.chosenSeeds.indexOf(seed);
        if (selected >= 0) this.chosenSeeds.splice(selected, 1);
        else if (this.chosenSeeds.length < this.level.seedBank.numPackets) this.chosenSeeds.push(seed);
      }
      if (x >= 380 && x <= 620 && y >= 480 && y <= 540 && this.chosenSeeds.length === this.level.seedBank.numPackets) {
        this.packets = this.chosenSeeds.map(seed => {
          const def = this.assets.plants.get(seed)!;
          return { seed, def, cooldown: def.refreshTicks === 5000 ? 3500 : def.refreshTicks === 3000 ? 2000 : 0, maxCooldown: Math.max(1, def.refreshTicks) };
        });
        this.state = 'playing';
        this.audio.playMusic('day.ogg', 0.3);
      }
      return;
    }
    if (this.state === 'won' || this.state === 'lost') {
      if (this.winTimer > 60 || this.loseTimer > 60) this.callbacks.onNav('levelSelect');
      return;
    }
    if (x >= 262 && x < 348 && y >= 0 && y < 76) {
      this.shovelMode = !this.shovelMode;
      this.selectedPacket = -1;
      this.selectedCard = -1;
      this.ghost = null;
      return;
    }
    if (y < 50) {
      if (x >= 800 && x < 900) {
        this.callbacks.onExit();
        return;
      }
      if (x >= 755 && x < 800) {
        this.speedLevel = (this.speedLevel % 3) + 1;
        this.audio.blip(700, 0.05);
        return;
      }
      if (x >= 710 && x < 755) {
        if (this.state === 'paused') this.state = 'playing';
        else if (this.state === 'playing') this.state = 'paused';
        this.audio.blip(600, 0.05);
        return;
      }
    }
    if (this.state === 'paused') {
      this.state = 'playing';
      return;
    }
    // Sun tokens (click box: 43x43 expanded by 50 => centre +/- 71.5).
    for (const s of this.suns) {
      if (s.state === 'collect') continue;
      if (Math.abs(x - (s.x + BOARD_DX + 21.5)) <= 71.5 && Math.abs(y - (s.y + 21.5)) <= 71.5) {
        s.state = 'collect';
        this.audio.blip(980, 0.08, 'sine', 0.2);
        return;
      }
    }
    // Conveyor belt cards
    if (this.conveyor) {
      const idx = this.beltCardAt(x, y);
      if (idx >= 0) {
        const card = this.conveyor.cards[idx];
        const def = this.assets.plants.get(card.seed);
        if (def) {
          this.selectedCard = this.selectedCard === idx ? -1 : idx;
          this.selectedPacket = -1;
          this.ghost = this.selectedCard >= 0 ? this.buildGhost(def) : null;
          this.shovelMode = false;
          this.audio.blip(760, 0.05);
        }
        return;
      }
    } else if (x <= 82) {
      const idx = this.packetAt(y);
      if (idx >= 0) {
        const p = this.packets[idx];
        if (p.cooldown > 0) {
          this.setMessage('冷却中…', 90);
          return;
        }
        if (this.sun < p.def.sunCost) {
          this.setMessage('阳光不足！', 90);
          this.audio.blip(220, 0.1, 'square', 0.2);
          return;
        }
        this.selectedPacket = this.selectedPacket === idx ? -1 : idx;
        this.selectedCard = -1;
        this.ghost = this.selectedPacket >= 0 ? this.buildGhost(p.def) : null;
        this.shovelMode = false;
        this.audio.blip(760, 0.05);
        return;
      }
    }
    // Lawn: plant or shovel
    const cell = this.cellAt(x, y);
    if (cell) {
      if (this.shovelMode) {
        const plant = this.plantAt(cell.col, cell.row);
        if (plant) {
          this.plants[cell.row][cell.col] = null;
          this.audio.blip(420, 0.08, 'square', 0.2);
        }
        this.shovelMode = false;
        return;
      }
      if (this.selectedPacket >= 0) {
        this.tryPlantFromPacket(cell.col, cell.row);
      } else if (this.selectedCard >= 0) {
        this.tryPlantFromCard(cell.col, cell.row);
      }
    } else {
      this.selectedPacket = -1;
      this.selectedCard = -1;
      this.ghost = null;
    }
  }

  private buildGhost(def: PlantDef): { seed: string; spine: SpineChar | null; reanim: Reanim | null } {
    const visual = this.buildPlantVisual(def);
    return { seed: def.seedType, ...visual };
  }

  private packetAt(y: number): number {
    // SeedBank.MouseHitTest: closest packet centre within 104 px (not a strict
    // top..top+52 rectangle).
    const spacing = this.packetSpacing();
    let best = -1;
    let bestDist = Number.POSITIVE_INFINITY;
    for (let i = 0; i < this.packets.length; i++) {
      const center = 20 + i * spacing + 26;
      const dist = Math.abs(y - center);
      if (dist < bestDist) {
        bestDist = dist;
        best = i;
      }
    }
    return bestDist <= 104 ? best : -1;
  }

  private packetSpacing(): number {
    const n = this.packets.length;
    if (n <= 7) return 77;
    if (n === 8) return 71;
    if (n === 9) return 62;
    return 57;
  }

  private beltCardRect(i: number): { x: number; y: number; w: number; h: number } {
    return { x: 0, y: this.conveyor?.cards[i]?.y ?? 490, w: 81, h: 52 };
  }

  private beltCardAt(x: number, y: number): number {
    const belt = this.conveyor;
    if (!belt) return -1;
    if (y < 8 || y >= 473) return -1;
    for (let i = 0; i < belt.cards.length; i++) {
      const r = this.beltCardRect(i);
      if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return i;
    }
    return -1;
  }

  private tryPlantFromPacket(col: number, row: number): void {
    const packet = this.packets[this.selectedPacket];
    if (!packet) return;
    if (this.plantAt(col, row)) {
      this.setMessage('这里已经有植物了', 90);
      return;
    }
    if (this.sun < packet.def.sunCost) {
      this.setMessage('阳光不足！', 90);
      return;
    }
    this.sun -= packet.def.sunCost;
    packet.cooldown = packet.maxCooldown;
    this.addPlant(packet.def, col, row);
    this.selectedPacket = -1;
    this.ghost = null;
    this.audio.blip(520, 0.09, 'sine', 0.25);
  }

  private tryPlantFromCard(col: number, row: number): void {
    const belt = this.conveyor;
    if (!belt || this.selectedCard < 0 || this.selectedCard >= belt.cards.length) return;
    if (this.level.level === 5 && col > 2) {
      this.setMessage('请在红线左侧放下坚果', 120);
      return;
    }
    if (this.plantAt(col, row)) {
      this.setMessage('这里已经有植物了', 90);
      return;
    }
    const card = belt.cards[this.selectedCard];
    const def = this.assets.plants.get(card.seed);
    if (!def) return;
    this.addPlant(def, col, row);
    if (this.level.level === 5 && (card.seed === 'Wallnut' || card.seed === 'ExplodeONut')) {
      const plant = this.plants[row][col]!;
      this.plants[row][col] = null;
      plant.reanim?.play('_ground', 'loop', randFloat(12, 18));
      this.rollingNuts.push({ plant, direction: 0, targetRow: row });
    }
    belt.cards.splice(this.selectedCard, 1);
    this.selectedCard = -1;
    this.ghost = null;
    this.audio.blip(520, 0.09, 'sine', 0.25);
  }

  // --------------------------------------------------------------------- draw
  draw(ctx: CanvasRenderingContext2D): void {
    if (this.tickCount % 20 === 0) this.publishDebugState();
    ctx.clearRect(0, 0, LOGICAL_W, LOGICAL_H);
    if (this.bgImage) ctx.drawImage(this.bgImage, BG_X, BG_Y, this.bgWidth, this.bgHeight);
    else {
      ctx.fillStyle = '#4c8a2f';
      ctx.fillRect(0, 0, LOGICAL_W, LOGICAL_H);
    }
    if (this.level.level <= 3) {
      drawSprite(ctx, this.assets, 'IMAGE_SOD1ROW', BOARD_DX + 19, 265);
      if (this.level.level > 1) drawSprite(ctx, this.assets, 'IMAGE_SOD3ROW', BOARD_DX + 15, 149);
    }
    if (this.level.level === 5) {
      ctx.save();
      ctx.strokeStyle = '#b52b20'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(BOARD_DX + GRID_X + 3 * CELL_W, GRID_Y);
      ctx.lineTo(BOARD_DX + GRID_X + 3 * CELL_W, GRID_Y + ROWS * CELL_H); ctx.stroke();
      ctx.restore();
    }
    this.drawShadows(ctx);
    this.drawExplosions(ctx);
    for (let row = 0; row < ROWS; row++) {
      for (const m of this.mowers) if (m.row === row) this.drawMower(ctx, m);
      for (let col = COLS - 1; col >= 0; col--) {
        const p = this.plants[row][col];
        if (p) this.drawPlant(ctx, p);
      }
      for (const z of this.zombies) if (z.row === row) this.drawZombie(ctx, z);
      for (const nut of this.rollingNuts) if (nut.plant.row === row) {
        ctx.save();
        if (nut.plant.seed === 'ExplodeONut') ctx.filter = 'sepia(1) saturate(5) hue-rotate(320deg)';
        nut.plant.reanim?.draw(ctx, nut.plant.x + BOARD_DX, nut.plant.y);
        ctx.restore();
      }
      for (const pr of this.projectiles) if (pr.row === row) this.drawProjectile(ctx, pr);
    }
    for (const s of this.suns) this.drawSun(ctx, s);
    this.drawGhost(ctx);
    this.drawHud(ctx);
    this.drawOverlays(ctx);
  }

  private snapshot(): Record<string, unknown> {
    return {
      state: this.state,
      sun: this.sun,
      wave: this.waveIndex,
      waveCount: (this.level.waves ?? []).length,
      zombies: this.zombies.filter((z) => z.state !== 'die' && z.state !== 'mowed').length,
      plants: this.plants.flat().filter(Boolean).length,
      suns: this.suns.length,
      tick: this.tickCount,
      packets: this.conveyor ? this.conveyor.cards.map((c) => c.seed) : this.packets.map((p) => p.seed),
      mode: this.loadout.kind,
      rollingNuts: this.rollingNuts.length,
      chosenSeeds: this.chosenSeeds,
      speed: this.speedLevel,
      conveyor: this.conveyor ? this.conveyor.cards.map((c) => c.seed) : null,
      zombiesDetail: this.zombies.slice(0, 8).map((z) => ({ type: z.def.zombieType, row: z.row, x: Math.round(z.x), state: z.state, vaulted: z.vaulted, hp: z.hp, helm: z.helmHp })),
      plantList: this.plants.flat().filter((p): p is Plant => !!p).map((p) => ({ seed: p.seed, col: p.col, row: p.row, hp: p.hp, visual: p.spine ? 'spine' : p.reanim ? 'reanim' : 'none' })),
      mowers: this.mowers.map((m) => ({ row: m.row, state: m.state, x: Math.round(m.x) })),
    };
  }

  private publishDebugState(): void {
    const w = window as unknown as Record<string, unknown>;
    w.__SHOT_STATE__ = this.snapshot();
    // Always rebind: a new level creates a new Board instance.
    w.__getState = () => JSON.stringify(this.snapshot());
  }

  private drawShadows(ctx: CanvasRenderingContext2D): void {
    const shadow = this.assets.view('IMAGE_PLANTSHADOW');
    if (!shadow) return;
    const draw = (cx: number, cy: number, alpha: number) => {
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.drawImage(shadow.img, shadow.sx, shadow.sy, shadow.sw, shadow.sh, cx - shadow.dw / 2, cy - shadow.dh / 2, shadow.dw, shadow.dh);
      ctx.restore();
    };
    for (let row = 0; row < ROWS; row++) {
      for (let col = 0; col < COLS; col++) {
        const p = this.plants[row][col];
        if (!p) continue;
        draw(p.x + CELL_W / 2 - 3 + BOARD_DX, p.y + (p.spine ? 70 : 51), 0.5);
      }
    }
    for (const z of this.zombies) {
      if (z.state === 'die') continue;
      draw(z.x + 23 + BOARD_DX, z.y + 92, 0.45);
    }
  }

  private drawPlant(ctx: CanvasRenderingContext2D, plant: Plant): void {
    if (plant.spine) {
      const x = plant.x + BOARD_DX + CELL_W / 2;
      const y = plant.y + 70;
      const scale = this.spineScaleFor(plant.spine);
      if (plant.flash > 0) ctx.filter = 'brightness(1.6)';
      drawSpine(ctx, plant.spine, x, y, scale, false, 1);
      ctx.filter = 'none';
      return;
    }
    if (!plant.reanim) return;
    if (plant.flash > 0) {
      ctx.save();
      ctx.filter = 'brightness(1.6)';
      plant.reanim.draw(ctx, plant.x + BOARD_DX, plant.y, 1, 1, 1);
      ctx.restore();
    } else {
      plant.reanim.draw(ctx, plant.x + BOARD_DX, plant.y, 1, 1, 1);
    }
  }

  private spineScaleFor(char: SpineChar): number {
    // ReanimatorDefinition.ExtractImages: Constants.ISUI / mSpineScale.
    return this.spineTargetHeight > 0 ? char.scaleForHeight(this.spineTargetHeight) : 1.25 / 16;
  }

  private drawZombie(ctx: CanvasRenderingContext2D, z: Zombie): void {
    const rootX = z.x + BOARD_DX + 15;
    const rootY = z.y - 8;
    if (z.reanim) {
      z.reanim.hiddenPrefixes = z.hidden;
      if (z.flash > 0) ctx.filter = 'brightness(1.5)';
      if (z.chillTicks > 0) ctx.filter = 'brightness(0.85) sepia(0.6) hue-rotate(155deg) saturate(2)';
      z.reanim.draw(ctx, rootX, rootY, 1, 1, 1);
      ctx.filter = 'none';
    } else {
      ctx.fillStyle = '#789';
      ctx.fillRect(rootX - 20, rootY - 80, 40, 90);
    }
  }

  private drawProjectile(ctx: CanvasRenderingContext2D, p: Projectile): void {
    const id = p.kind === 'Snowpea' ? 'IMAGE_PROJECTILESNOWPEA' : 'IMAGE_PROJECTILEPEA';
    drawSpriteCentered(ctx, this.assets, id, p.x + BOARD_DX, p.y, 1, 1);
  }

  private drawSun(ctx: CanvasRenderingContext2D, s: SunToken): void {
    if (s.reanim) {
      s.reanim.draw(ctx, s.x + BOARD_DX + 21.5, s.y + 21.5, s.scale, s.scale);
      return;
    }
    ctx.save();
    ctx.fillStyle = '#ffd94a';
    ctx.beginPath();
    ctx.arc(s.x + BOARD_DX + 21.5, s.y + 21.5, 18 * s.scale, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  private drawMower(ctx: CanvasRenderingContext2D, m: Mower): void {
    if (m.state === 'gone' || !m.reanim) return;
    m.reanim.draw(ctx, m.x + BOARD_DX + 12, GRID_Y + m.row * CELL_H + 32, 0.8, 0.8, 1);
  }

  private drawExplosions(ctx: CanvasRenderingContext2D): void {
    for (const ex of this.explosions) {
      const t = 1 - ex.timer / ex.max;
      const r = ex.radius * (0.4 + t * 0.9);
      ctx.save();
      ctx.globalAlpha = Math.max(0, 1 - t) * 0.85;
      const grad = ctx.createRadialGradient(ex.x + BOARD_DX, ex.y, r * 0.2, ex.x + BOARD_DX, ex.y, r);
      grad.addColorStop(0, '#fff6c0');
      grad.addColorStop(0.5, '#ffb340');
      grad.addColorStop(1, 'rgba(200,40,0,0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(ex.x + BOARD_DX, ex.y, r, 0, Math.PI * 2);
      ctx.fill();
      const powie = this.assets.view('IMAGE_EXPLOSIONPOWIE');
      if (powie) ctx.drawImage(powie.img, powie.sx, powie.sy, powie.sw, powie.sh, ex.x + BOARD_DX - powie.dw / 2, ex.y - powie.dh / 2, powie.dw, powie.dh);
      ctx.restore();
    }
  }

  private drawGhost(ctx: CanvasRenderingContext2D): void {
    if (!this.ghost || !this.hoverCell) return;
    const { col, row } = this.hoverCell;
    const occupied = !!this.plantAt(col, row);
    ctx.save();
    ctx.globalAlpha = occupied ? 0.25 : 0.6;
    ctx.strokeStyle = occupied ? '#ff6b6b' : '#eaffb0';
    ctx.lineWidth = 2;
    ctx.strokeRect(GRID_X + col * CELL_W + BOARD_DX + 2, GRID_Y + row * CELL_H + 2, CELL_W - 4, CELL_H - 4);
    if (!occupied) {
      if (this.ghost.spine) {
        drawSpine(
          ctx,
          this.ghost.spine,
          GRID_X + col * CELL_W + BOARD_DX + CELL_W / 2,
          GRID_Y + row * CELL_H + 70,
          this.spineScaleFor(this.ghost.spine),
          false,
          0.65,
        );
      } else if (this.ghost.reanim) {
        this.ghost.reanim.draw(ctx, GRID_X + col * CELL_W + BOARD_DX, GRID_Y + row * CELL_H, 1, 1, 0.7);
      }
    }
    ctx.restore();
  }

  // ---------------------------------------------------------------------- HUD
  private drawHud(ctx: CanvasRenderingContext2D): void {
    if (this.conveyor) this.drawConveyor(ctx);
    else this.drawSeedBank(ctx);
    if (!this.conveyor) this.drawSunBank(ctx);
    this.drawFlagMeter(ctx);
    this.drawTopButtons(ctx);
    this.drawShovel(ctx);
    this.drawLevelBanner(ctx);
    this.drawMessage(ctx);
  }

  private packetCel(seed: string): number {
    const idx = this.assets.seedTypes.indexOf(seed);
    return idx >= 0 ? idx : 0;
  }

  private drawSeedPacketCard(ctx: CanvasRenderingContext2D, seed: string, x: number, y: number, scale = 1, alpha = 1): void {
    const view = this.assets.imageView('IMAGE_SEEDPACKETS', this.packetCel(seed));
    if (!view) return;
    ctx.save();
    ctx.globalAlpha = alpha;
    const w = view.dw * scale;
    const h = view.dh * scale;
    ctx.drawImage(view.img, view.sx, view.sy, view.sw, view.sh, x, y, w, h);
    const def = this.assets.plants.get(seed);
    if (def) {
      ctx.translate(x, y); ctx.scale(scale, scale);
      ctx.font = 'bold 12px LXGWWenKai, sans-serif';
      ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
      ctx.strokeStyle = '#e5eed1'; ctx.lineWidth = 1.5; ctx.fillStyle = '#171c13';
      const name = this.assets.string(def.displayNameKey, seed);
      ctx.strokeText(name, 4, 101, this.conveyor ? 72 : 51); ctx.fillText(name, 4, 101, this.conveyor ? 72 : 51);
      if (!this.conveyor) {
        ctx.font = 'bold 17px LXGWWenKai, sans-serif'; ctx.textAlign = 'right';
        ctx.strokeText(String(def.sunCost), 77, 101); ctx.fillText(String(def.sunCost), 77, 101);
      }
    }
    ctx.restore();
  }

  private drawSeedBank(ctx: CanvasRenderingContext2D): void {
    const spacing = this.packetSpacing();
    if (this.packets.length > 0) {
      ctx.save();
      const bottom = 20 + (this.packets.length - 1) * spacing + 52 + 12;
      ctx.fillStyle = 'rgba(16,22,11,0.62)';
      ctx.fillRect(0, 12, 86, bottom - 12);
      ctx.strokeStyle = 'rgba(180,210,120,0.35)';
      ctx.strokeRect(0.5, 12.5, 85, bottom - 13);
      ctx.restore();
    }
    for (let i = 0; i < this.packets.length; i++) {
      const packet = this.packets[i];
      const cardTop = 20 + i * spacing;
      const dy = cardTop - 53;
      this.drawSeedPacketCard(ctx, packet.seed, 0, dy, 1, this.sun < packet.def.sunCost ? 0.55 : 1);
      if (packet.cooldown > 0) {
        const frac = packet.cooldown / packet.maxCooldown;
        ctx.save();
        ctx.globalAlpha = 0.55;
        ctx.fillStyle = '#101010';
        ctx.fillRect(0, cardTop, 81, 52);
        ctx.globalAlpha = 0.9;
        ctx.fillStyle = 'rgba(255,255,255,0.5)';
        ctx.fillRect(0, cardTop + 52 * frac, 81, 52 * (1 - frac));
        ctx.restore();
      }
      if (this.selectedPacket === i) {
        ctx.save();
        ctx.strokeStyle = '#fff4b0';
        ctx.lineWidth = 2;
        ctx.strokeRect(1, cardTop - 51, 79, 104);
        ctx.restore();
      }
    }
  }

  private drawConveyor(ctx: CanvasRenderingContext2D): void {
    const belt = this.conveyor;
    if (!belt) return;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 8, 83, 465);
    ctx.clip();
    const texture = this.assets.imageView('IMAGE_CONVEYORBELT_BELT');
    if (texture) for (let y = -(Math.floor(this.tickCount / 4) % texture.dh); y < 600; y += texture.dh) {
      ctx.drawImage(texture.img, texture.sx, texture.sy, texture.sw, texture.sh, 0, y, texture.dw, texture.dh);
    }
    for (let i = 0; i < belt.cards.length; i++) {
      const card = belt.cards[i];
      const r = this.beltCardRect(i);
      this.drawSeedPacketCard(ctx, card.seed, r.x, r.y - 53);
      if (this.selectedCard === i) {
        ctx.save();
        ctx.strokeStyle = '#fff4b0';
        ctx.lineWidth = 3;
        ctx.strokeRect(r.x + 1, r.y, r.w - 2, r.h);
        ctx.restore();
      }
    }
    ctx.restore();
    const backdrop = this.assets.imageView('IMAGE_CONVEYORBELT_BACKDROP');
    if (backdrop) ctx.drawImage(backdrop.img, backdrop.sx, backdrop.sy, backdrop.sw, backdrop.sh, 0, 0, backdrop.dw, backdrop.dh);
  }

  private drawSunBank(ctx: CanvasRenderingContext2D): void {
    drawSprite(ctx, this.assets, 'IMAGE_DAN_SUNBANK', 119, 0, 1, 1);
    ctx.save();
    ctx.font = 'bold 26px LXGWWenKai, SourceHan, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#fdf3c0';
    ctx.strokeStyle = '#3a2408';
    ctx.lineWidth = 4;
    ctx.strokeText(String(this.sun), 211, 22);
    ctx.fillText(String(this.sun), 211, 22);
    ctx.restore();
  }

  private progressFraction(): number {
    const waves = this.level.waves ?? [];
    if (!waves.length) return 0;
    return Math.min(1, this.waveIndex / waves.length);
  }

  private drawFlagMeter(ctx: CanvasRenderingContext2D): void {
    if (this.waveIndex === 0 && this.hugeWaveTimer === 0) return;
    const meter = this.assets.view('IMAGE_FLAGMETER', 0);
    if (!meter) return;
    ctx.save();
    ctx.drawImage(meter.img, meter.sx, meter.sy, meter.sw, meter.sh, 450, 3, meter.dw, meter.dh);
    const p = this.progressFraction();
    // Spec: fill animates over 225 px, head over 220 px.
    const fill = Math.round(p * 225);
    const fillView = this.assets.view('IMAGE_FLAGMETER', 1);
    if (fill > 1 && fillView) {
      const srcW = (fill / 225) * fillView.sw;
      ctx.drawImage(
        fillView.img,
        fillView.sx + fillView.sw - srcW,
        fillView.sy,
        srcW,
        fillView.sh,
        680 - fill,
        3,
        fill,
        fillView.dh,
      );
    }
    const head = this.assets.view('IMAGE_FLAGMETERPARTS', Math.min(2, Math.round(p * 2)));
    if (head) {
      const headOffset = Math.round(p * 220);
      ctx.drawImage(head.img, head.sx, head.sy, head.sw, head.sh, 667 - headOffset, 0, head.dw, head.dh);
    }
    ctx.font = 'bold 20px Tiejili, LXGWWenKai, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#e0bb62';
    ctx.strokeStyle = '#2c1b08';
    ctx.lineWidth = 3;
    const label = `${Math.min(this.waveIndex, (this.level.waves ?? []).length)}/${(this.level.waves ?? []).length}`;
    ctx.strokeText(label, 568, 24);
    ctx.fillText(label, 568, 24);
    ctx.restore();
  }

  private drawTopButtons(ctx: CanvasRenderingContext2D): void {
    const buttons: Array<{ x: number; w: number; label: string }> = [
      { x: 710, w: 45, label: this.state === 'paused' ? '▶' : '⏸' },
      { x: 755, w: 45, label: `${this.speedLevel}x` },
      { x: 800, w: 100, label: '菜单' },
    ];
    ctx.save();
    for (const b of buttons) {
      for (const [id, x, w] of [['IMAGE_BUTTON_LEFT', b.x, 15], ['IMAGE_BUTTON_MIDDLE', b.x + 15, b.w - 30], ['IMAGE_BUTTON_RIGHT', b.x + b.w - 15, 15]] as const) {
        const v = this.assets.view(id);
        if (v) ctx.drawImage(v.img, v.sx, v.sy, v.sw, v.sh, x, 3, w, 45);
      }
      if (b.x < 800) {
        const id = b.x === 710 ? this.state === 'paused' ? 'IMAGE_ACCELERATION_01' : 'IMAGE_ACCELERATION_PAUSE' : `IMAGE_ACCELERATION_0${this.speedLevel}`;
        const v = this.assets.view(id);
        if (v) ctx.drawImage(v.img, v.sx, v.sy, v.sw, v.sh, b.x + (b.w - v.dw) / 2, 5 + (40 - v.dh) / 2, v.dw, v.dh);
        continue;
      }
      ctx.fillStyle = '#38de00';
      ctx.font = 'bold 20px LXGWWenKai, SourceHan, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.strokeStyle = '#111'; ctx.lineWidth = 3;
      ctx.strokeText(b.label, b.x + b.w / 2, 25); ctx.fillText(b.label, b.x + b.w / 2, 25);
    }
    ctx.restore();
  }

  private drawShovel(ctx: CanvasRenderingContext2D): void {
    // Classic shovel rail + icon (the mod also ships a "plantgirl shovel"
    // variant; the classic one is used here, spec §4.4).
    drawSprite(ctx, this.assets, 'IMAGE_SHOVELBANK', 262, 34, 1, 1);
    drawSprite(ctx, this.assets, 'IMAGE_SHOVEL', 270, 3, 1, 1);
    if (this.shovelMode) {
      ctx.save();
      ctx.strokeStyle = '#fff4b0';
      ctx.lineWidth = 3;
      ctx.strokeRect(266, 1, 82, 74);
      ctx.restore();
    }
  }

  private drawLevelBanner(ctx: CanvasRenderingContext2D): void {
    if (this.levelBannerTimer <= 0) return;
    const alpha = Math.min(1, this.levelBannerTimer / 15);
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.font = 'bold 24px Tiejili, SourceHan, sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#e0bb62';
    ctx.strokeStyle = '#2c1b08';
    ctx.lineWidth = 4;
    const text = `关卡 ${this.level.stage}`;
    ctx.strokeText(text, 891, 565);
    ctx.fillText(text, 891, 565);
    ctx.restore();
  }

  private drawMessage(ctx: CanvasRenderingContext2D): void {
    if (this.hugeWaveTimer > 0) {
      const alpha = Math.min(1, this.hugeWaveTimer / 60);
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.font = 'bold 42px Tiejili, SourceHan, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillStyle = '#ff5a4a';
      ctx.strokeStyle = '#2b0600';
      ctx.lineWidth = 6;
      ctx.strokeText('一大波僵尸正在接近！', LOGICAL_W / 2, 180);
      ctx.fillText('一大波僵尸正在接近！', LOGICAL_W / 2, 180);
      ctx.restore();
    }
    if (this.messageTimer <= 0 || !this.message) return;
    const alpha = Math.min(1, this.messageTimer / 40);
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.font = 'bold 24px LXGWWenKai, SourceHan, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const w = ctx.measureText(this.message).width + 48;
    ctx.fillStyle = 'rgba(12,18,8,0.72)';
    roundRect(ctx, LOGICAL_W / 2 - w / 2, 500, w, 44, 10);
    ctx.fill();
    ctx.fillStyle = '#ffe98a';
    ctx.fillText(this.message, LOGICAL_W / 2, 523);
    ctx.restore();
  }

  private drawOverlays(ctx: CanvasRenderingContext2D): void {
    if (this.state === 'choosing') {
      ctx.save();
      ctx.fillStyle = 'rgba(20,30,10,0.9)';
      roundRect(ctx, 110, 70, 780, 490, 15);
      ctx.fill();
      ctx.textAlign = 'center';
      ctx.fillStyle = '#fff0aa';
      ctx.font = 'bold 30px LXGWWenKai, sans-serif';
      ctx.fillText(`选择植物  ${this.chosenSeeds.length} / ${this.level.seedBank.numPackets}`, 500, 125);
      this.loadout.seeds.forEach((seed, i) => {
        const x = 140 + i % 7 * 100, y = 180 + Math.floor(i / 7) * 125;
        this.drawSeedPacketCard(ctx, seed, x, y);
        if (this.chosenSeeds.includes(seed)) {
          ctx.strokeStyle = '#ffe883'; ctx.lineWidth = 4;
          ctx.strokeRect(x, y, 81, 106);
        }
      });
      ctx.fillStyle = this.chosenSeeds.length === this.level.seedBank.numPackets ? '#62832c' : '#414833';
      roundRect(ctx, 380, 480, 240, 60, 9); ctx.fill();
      ctx.fillStyle = '#fff0aa'; ctx.fillText('开始战斗', 500, 520);
      ctx.restore();
      return;
    }
    if (this.state === 'paused') {
      ctx.save();
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      ctx.fillRect(0, 0, LOGICAL_W, LOGICAL_H);
      ctx.fillStyle = '#eaf3c6';
      ctx.font = 'bold 40px LXGWWenKai, SourceHan, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('已暂停', LOGICAL_W / 2, LOGICAL_H / 2 - 10);
      ctx.font = '20px LXGWWenKai, SourceHan, sans-serif';
      ctx.fillText('点击屏幕继续', LOGICAL_W / 2, LOGICAL_H / 2 + 36);
      ctx.restore();
      return;
    }
    if (this.state !== 'won' && this.state !== 'lost') return;
    const won = this.state === 'won';
    ctx.save();
    ctx.fillStyle = won ? 'rgba(10,30,10,0.62)' : 'rgba(30,4,4,0.7)';
    ctx.fillRect(0, 0, LOGICAL_W, LOGICAL_H);
    ctx.textAlign = 'center';
    ctx.font = 'bold 56px Tiejili, LXGWWenKai, sans-serif';
    ctx.fillStyle = won ? '#c8f06a' : '#ff7a6a';
    ctx.strokeStyle = '#241500';
    ctx.lineWidth = 7;
    const title = won ? '关卡通过！' : '僵尸吃掉了你的脑子…';
    ctx.strokeText(title, LOGICAL_W / 2, 240);
    ctx.fillText(title, LOGICAL_W / 2, 240);
    ctx.font = '24px LXGWWenKai, SourceHan, sans-serif';
    ctx.fillStyle = '#f2ecc8';
    ctx.fillText('点击返回关卡选择', LOGICAL_W / 2, 330);
    ctx.restore();
  }

  get acceleration(): number {
    return this.speedLevel;
  }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function randInt(min: number, max: number): number {
  return min + Math.floor(Math.random() * (max - min + 1));
}

function randFloat(min: number, max: number): number {
  return min + Math.random() * (max - min);
}
