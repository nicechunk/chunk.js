# Benchmarks

Use this directory for repeatable performance probes. Early benchmark targets should measure:

- CPU mesh build time.
- GPU upload size.
- Draw call count.
- Frame time on mobile browsers.
- Memory growth after chunk streaming.

Run the deterministic building parser/mesher probe with:

```sh
node --expose-gc chunk.js/benchmarks/building-mesher.mjs 5
```

The JSON report includes median parse, placement, mesh, synchronous event-loop
blocking, heap growth, GPU vertex/index bytes, quad count, and Chunk count for
dense, hollow, and mixed-material NCM3 structures.
