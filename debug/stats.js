export class FrameStatsCounter {
  constructor({ sampleMs = 500 } = {}) {
    this.sampleMs = sampleMs;
    this.frames = 0;
    this.lastSampleTime = 0;
    this.fps = 0;
  }

  reset(now = performance.now()) {
    this.frames = 0;
    this.lastSampleTime = now;
    this.fps = 0;
  }

  frame(now = performance.now(), extra = {}) {
    if (!this.lastSampleTime) this.lastSampleTime = now;
    this.frames += 1;
    const elapsed = now - this.lastSampleTime;
    if (elapsed < this.sampleMs) return null;
    this.fps = Math.round((this.frames * 1000) / elapsed);
    this.frames = 0;
    this.lastSampleTime = now;
    return { fps: this.fps, ...extra };
  }
}
