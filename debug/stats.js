export class FrameStatsCounter {
  constructor({ sampleMs = 500 } = {}) {
    this.sampleMs = sampleMs;
    this.frames = 0;
    this.lastSampleTime = 0;
    this.fps = 0;
    this.sampleCount = 0;
  }

  reset(now = performance.now()) {
    this.frames = 0;
    this.lastSampleTime = now;
    this.fps = 0;
    this.sampleCount = 0;
  }

  frame(now = performance.now(), extra = {}) {
    if (!this.lastSampleTime) this.lastSampleTime = now;
    if (!extra.renderDeferred) this.frames += 1;
    const elapsed = now - this.lastSampleTime;
    if (elapsed < this.sampleMs) return null;
    this.fps = Math.round((this.frames * 1000) / elapsed);
    this.sampleCount += 1;
    this.frames = 0;
    this.lastSampleTime = now;
    return { fps: this.fps, ...extra };
  }
}

// Bounded distributions for CPU stages. GPU times must come from AsyncGpuTimer,
// never from these wall-clock samples. External schedulers may record their own
// delta/apply/build/pack work without adding per-voxel logging.
export class RenderStageStats {
  constructor({capacity=512}={}) {this.capacity=Math.max(16,Math.trunc(capacity));this.stages=new Map();}
  record(stage,ms){if(!Number.isFinite(ms)||ms<0)return;let values=this.stages.get(stage);if(!values){if(this.stages.size>=32)return;values=[];this.stages.set(stage,values);}values.push(ms);if(values.length>this.capacity)values.shift();}
  snapshot(){const result={};for(const [stage,values]of this.stages){const sorted=[...values].sort((a,b)=>a-b),at=q=>sorted[Math.min(sorted.length-1,Math.floor(sorted.length*q))];result[stage]={samples:values.length,p50:at(.5),p95:at(.95),p99:at(.99)};}return result;}
  reset(){this.stages.clear();}
}
