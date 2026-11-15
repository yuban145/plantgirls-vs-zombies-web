/** Title + level-select scenes. */
import type { Assets } from '../assets';
import { LOGICAL_H, LOGICAL_W } from '../game/board';

export type MenuAction = { type: 'start'; levelIndex: number } | { type: 'none' };

interface Button {
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
  sub?: string;
}

export class Menu {
  private assets: Assets;
  tabs: 'main' | 'levels' | 'help' = 'main';
  private hover: { x: number; y: number } = { x: -1, y: -1 };
  private buttons: Button[] = [];
  private time = 0;

  constructor(assets: Assets) {
    this.assets = assets;
  }

  update(dt: number): void {
    this.time += dt;
  }

  draw(ctx: CanvasRenderingContext2D): void {
    const bg = this.assets.image('IMAGE_SELECTORSCREEN_MAIN_BACKGROUND');
    if (bg) {
      ctx.drawImage(bg.img, -200, 0, bg.info.logicalW, bg.info.logicalH);
    } else {
      ctx.fillStyle = '#2b4d1a';
      ctx.fillRect(0, 0, LOGICAL_W, LOGICAL_H);
    }
    ctx.save();
    ctx.fillStyle = 'rgba(8,14,6,0.55)';
    ctx.fillRect(0, 0, LOGICAL_W, LOGICAL_H);
    ctx.restore();

    // Title
    ctx.save();
    ctx.textAlign = 'center';
    ctx.font = 'bold 66px Tiejili, SourceHan, sans-serif';
    ctx.strokeStyle = '#20300a';
    ctx.lineWidth = 10;
    ctx.fillStyle = '#d9f06e';
    const bob = Math.sin(this.time * 1.6) * 4;
    ctx.strokeText('植物娘大战僵尸', LOGICAL_W / 2, 158 + bob);
    ctx.fillText('植物娘大战僵尸', LOGICAL_W / 2, 158 + bob);
    ctx.font = 'bold 24px LXGWWenKai, SourceHan, sans-serif';
    ctx.fillStyle = '#f0e7be';
    ctx.strokeStyle = '#1c260c';
    ctx.lineWidth = 5;
    ctx.strokeText('网页移植版 · Web Port', LOGICAL_W / 2, 200 + bob);
    ctx.fillText('网页移植版 · Web Port', LOGICAL_W / 2, 200 + bob);
    ctx.font = 'bold 18px LXGWWenKai, SourceHan, sans-serif';
    ctx.fillText('原作者：庄不纯', LOGICAL_W / 2, 232);
    ctx.restore();

    this.buttons = [];
    if (this.tabs === 'main') this.drawMain(ctx);
    else if (this.tabs === 'levels') this.drawLevels(ctx);
    else this.drawHelp(ctx);
  }

  private drawHelp(ctx: CanvasRenderingContext2D): void {
    ctx.save();
    ctx.fillStyle = 'rgba(10,20,6,0.85)';
    ctx.fillRect(200, 260, 600, 250);
    ctx.fillStyle = '#fff0c0'; ctx.font = '24px LXGWWenKai, sans-serif'; ctx.textAlign = 'center';
    ['点击左侧卡片，再点击草坪种植', '点击阳光收集，等待卡片冷却', '铲子移除植物，右键取消选择', '1-5：红线左侧放坚果，滚动撞击僵尸', '顶部按钮暂停、倍速或返回菜单'].forEach((text, i) => ctx.fillText(text, 500, 300 + i * 43));
    ctx.restore();
    const back: Button = { x: 40, y: LOGICAL_H - 72, w: 160, h: 48, label: '返回' };
    this.buttons.push(back); this.drawButton(ctx, back);
  }

  private drawMain(ctx: CanvasRenderingContext2D): void {
    const b: Button = { x: LOGICAL_W / 2 - 150, y: 300, w: 300, h: 76, label: '开始冒险', sub: 'Adventure' };
    this.buttons.push(b);
    this.drawButton(ctx, b);
    const b2: Button = { x: LOGICAL_W / 2 - 150, y: 396, w: 300, h: 56, label: '操作说明', sub: '如何游玩' };
    this.buttons.push(b2);
    this.drawButton(ctx, b2);
    ctx.save();
    ctx.textAlign = 'center';
    ctx.font = '16px LXGWWenKai, SourceHan, sans-serif';
    ctx.fillStyle = 'rgba(240,240,210,0.72)';
    ctx.fillText('素材与数值提取自原版游戏 · 点击按钮开始', LOGICAL_W / 2, LOGICAL_H - 34);
    ctx.restore();
  }

  private drawLevels(ctx: CanvasRenderingContext2D): void {
    ctx.save();
    ctx.textAlign = 'center';
    ctx.font = 'bold 38px Tiejili, SourceHan, sans-serif';
    ctx.fillStyle = '#d9f06e';
    ctx.strokeStyle = '#1c260c';
    ctx.lineWidth = 6;
    ctx.strokeText('选择关卡', LOGICAL_W / 2, 268);
    ctx.fillText('选择关卡', LOGICAL_W / 2, 268);
    ctx.restore();

    const cols = 5;
    const bw = 150;
    const bh = 66;
    const gap = 16;
    const startX = (LOGICAL_W - (cols * bw + (cols - 1) * gap)) / 2;
    const levels = this.assets.levels;
    levels.forEach((lvl, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const b: Button = {
        x: startX + col * (bw + gap),
        y: 320 + row * (bh + gap),
        w: bw,
        h: bh,
        label: lvl.stage,
        sub: lvl.waves.length ? `${lvl.waves.length} 波` : '',
      };
      this.buttons.push(b);
      this.drawButton(ctx, b);
    });
    const back: Button = { x: 40, y: LOGICAL_H - 72, w: 160, h: 48, label: '返回' };
    this.buttons.push(back);
    this.drawButton(ctx, back);
  }

  private drawButton(ctx: CanvasRenderingContext2D, b: Button): void {
    const hovered =
      this.hover.x >= b.x && this.hover.x <= b.x + b.w && this.hover.y >= b.y && this.hover.y <= b.y + b.h;
    ctx.save();
    const grad = ctx.createLinearGradient(0, b.y, 0, b.y + b.h);
    grad.addColorStop(0, hovered ? '#4b6a25' : '#33481b');
    grad.addColorStop(1, hovered ? '#2c4216' : '#1e2b0f');
    ctx.fillStyle = grad;
    ctx.strokeStyle = hovered ? '#e6ff9c' : 'rgba(190,220,120,0.55)';
    ctx.lineWidth = hovered ? 3 : 2;
    const r = 12;
    ctx.beginPath();
    ctx.moveTo(b.x + r, b.y);
    ctx.lineTo(b.x + b.w - r, b.y);
    ctx.quadraticCurveTo(b.x + b.w, b.y, b.x + b.w, b.y + r);
    ctx.lineTo(b.x + b.w, b.y + b.h - r);
    ctx.quadraticCurveTo(b.x + b.w, b.y + b.h, b.x + b.w - r, b.y + b.h);
    ctx.lineTo(b.x + r, b.y + b.h);
    ctx.quadraticCurveTo(b.x, b.y + b.h, b.x, b.y + b.h - r);
    ctx.lineTo(b.x, b.y + r);
    ctx.quadraticCurveTo(b.x, b.y, b.x + r, b.y);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = hovered ? '#f4ffd0' : '#e0f0b4';
    ctx.font = `bold ${b.sub ? 30 : 26}px LXGWWenKai, SourceHan, sans-serif`;
    ctx.fillText(b.label, b.x + b.w / 2, b.y + b.h / 2 - (b.sub ? 8 : 0));
    if (b.sub) {
      ctx.font = '15px LXGWWenKai, SourceHan, sans-serif';
      ctx.fillStyle = 'rgba(220,235,180,0.75)';
      ctx.fillText(b.sub, b.x + b.w / 2, b.y + b.h / 2 + 15);
    }
    ctx.restore();
  }

  pointerMove(x: number, y: number): void {
    this.hover = { x, y };
  }

  pointerDown(x: number, y: number): MenuAction {
    this.hover = { x, y };
    for (const b of this.buttons) {
      if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) {
        if (b.label === '开始冒险') this.tabs = 'levels';
        else if (b.label === '返回') this.tabs = 'main';
        else if (/^\d+-\d+$/.test(b.label)) {
          const idx = this.assets.levels.findIndex((l) => l.stage === b.label);
          if (idx >= 0) return { type: 'start', levelIndex: idx };
        } else if (b.label === '操作说明') {
          this.tabs = 'help';
        }
        return { type: 'none' };
      }
    }
    return { type: 'none' };
  }
}
