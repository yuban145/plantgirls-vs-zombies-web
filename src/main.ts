/**
 * PlantGirlsVsZombies — Web port entry point.
 * The real boot sequence lives in boot.ts; this file only wires the canvas
 * and hands control to the game shell.
 */
import { boot } from './boot';

const canvas = document.getElementById('game') as HTMLCanvasElement;

boot(canvas).catch((err) => {
  console.error(err);
  const bootEl = document.getElementById('boot');
  const textEl = document.getElementById('boot-text');
  if (bootEl && textEl) {
    bootEl.classList.remove('hidden');
    textEl.className = 'err';
    textEl.textContent = `启动失败：\n${err instanceof Error ? err.stack || err.message : String(err)}`;
  }
});
