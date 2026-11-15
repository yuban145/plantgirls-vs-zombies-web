/**
 * Minimal boot shell: sizes the canvas to the window keeping the original
 * 1000x600 logical resolution, and exposes the canvas/context to the game.
 */
export const LOGICAL_WIDTH = 1000;
export const LOGICAL_HEIGHT = 600;

export interface Viewport {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  /** CSS pixels per logical unit (uniform). */
  scale: number;
  /** CSS offset of the logical canvas inside the window. */
  offsetX: number;
  offsetY: number;
  toLogical(clientX: number, clientY: number): { x: number; y: number };
}

export function createViewport(canvas: HTMLCanvasElement): Viewport {
  const ctx = canvas.getContext('2d', { alpha: false })!;
  const vp: Viewport = {
    canvas,
    ctx,
    scale: 1,
    offsetX: 0,
    offsetY: 0,
    toLogical(clientX, clientY) {
      const rect = canvas.getBoundingClientRect();
      return {
        x: (clientX - rect.left) / vp.scale,
        y: (clientY - rect.top) / vp.scale,
      };
    },
  };

  const resize = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const winW = window.innerWidth;
    const winH = window.innerHeight;
    const scale = Math.min(winW / LOGICAL_WIDTH, winH / LOGICAL_HEIGHT);
    const cssW = Math.round(LOGICAL_WIDTH * scale);
    const cssH = Math.round(LOGICAL_HEIGHT * scale);
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;
    // Backing store: logical resolution * devicePixelRatio-capped scale so the
    // art stays crisp on hidpi screens without exploding fill rate.
    canvas.width = Math.round(LOGICAL_WIDTH * Math.min(scale * dpr, 2));
    canvas.height = Math.round(LOGICAL_HEIGHT * Math.min(scale * dpr, 2));
    vp.scale = scale;
    canvas.dataset.renderScale = String(Math.min(scale * dpr, 2));
  };
  window.addEventListener('resize', resize);
  resize();
  return vp;
}

export async function boot(canvas: HTMLCanvasElement): Promise<void> {
  const viewport = createViewport(canvas);
  const { GameShell } = await import('./shell');
  const shell = new GameShell(viewport);
  await shell.start();
  const bootEl = document.getElementById('boot');
  bootEl?.classList.add('hidden');
}
