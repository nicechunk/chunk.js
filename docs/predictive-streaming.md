# Bounded predictive streaming

`ChunkManager.maxPredictivePreloadChunks` defaults to zero. With this option
enabled, `updatePlayerPosition` accepts `prefetchWorldX/prefetchWorldZ` and adds
a second preload square at the clamped forecast. The complete current square
and authoritative player center are retained. Forecast changes inside a column
can enqueue work; identity and range keys deduplicate stationary updates.

Nearby edits and current visible work retain priority over forecast work. The
existing bounded Worker pool dispatches independent columns concurrently.
Eviction retains a two-column hysteresis around the current/forecast union;
other columns enter the existing byte-limited, version/rule/pickup-checked cache.

The Play planner derives motion from actual player positions, smooths velocity
over 120 ms, and forecasts four seconds up to three columns. Stops, teleports,
long timing gaps and clock resets clear velocity. Camera rotation never invents
translation. Rendering distance, projection and geometry are unchanged.

`prepareChunksForRender` accepts `backgroundUploadBudget` with maxUploads,
maxBytes, maxCpuMs and intervalMs, plus `prefetchFocus`. Visible channels consume
the normal budget first. Background channels use only its remainder and have
additional count/byte/time limits. CPU deadlines are cooperative: a single GL
allocation or typed-array preparation cannot be preempted. Partial uploads use
the existing disjoint-slice transaction and validation-fence protocol.

`prefetchWithFrameInFlight` defaults to false. Play enables it to allow bounded
background transfers with one submitted frame, while retaining the two-frame
ceiling and quarantined frees. No fence is waited on synchronously. Unsupported
geometry, allocation failure, extension fallback and context restoration retain
the standalone path.

Play allows a 64 MiB shared pool, a 192 MiB background buffer admission threshold
and a 128 MiB CPU reuse cache. These are application budgets, not physical VRAM
measurements or the total browser-memory ceiling. Resident identities remain
bounded by range/hysteresis; cache entries are evicted by bytes. Chain snapshots
continue to be independently verified and applied through their existing
budgets. Prediction never substitutes locally generated data for chain authority.
