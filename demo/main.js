import { createChunkEngine, detectWebGl2Support } from "../src/index.js";

const text = {
  status: {
    checking: "Checking",
    pending: "Pending",
    booting: "Booting",
    failed: "Failed",
    unavailable: "Unavailable",
    noDevice: "No WebGL2 device",
    requestingDevice: "Creating WebGL2 renderer",
    ready: "Ready",
    running: "Running",
    paused: "Paused",
    fps: (fps) => `${fps} FPS`,
    mesh: ({ blocks, vertices, indices }) => `${blocks} blocks · ${vertices} vertices · ${indices} indices`,
  },
  actions: {
    pause: "Pause",
    resume: "Resume",
  },
  log: {
    booting: "Booting isolated Chunk.js WebGL2 voxel renderer.",
    failed: (message) => `Engine failed: ${message}`,
    unsupported: (reason) => `WebGL2 unavailable: ${reason}`,
    ready: "WebGL2 renderer ready. Integer-packed voxel mesh uploaded.",
    cameraReset: "Camera reset.",
  },
};

const elements = {
  canvas: document.querySelector("#engineCanvas"),
  adapterStatus: document.querySelector("#adapterStatus"),
  deviceStatus: document.querySelector("#deviceStatus"),
  frameStatus: document.querySelector("#frameStatus"),
  modeStatus: document.querySelector("#modeStatus"),
  log: document.querySelector("#engineLog"),
  pauseButton: document.querySelector("#pauseButton"),
  resetButton: document.querySelector("#resetButton"),
};

const state = {
  engine: null,
  paused: false,
};

setStatus("adapterStatus", text.status.checking);
setStatus("deviceStatus", text.status.pending);
setStatus("frameStatus", "0 FPS");
setStatus("modeStatus", text.status.booting);
writeLog(text.log.booting);

boot().catch((error) => {
  console.error(error);
  setStatus("modeStatus", text.status.failed);
  writeLog(text.log.failed(error?.message || String(error)));
});

async function boot() {
  const support = detectWebGl2Support();
  if (!support.supported) {
    setStatus("adapterStatus", text.status.unavailable);
    setStatus("deviceStatus", support.reason || text.status.noDevice);
    setStatus("modeStatus", text.status.failed);
    writeLog(text.log.unsupported(support.label || support.reason));
    return;
  }

  setStatus("adapterStatus", adapterLabel(support));
  setStatus("deviceStatus", text.status.requestingDevice);
  state.engine = await createChunkEngine({
    backend: "webgl2",
    canvas: elements.canvas,
    onStats: updateStats,
    onStatus: updateEngineStatus,
  });

  if (!state.engine.supported) return;
  setStatus("deviceStatus", text.status.ready);
  state.engine.start();
  bindControls();
  writeLog(text.log.ready);
}

function bindControls() {
  elements.pauseButton?.addEventListener("click", () => {
    state.paused = !state.paused;
    state.engine?.setPaused(state.paused);
    elements.pauseButton.textContent = state.paused ? text.actions.resume : text.actions.pause;
  });
  elements.resetButton?.addEventListener("click", () => {
    state.engine?.resetCamera();
    writeLog(text.log.cameraReset);
  });
}

function updateStats(stats) {
  setStatus("frameStatus", text.status.fps(stats.fps));
  setStatus("modeStatus", text.status.mesh(stats));
}

function updateEngineStatus(event) {
  if (event.stage === "running") setStatus("deviceStatus", text.status.running);
  if (event.stage === "paused") setStatus("deviceStatus", text.status.paused);
}

function adapterLabel(support) {
  return support.renderer && support.renderer !== "unknown" ? support.renderer : "WebGL2 ready";
}

function setStatus(key, value) {
  const element = elements[key];
  if (element) element.textContent = value;
}

function writeLog(message) {
  if (!elements.log) return;
  const row = document.createElement("li");
  row.textContent = message;
  elements.log.prepend(row);
  while (elements.log.children.length > 8) elements.log.lastElementChild?.remove();
}
