import {
  createBuildingPlacement,
  parseNcm3Building,
} from "./building-parser.js";
import { createBuildingChunkMeshes } from "./building-mesher.js";
import {
  createBuildingMeshResult,
  validateBuildingMeshResult,
} from "./building-mesh-result.js";
import {
  NCM3_MAX_PAYLOAD_BYTES,
  NCM3_PREFIX,
} from "../ncm/blueprint-codec.js";

const MAX_BUILDING_REQUEST_CODE_LENGTH = NCM3_PREFIX.length + Math.ceil(NCM3_MAX_PAYLOAD_BYTES * 4 / 3);
const MAX_BUILDING_REQUEST_LABEL_LENGTH = 1_024;

export function createBuildingMeshWorkerClient({
  useWorker = true,
  workerFactory = null,
} = {}) {
  let worker = null;
  let workerUnavailable = !useWorker || (!workerFactory && typeof Worker === "undefined");
  let nextRequestId = 1;
  let nextSequence = 1;
  let activeJob = null;
  let disposed = false;
  const queue = [];

  return {
    build,
    cancelScope,
    dispose,
    stats,
    workerMode: () => !workerUnavailable,
  };

  function build(input = {}, { signal = null, priority = 0, scope = "" } = {}) {
    if (disposed) return Promise.reject(clientError("building-mesh-disposed", "Building mesh worker was disposed."));
    if (signal?.aborted) return Promise.reject(abortError());
    const requestId = nextRequestId++;
    return new Promise((resolve, reject) => {
      const job = {
        requestId,
        sequence: nextSequence++,
        priority: finiteNumber(priority),
        scope: String(scope || ""),
        input,
        request: null,
        signal,
        resolve,
        reject,
        abortHandler: null,
        settled: false,
      };
      if (signal?.addEventListener) {
        job.abortHandler = () => cancelJob(job, abortError());
        signal.addEventListener("abort", job.abortHandler, { once: true });
      }
      insertQueuedJob(job);
      pump();
    });
  }

  function insertQueuedJob(job) {
    let index = queue.length;
    while (index > 0 && compareJobs(job, queue[index - 1]) < 0) index -= 1;
    queue.splice(index, 0, job);
  }

  function pump() {
    if (disposed || activeJob || !queue.length) return;
    const job = queue.shift();
    if (job.signal?.aborted) {
      settleJob(job, "reject", abortError());
      queueMicrotask(pump);
      return;
    }
    activeJob = job;
    try {
      job.request = snapshotRequest(job.input, job.requestId);
    } catch (error) {
      activeJob = null;
      settleJob(job, "reject", error);
      queueMicrotask(pump);
      return;
    }
    const activeWorker = ensureWorker();
    if (activeWorker) {
      try {
        activeWorker.postMessage(job.request);
      } catch (error) {
        handleWorkerFailure(activeWorker, error);
      }
      return;
    }
    void runOnMainThread(job);
  }

  function ensureWorker() {
    if (worker || workerUnavailable || disposed) return worker;
    let candidate = null;
    try {
      candidate = workerFactory
        ? workerFactory()
        : new Worker(new URL("./building-mesh-worker.js", import.meta.url), { type: "module" });
      worker = candidate;
      candidate.onmessage = (event) => handleMessage(candidate, event);
      candidate.onerror = (event) => handleWorkerFailure(candidate, event);
      candidate.onmessageerror = (event) => handleWorkerFailure(candidate, event);
      return candidate;
    } catch {
      if (candidate) terminateWorker(candidate);
      workerUnavailable = true;
      worker = null;
      return null;
    }
  }

  function handleMessage(source, event) {
    if (source !== worker) return;
    const response = event?.data;
    const job = activeJob;
    if (!job) {
      handleWorkerFailure(source, clientError(
        "building-mesh-worker-protocol",
        "Building mesh worker responded without an active request.",
      ));
      return;
    }
    if (!response || typeof response !== "object" || Array.isArray(response) || response.requestId !== job.requestId) {
      handleWorkerFailure(source, clientError(
        "building-mesh-worker-protocol",
        `Building mesh worker response does not match active request ${job.requestId}.`,
      ));
      return;
    }
    if (typeof response.ok !== "boolean") {
      handleWorkerFailure(source, clientError(
        "building-mesh-worker-protocol",
        `Building mesh worker response for request ${job.requestId} has no result status.`,
      ));
      return;
    }
    let outcome;
    try {
      outcome = response.ok
        ? validateBuildingMeshResult(response.result, { request: job.request })
        : workerError(response.error);
    } catch (error) {
      handleWorkerFailure(source, response.ok
        ? clientError(
          "building-mesh-worker-protocol",
          String(error?.message || "Building mesh worker returned an invalid result."),
        )
        : error);
      return;
    }
    activeJob = null;
    if (response.ok) settleJob(job, "resolve", outcome);
    else settleJob(job, "reject", outcome);
    pump();
  }

  function handleWorkerFailure(source, event) {
    if (source !== worker) return;
    const job = activeJob;
    activeJob = null;
    terminateWorker(source);
    workerUnavailable = true;
    if (job) {
      const message = String(event?.message || event || "Building mesh worker failed.");
      const code = event?.code === "building-mesh-worker-protocol"
        ? event.code
        : "building-mesh-worker-failed";
      settleJob(job, "reject", clientError(code, message));
    }
    pump();
  }

  async function runOnMainThread(job) {
    try {
      const result = await buildOnMainThread(job.request, job.signal);
      if (job !== activeJob || job.settled) return;
      activeJob = null;
      settleJob(job, "resolve", result);
    } catch (error) {
      if (job !== activeJob || job.settled) return;
      activeJob = null;
      settleJob(job, "reject", error);
    }
    pump();
  }

  function cancelScope(scope) {
    const key = String(scope || "");
    if (!key) return 0;
    let canceled = 0;
    for (const job of [...queue]) {
      if (job.scope !== key) continue;
      cancelJob(job, abortError());
      canceled += 1;
    }
    if (activeJob?.scope === key) {
      cancelJob(activeJob, abortError());
      canceled += 1;
    }
    return canceled;
  }

  function cancelJob(job, error) {
    if (!job || job.settled) return;
    const queuedIndex = queue.indexOf(job);
    if (queuedIndex >= 0) queue.splice(queuedIndex, 1);
    if (activeJob === job) {
      activeJob = null;
      if (worker) terminateWorker(worker);
    }
    settleJob(job, "reject", error);
    pump();
  }

  function settleJob(job, method, value) {
    if (!job || job.settled) return;
    job.settled = true;
    if (job.abortHandler && job.signal?.removeEventListener) {
      job.signal.removeEventListener("abort", job.abortHandler);
    }
    job[method](value);
  }

  function stats() {
    return Object.freeze({
      active: activeJob ? 1 : 0,
      queued: queue.length,
      workerMode: !workerUnavailable,
      disposed,
    });
  }

  function terminateWorker(target = worker) {
    if (!target) return;
    target.onmessage = null;
    target.onerror = null;
    target.onmessageerror = null;
    target.terminate?.();
    if (worker === target) worker = null;
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    const error = clientError("building-mesh-disposed", "Building mesh worker was disposed.");
    if (activeJob) settleJob(activeJob, "reject", error);
    activeJob = null;
    for (const job of queue.splice(0)) settleJob(job, "reject", error);
    terminateWorker(worker);
    workerUnavailable = true;
  }
}

async function buildOnMainThread(input, signal) {
  await new Promise((resolve) => setTimeout(resolve, 0));
  if (signal?.aborted) throw abortError();
  const building = parseNcm3Building(input.code, { id: input.buildingId || "" });
  const placement = createBuildingPlacement(building, input.foundation, {
    quarterTurns: input.quarterTurns,
    placementId: input.placementId,
    materializeWorldVoxels: false,
    allowFoundationOverflow: input.allowFoundationOverflow === true,
    offsetX: input.offsetX,
    offsetZ: input.offsetZ,
  });
  const chunks = createBuildingChunkMeshes(placement, {
    chunkSize: input.chunkSize,
    revision: input.revision,
  });
  if (signal?.aborted) throw abortError();
  return validateBuildingMeshResult(
    createBuildingMeshResult(building, placement, chunks),
    { request: input },
  );
}

function snapshotRequest(input, requestId) {
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const code = String(source.code ?? "").trim();
  if (code.length > MAX_BUILDING_REQUEST_CODE_LENGTH) {
    throw clientError("building-mesh-input-invalid", "Building code exceeds the NCM3 input limit.");
  }
  const foundation = snapshotFoundation(source.foundation);
  return {
    requestId,
    code,
    buildingId: requestLabel(source.buildingId, "buildingId", true),
    foundation,
    quarterTurns: source.quarterTurns,
    placementId: requestLabel(source.placementId, "placementId", true),
    allowFoundationOverflow: source.allowFoundationOverflow === true,
    offsetX: source.offsetX,
    offsetZ: source.offsetZ,
    chunkSize: source.chunkSize,
    revision: source.revision,
  };
}

function snapshotFoundation(input) {
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  return {
    id: requestLabel(source.id || `${source.owner || "foundation"}:${source.foundationId ?? 0}`, "foundation id"),
    minX: source.minX ?? source.worldX ?? source.x,
    minZ: source.minZ ?? source.worldZ ?? source.z,
    surfaceY: source.surfaceY ?? source.y,
    width: source.width,
    depth: source.depth,
  };
}

function requestLabel(value, label, optional = false) {
  const text = value ? String(value) : "";
  if ((!optional && !text) || text.length > MAX_BUILDING_REQUEST_LABEL_LENGTH) {
    throw clientError(
      "building-mesh-input-invalid",
      `Building ${label} must be ${optional ? "an optional" : "a non-empty"} string of at most ${MAX_BUILDING_REQUEST_LABEL_LENGTH} characters.`,
    );
  }
  return text;
}

function compareJobs(left, right) {
  return right.priority - left.priority || left.sequence - right.sequence;
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function abortError() {
  const error = clientError("building-mesh-aborted", "Building mesh request was canceled.");
  error.name = "AbortError";
  return error;
}

function clientError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function workerError(input = {}) {
  const details = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const fallbackMessage = typeof input === "string" && input ? input : "Building mesh failed.";
  return clientError(
    String(details.code || "building-mesh-failed"),
    String(details.message || fallbackMessage),
  );
}
