import { createChunkEngine } from "../../src/index.js";

const canvas = document.querySelector("#engineCanvas");
const engine = await createChunkEngine({
  backend: "webgl2",
  canvas,
  onStats: (stats) => console.debug("chunk.js stats", stats),
});

if (engine.supported) engine.start();
