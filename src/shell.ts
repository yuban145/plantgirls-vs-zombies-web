/** Game shell: asset loading, scene switching, fixed 100 Hz loop. */
import type { Viewport } from './boot';
import { LOGICAL_HEIGHT, LOGICAL_WIDTH } from './boot';
import { Assets } from './assets';
import { Audio } from './audio';
import { Board } from './game/board';
import { Menu } from './scenes/menu';

const TICK = 1 / 100;
const MAX_ACCUM = 0.25;

export class GameShell {
  private viewport: Viewport;
  private assets = new Assets();
  private audio = new Audio();
  private menu: Menu | null = null;
  private board: Board | null = null;
  private loading = 0;
  private loadingLabel = '初始化…';
  private lastTime = 0;
  private accumulator = 0;
  private raf = 0;
  private renderScale = 1;
  private startingLevel = -1;
  private levelLoading = false;

  constructor(viewport: Viewport) {
    this.viewport = viewport;
  }

  async start(): Promise<void> {
    const params = new URLSearchParams(location.search);
    const startLevel = params.get('level');
    const autostart = params.get('autostart');

    await this.assets.load((f, label) => {
      this.loading = f;
      this.loadingLabel = label;
      this.paintLoading();
    });

    this.menu = new Menu(this.assets);
    if (startLevel) this.startingLevel = Number(startLevel) - 1;

    this.bindInput();
    this.lastTime = performance.now() / 1000;
    const loop = () => {
      this.raf = requestAnimationFrame(loop);
      this.frame();
    };
    this.raf = requestAnimationFrame(loop);

    if (autostart === '1' && this.startingLevel >= 0) {
      await this.startLevel(this.startingLevel);
    }
  }

  private paintLoading(): void {
    const ctx = this.viewport.ctx;
    this.applyScale();
    ctx.fillStyle = '#0b1106';
    ctx.fillRect(0, 0, LOGICAL_WIDTH, LOGICAL_HEIGHT);
    ctx.fillStyle = '#b8dc5a';
    ctx.font = '22px LXGWWenKai, SourceHan, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('正在加载资源…', LOGICAL_WIDTH / 2, LOGICAL_HEIGHT / 2 - 30);
    ctx.fillStyle = 'rgba(180,220,90,0.2)';
    ctx.fillRect(LOGICAL_WIDTH / 2 - 200, LOGICAL_HEIGHT / 2 + 10, 400, 14);
    ctx.fillStyle = '#b8dc5a';
    ctx.fillRect(LOGICAL_WIDTH / 2 - 200, LOGICAL_HEIGHT / 2 + 10, 400 * this.loading, 14);
    ctx.fillStyle = 'rgba(220,235,190,0.7)';
    ctx.font = '15px LXGWWenKai, SourceHan, sans-serif';
    ctx.fillText(this.loadingLabel, LOGICAL_WIDTH / 2, LOGICAL_HEIGHT / 2 + 60);
  }

  private applyScale(): void {
    const ctx = this.viewport.ctx;
    this.renderScale = this.viewport.canvas.width / LOGICAL_WIDTH;
    ctx.setTransform(this.renderScale, 0, 0, this.renderScale, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
  }

  private bindInput(): void {
    const canvas = this.viewport.canvas;
    const toLogical = (ev: PointerEvent) => this.viewport.toLogical(ev.clientX, ev.clientY);
    canvas.addEventListener('pointerdown', (ev) => {
      this.audio.unlock();
      if (ev.button === 2) { this.board?.cancelSelection(); return; }
      if (ev.button !== 0) return;
      const p = toLogical(ev);
      void this.handlePointerDown(p.x, p.y);
    });
    canvas.addEventListener('pointermove', (ev) => {
      const p = toLogical(ev);
      if (this.menu) this.menu.pointerMove(p.x, p.y);
      this.board?.pointerMove(p.x, p.y);
    });
    canvas.addEventListener('contextmenu', (ev) => ev.preventDefault());
    window.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') {
        if (this.board) this.toLevelSelect();
      }
    });
    document.addEventListener('visibilitychange', () => {
      this.lastTime = performance.now() / 1000;
      this.accumulator = 0;
    });
  }

  private async handlePointerDown(x: number, y: number): Promise<void> {
    if (this.levelLoading) return;
    if (this.board) {
      this.board.pointerDown(x, y);
      return;
    }
    if (!this.menu) return;
    const action = this.menu.pointerDown(x, y);
    if (action.type === 'start') {
      await this.startLevel(action.levelIndex);
    }
  }

  private async startLevel(levelIndex: number): Promise<void> {
    const level = this.assets.levels[levelIndex];
    if (!level) return;
    this.levelLoading = true;
    this.loading = 0;
    this.loadingLabel = '加载关卡动画…';
    this.paintLoading();
    const board = await Board.create(
      this.assets,
      this.audio,
      level,
      levelIndex,
      {
        onExit: () => this.toMenu(),
        onNav: () => this.toLevelSelect(),
      },
      (f) => {
        this.loading = f;
        this.loadingLabel = `加载关卡动画… ${Math.round(f * 100)}%`;
        this.paintLoading();
      },
    );
    this.menu = null;
    this.board = board;
    this.levelLoading = false;
    this.lastTime = performance.now() / 1000;
    this.accumulator = 0;
    (window as unknown as Record<string, unknown>).__game = this;
    (window as unknown as Record<string, unknown>).__board = board;
    this.audio.playMusic(level.level === 5 ? 'loonboon.ogg' : board.state === 'choosing' ? 'chooseyourseeds.ogg' : 'day.ogg', 0.3);
    this.audio.unlock();
    this.audio.blip(620, 0.12, 'sine', 0.3);
  }

  private clearDebugGlobals(): void {
    const w = window as unknown as Record<string, unknown>;
    delete w.__board;
    delete w.__SHOT_STATE__;
    delete w.__getState;
  }

  private toMenu(): void {
    this.board = null;
    this.clearDebugGlobals();
    this.menu = new Menu(this.assets);
    this.menu.tabs = 'main';
    this.audio.playMusic('chooseyourseeds.ogg', 0.28);
  }

  private toLevelSelect(): void {
    this.board = null;
    this.clearDebugGlobals();
    this.menu = new Menu(this.assets);
    this.menu.tabs = 'levels';
    this.audio.playMusic('chooseyourseeds.ogg', 0.28);
  }

  private frame(): void {
    const now = performance.now() / 1000;
    let dt = now - this.lastTime;
    this.lastTime = now;
    if (document.hidden) return;
    if (dt > MAX_ACCUM) dt = MAX_ACCUM;
    this.applyScale();
    if (this.levelLoading) { this.paintLoading(); return; }

    if (this.board) {
      const accel = this.board.acceleration;
      this.accumulator += dt * accel;
      let steps = 0;
      while (this.accumulator >= TICK && steps < 75) {
        this.board.update();
        this.accumulator -= TICK;
        steps++;
      }
      this.board.draw(this.viewport.ctx);
    } else if (this.menu) {
      this.menu.update(dt);
      this.menu.draw(this.viewport.ctx);
    }
  }
}

void LOGICAL_HEIGHT;
