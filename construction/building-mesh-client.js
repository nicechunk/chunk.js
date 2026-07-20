import {
  createBuildingPlacement,
  parseNcm3Building,
} from "./building-parser.js";
import { createBuildingChunkMeshes } from "./building-mesher.js";

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
    const activeWorker = ensureWorker();
    if (activeWorker) {
      try {
        activeWorker.postMessage({ ...job.input, requestId: job.requestId });
      } catch (error) {
        handleWorkerFailure(error);
      }
      return;
    }
    void runOnMainThread(job);
  }

  function ensureWorker() {
    if (worker || workerUnavailable || disposed) return worker;
    try {
      worker = workerFactory
        ? workerFactory()
        : new Worker(new URL("./building-mesh-worker.js", import.meta.url), { type: "module" });
      worker.onmessage = handleMessage;
      worker.onerror = handleWorkerFailure;
      worker.onmessageerror = handleWorkerFailure;
      return worker;
    } catch {
      workerUnavailable = true;
      worker = null;
      return null;
    }
  }

  function handleMessage(event) {
    const response = event.data ?? {};
    const job = activeJob;
    if (!job || Number(response.requestId) !== job.requestId) return;
    activeJob = null;
    if (response.ok) settleJob(job, "resolve", response.result);
    else settleJob(job, "reject", workerError(response.error));
    pump();
  }

  function handleWorkerFailure(event) {
    const job = activeJob;
    activeJob = null;
    terminateWorker();
    workerUnavailable = true;
    if (job) {
      const message = String(event?.message || event || "Building mesh worker failed.");
      settleJob(job, "reject", clientError("building-mesh-worker-failed", message));
    }
    pump();
  }

  async function runOnMainThread(job) {
    try {
      const result = await buildOnMainThread(job.input, job.signal);
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
      if (worker) terminateWorker();
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

  function terminateWorker() {
    if (!worker) return;
    worker.onmessage = null;
    worker.onerror = null;
    worker.onmessageerror = null;
    worker.terminate?.();
    worker = null;
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    const error = clientError("building-mesh-disposed", "Building mesh worker was disposed.");
    if (activeJob) settleJob(activeJob, "reject", error);
    activeJob = null;
    for (const job of queue.splice(0)) settleJob(job, "reject", error);
    terminateWorker();
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
  return { building, placement, chunks };
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
  return clientError(
    String(input.code || "building-mesh-failed"),
    String(input.message || "Building mesh failed."),
  );
}
