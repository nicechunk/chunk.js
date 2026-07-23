# Performance Budget

This document separates code defaults from measurement targets. A default is observable configuration; it is not a frame-rate guarantee.

## Current defaults

| Area | Default | Notes |
| --- | ---: | --- |
| Core `ChunkManager` view distance | 5 chunks | High-level `createChunkEngine()` overrides this to 3 |
| Core mesh rebuild budget | 5 ms | High-level engine defaults to 6 ms |
| Coarse-pointer DPR ceiling | 1.25 | Renderer minimum clamp is 0.75 |
| Desktop DPR ceiling | 1.75 | Can be overridden explicitly |
| Region batching | enabled | Opaque and visual chunks are grouped 4 by 4 |
| Chunk uploads per frame | 3 coarse / 8 other | Capability heuristic, not measured hardware class |
| Voxel particles | 320 | Upper runtime pool size |
| Worker count | up to 3 coarse / 6 other | Derived from `hardwareConcurrency`; initial active build limit is 1 |
| Maximum queued builds | 768 | Manager guard, not a target queue depth |
| Packed terrain vertex | 20 bytes | Position quantization is 1/64 world unit |

Read the checked-out source before relying on a default; this project is pre-1.0.

## Frame-work policy

- Rebuild only dirty chunks.
- Schedule chunk generation and meshing through module Workers when available.
- Bound active builds and GPU uploads instead of draining all queues in one frame.
- Prioritize nearby chunks and bias loading toward movement/view direction.
- Keep authoritative coordinates integer; convert to camera-relative floats only at render time.
- Upload a mesh only when its committed mesh revision changes.
- Use separate opaque and visual meshes so water/decoration work remains controlled.
- Batch chunks into regions when movement and upload policy permit.

Region batching means the old “one opaque draw call per visible chunk” model is not the default. A region can cover up to 16 chunks, but actual draw calls also include visual regions, avatars, buildings, sky/cloud/sun, shadows, overlays, particles, incomplete regions, and fallback per-chunk buffers.

## Metrics to record

At minimum, record:

- frame time distribution, not only average FPS;
- visible, loaded, queued, in-flight, and ready chunks;
- opaque and visual triangles/vertices;
- draw calls by pass where available;
- GPU buffer bytes and uploaded chunks/regions;
- chunk generation, opaque mesh, visual mesh, queue wait, and upload time;
- Worker count, retry/fallback events, and main-thread build time;
- canvas dimensions and effective DPR;
- context-loss or out-of-memory events.

## Measurement protocol

Every reported baseline should include:

- commit;
- route and query parameters;
- browser or Node version;
- OS, CPU, memory, GPU, and driver;
- viewport, DPR, input device classification, and power state;
- world seed, spawn, view distance, and mesh budget;
- warm-up duration and sample duration;
- whether developer tools, throttling, or headless mode was active.

Without that context, a number is an observation, not a regression threshold.

## Repository benchmark

Run the building mesher benchmark from the repository root:

```bash
node --expose-gc benchmarks/building-mesher.mjs 5
```

The numeric argument is the iteration count. This benchmark measures one CPU subsystem and does not predict browser frame rate, upload cost, GPU time, or host RPC latency.

## Release budgets

The repository does not currently publish a universal FPS or memory guarantee. A release may define route/device-specific thresholds only after a reproducible baseline exists in CI or a recorded device lab.

Until then, use these qualitative gates:

- no unbounded queue or buffer growth during sustained travel;
- no Worker retained after owning lifecycle teardown;
- no full-world remesh for one local delta;
- no routine multi-frame stall caused by draining the entire upload/build queue;
- no silent Worker failure that changes result shape;
- no context restoration that reuses invalid WebGL handles;
- no visual-detail fallback that changes authoritative world/resource output.

## Tuning order

When a target device misses its budget:

1. confirm correct production/minified delivery is not the issue—Chunk.js itself is native ESM and may be served unbundled;
2. lower view distance and upload/build concurrency;
3. inspect queue wait, mesh, and upload timings separately;
4. reduce DPR or optional visual passes before changing authoritative data;
5. verify region batching and visibility pruning are operating;
6. profile allocations and transferred buffers;
7. record the before/after environment and add a regression case.

Never change deterministic generation, resource lookup, or PDA-governed rules solely to improve renderer performance without a versioned protocol decision.
