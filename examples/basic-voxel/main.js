import { createChunkEngine } from "../../engine/create-chunk-engine.js";

const canvas = document.querySelector("#engineCanvas");
const engine = await createChunkEngine({
  canvas,
  onStats: (stats) => console.debug("chunk.js stats", stats),
});

addEventListener("pagehide", () => engine.destroy(), { once: true });

if (engine.supported) {
  engine.start();
} else {
  console.error(engine.support.label || engine.support.reason || "WebGL2 is unavailable.");
}
