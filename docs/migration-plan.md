# Migration Plan

1. Keep Chunk.js isolated under `/chunk.js/` until renderer boundaries are stable.
2. Feed Chunk.js and the current game from the same integer world/chunk data during transition.
3. Validate chunk meshing, pending deltas, rollback, raycast, and block inspector before replacing terrain display.
4. Add transparent/fluid and decoration passes only after opaque terrain is stable on mobile.
5. Connect Solana PDA reads to `chainDeltas` and local transaction previews to `pendingDeltas`.
6. Replace the current terrain rendering path only after visual parity, mobile stability, and interaction tests pass.
