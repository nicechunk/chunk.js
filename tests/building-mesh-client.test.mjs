import assert from "node:assert/strict";
import test from "node:test";

import { createBuildingMeshWorkerClient } from "../construction/building-mesh-client.js";

test("building mesh client keeps one worker job active and prioritizes queued work", async () => {
  const workers = [];
  const client = createBuildingMeshWorkerClient({ workerFactory: () => fakeWorker(workers) });
  const first = client.build({ label: "active" }, { priority: 0 });
  const low = client.build({ label: "low" }, { priority: 1 });
  const high = client.build({ label: "high" }, { priority: 10 });

  assert.deepEqual(workers[0].messages.map((message) => message.label), ["active"]);
  workers[0].succeed(0);
  assert.deepEqual(workers[0].messages.map((message) => message.label), ["active", "high"]);
  workers[0].succeed(1);
  assert.deepEqual(workers[0].messages.map((message) => message.label), ["active", "high", "low"]);
  workers[0].succeed(2);

  assert.deepEqual(await Promise.all([first, low, high]), ["active", "low", "high"]);
  assert.deepEqual(client.stats(), { active: 0, queued: 0, workerMode: true, disposed: false });
  client.dispose();
});

test("aborting queued building work prevents it from reaching the worker", async () => {
  const workers = [];
  const client = createBuildingMeshWorkerClient({ workerFactory: () => fakeWorker(workers) });
  const first = client.build({ label: "active" });
  const controller = new AbortController();
  const canceled = client.build({ label: "canceled" }, { signal: controller.signal });
  controller.abort();

  await assert.rejects(canceled, (error) => error?.code === "building-mesh-aborted");
  assert.deepEqual(workers[0].messages.map((message) => message.label), ["active"]);
  workers[0].succeed(0);
  await first;
  client.dispose();
});

test("aborting active building work terminates stale computation and resumes on a fresh worker", async () => {
  const workers = [];
  const client = createBuildingMeshWorkerClient({ workerFactory: () => fakeWorker(workers) });
  const controller = new AbortController();
  const stale = client.build({ label: "stale" }, { signal: controller.signal, scope: "region-a" });
  const current = client.build({ label: "current" }, { scope: "region-b" });
  controller.abort();

  await assert.rejects(stale, (error) => error?.code === "building-mesh-aborted");
  assert.equal(workers[0].terminated, true);
  assert.equal(workers.length, 2);
  assert.deepEqual(workers[1].messages.map((message) => message.label), ["current"]);
  workers[1].succeed(0);
  assert.equal(await current, "current");
  client.dispose();
});

function fakeWorker(workers) {
  const worker = {
    messages: [],
    terminated: false,
    onmessage: null,
    onerror: null,
    onmessageerror: null,
    postMessage(message) {
      this.messages.push(message);
    },
    succeed(index) {
      const request = this.messages[index];
      this.onmessage?.({ data: { requestId: request.requestId, ok: true, result: request.label } });
    },
    terminate() {
      this.terminated = true;
    },
  };
  workers.push(worker);
  return worker;
}
