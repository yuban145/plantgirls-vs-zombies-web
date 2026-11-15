/** Tiny audio helper: background music + a few synthesised UI/game blips. */

export class Audio {
  private music: HTMLAudioElement | null = null;
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  musicVolume = 0.35;
  sfxVolume = 0.5;
  enabled = true;

  /** Must be called from a user gesture to satisfy autoplay policies. */
  unlock(): void {
    if (!this.ctx) {
      const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (Ctor) {
        this.ctx = new Ctor();
        this.master = this.ctx.createGain();
        this.master.gain.value = this.sfxVolume;
        this.master.connect(this.ctx.destination);
      }
    }
    void this.ctx?.resume();
  }

  playMusic(file: string, volume = 0.35): void {
    if (!this.enabled) return;
    const url = `data/music/${file}`;
    if (this.music && this.music.src.endsWith(url)) return;
    this.stopMusic();
    const el = new window.Audio(url);
    el.loop = true;
    el.volume = volume;
    el.play().catch(() => undefined);
    this.music = el;
  }

  stopMusic(): void {
    if (this.music) {
      this.music.pause();
      this.music = null;
    }
  }

  /** Short synthesised tone (used for UI clicks / plant actions until SFX are extracted). */
  blip(freq = 660, duration = 0.07, type: OscillatorType = 'square', gain = 0.25): void {
    if (!this.enabled) return;
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    env.gain.setValueAtTime(gain, ctx.currentTime);
    env.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
    osc.connect(env);
    env.connect(this.master);
    osc.start();
    osc.stop(ctx.currentTime + duration + 0.01);
  }

  sweep(from: number, to: number, duration = 0.15, type: OscillatorType = 'sawtooth'): void {
    if (!this.enabled) return;
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(from, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, to), ctx.currentTime + duration);
    env.gain.setValueAtTime(0.18, ctx.currentTime);
    env.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
    osc.connect(env);
    env.connect(this.master);
    osc.start();
    osc.stop(ctx.currentTime + duration + 0.01);
  }
}
