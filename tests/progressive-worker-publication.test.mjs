import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { ChunkManager } from "../chunk/chunk-manager.js";
import { BLOCK_ID } from "../world/block-registry.js";
import { createActualBuildWorker } from "./helpers/actual-build-worker.mjs";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const geometry = mesh => mesh && [mesh.indexCount, mesh.originY, hash(mesh.vertices),
  hash(new Uint8Array(mesh.indices.buffer, mesh.indices.byteOffset, mesh.indices.byteLength))];

test("actual progressive Worker retains its profile and matches the complete column", async () => {
  const worker = await createActualBuildWorker();
  const manager = new ChunkManager({ useWorkers: false, chunkSize: 4, shadows: false });
  try {
    const input = { worldSeed: manager.worldSeed, chunkX: 0, chunkZ: 0,
      generationVersion: manager.generationVersion, resourceRuleVersion: manager.resourceRuleVersion,
      materialVersion: manager.materialVersion, options: manager.workerOptions(), mode: "base", taskVersion: 0,
      finalDeltas: new Int32Array(), neighborDeltas: new Int32Array(), treeDeltas: new Int32Array(),
      lightingDeltas: new Int32Array(), preferredSectionY: 80 };
    const reference = await worker.build(input);
    const packets = [];
    const streamed = await worker.build({ ...input, progressiveSections: true }, { onProgress: packet => packets.push(packet) });
    assert.equal(packets.reduce((count, packet) => count + packet.sectionResults.length, 0), reference.sectionResults.length);
    assert.ok(packets.length < reference.sectionResults.length, "empty layers share bounded transport packets");
    assert.ok(packets.every(packet => packet.sectionResults.length <= 8));
    assert.ok(packets.filter(packet => packet.sectionResults.length > 1).every(packet =>
      packet.sectionResults.every(result => !result.mesh?.indexCount && !result.visualMesh?.indexCount && !result.visualError)));
    assert.equal(packets[0].completedSections, 1);
    assert.ok(packets[0].completedSections < packets[0].totalSections);
    assert.equal(packets[0].baseProfile.surfaceY.length, 16);
    assert.ok(packets.slice(1).every(packet => packet.baseProfile === null));
    assert.deepEqual(streamed.sectionResults.map(result => [result.sectionIndex, geometry(result.mesh), geometry(result.visualMesh)]),
      reference.sectionResults.map(result => [result.sectionIndex, geometry(result.mesh), geometry(result.visualMesh)]));
    assert.ok(streamed.sectionResults.some(result => result.mesh.indexCount));
  } finally { manager.dispose(); await worker.dispose(); }
});

test("progress packets are budgeted, ordered, deduplicated and release the computing slot at validated terminal reception", async () => {
  const previous = globalThis.Worker;
  const workers = [];
  globalThis.Worker = class {
    constructor() { this.messages = []; workers.push(this); }
    postMessage(message) { this.messages.push(message); }
    terminate() {}
  };
  let manager;
  const actual = await createActualBuildWorker();
  try {
    manager = new ChunkManager({ useWorkers: true, workerCount: 1, chunkSize: 4, shadows: false });
    manager.setBuildCamera({ worldX: 0, worldY: 80, worldZ: 0, yaw: 0, pitch: 0, fov: 58, aspect: 1.6 });
    const chunk = manager.ensureChunk(0, 0);
    manager.dispatchBuilds();
    const stub = workers.find(worker => worker.messages.some(message => message.type === "buildChunk"));
    const request = stub.messages.find(message => message.type === "buildChunk");
    const response = await actual.build(request);
    const packets = response.progress.map(packet => ({ ...packet, taskId: request.taskId }));
    assert.ok(packets.length > 2);
    manager.handleWorkerMessage(stub, packets[1]);
    assert.equal(manager.drainWorkerProgress(5, { maxPackets: 1 }), 0, "out-of-order packets wait for their predecessor");
    manager.handleWorkerMessage(stub, packets[0]);
    assert.equal(chunk.baseBlocksReady, false, "message callbacks only enqueue work");
    assert.equal(manager.idleWorkers.length, 0);
    assert.equal(manager.drainWorkerProgress(0), 0, "expired service leaves queued results untouched");
    manager.drainWorkerProgress(2, { maxPackets: 1 });
    assert.equal(chunk.baseBlocksReady, true);
    assert.equal(manager.progressiveSectionsCommitted, 1, "one reserved publication quantum commits one section");
    assert.equal(manager.inFlightBuilds.size, 1);
    const first = chunk.renderSections.get(packets[0].sectionResults[0].sectionIndex);
    const token = first.meshCommitToken;
    manager.handleWorkerMessage(stub, packets[0]);
    assert.equal(first.meshCommitToken, token);
    manager.applyPendingDelta([{ worldX: 1, worldY: 1, worldZ: 1, blockId: BLOCK_ID.air }], "during-stream");
    for (const packet of packets.slice(2)) manager.handleWorkerMessage(stub, packet);
    manager.handleWorkerMessage(stub, { ...response, sectionResults: undefined, progress: undefined, taskId: request.taskId });
    assert.equal(manager.inFlightBuilds.size, 1, "terminal arrival does not bypass the commit deadline");
    assert.equal(manager.idleWorkers.length, 1, "validated terminal frees the computing slot before publication drains");
    manager.consecutiveWorkerFailures = 2;
    for (let index = 0; index < response.progressMessageCount + 2 && manager.inFlightBuilds.size; index++) manager.drainWorkerProgress(5, { maxPackets: 1 });
    assert.equal(manager.inFlightBuilds.size, 0);
    assert.equal(manager.idleWorkers.length, 1);
    assert.equal(manager.consecutiveWorkerFailures, 0, "a successful progressive task clears consecutive Worker failure debt");
    assert.equal(first.meshCommitToken, token, "an unrelated edit does not discard the published section");
    assert.ok(manager.staleBuildResults > 0, "the edited section rejects its captured old geometry");
    assert.equal(chunk.getFinalBlock(1, 1, 1), BLOCK_ID.air);
    manager.handleWorkerMessage(stub, { ...response, taskId: request.taskId });
    assert.equal(manager.idleWorkers.length, 1, "duplicate terminal never releases a slot twice");
  } finally {
    manager?.dispose(); await actual.dispose();
    if (previous === undefined) delete globalThis.Worker; else globalThis.Worker = previous;
  }
});

async function withProgressiveHarness(run) {
  const previous=globalThis.Worker,workers=[];
  globalThis.Worker=class{constructor(){this.messages=[];workers.push(this);}postMessage(message){this.messages.push(message);}terminate(){this.terminated=true;}};
  const actual=await createActualBuildWorker();let manager;
  try{
    manager=new ChunkManager({useWorkers:true,workerCount:1,chunkSize:4,shadows:false});
    const chunk=manager.ensureChunk(0,0);manager.dispatchBuilds();
    const stub=workers.find(worker=>worker.messages.some(message=>message.type==='buildChunk'));
    const request=stub.messages.find(message=>message.type==='buildChunk');
    const response=await actual.build(request);
    const packets=response.progress.map(packet=>({...packet,taskId:request.taskId}));
    const terminal={...response,progress:undefined,sectionResults:undefined,taskId:request.taskId};
    await run({manager,chunk,stub,request,packets,terminal,workers});
  }finally{manager?.dispose();await actual.dispose();if(previous===undefined)delete globalThis.Worker;else globalThis.Worker=previous;}
}

test('unloading terminates progressive ownership before the same coordinate is recreated',async()=>{
 await withProgressiveHarness(({manager,chunk,stub,packets,terminal})=>{
  manager.handleWorkerMessage(stub,packets[0]);manager.drainWorkerProgress(5, { maxPackets: 1 });
  manager.unloadFarChunks(100,100);
  assert.equal(stub.terminated,true);assert.equal(manager.inFlightBuilds.size,0);
  assert.equal(manager.cancelledWorkerTasks,1);
  const current=manager.ensureChunk(0,0);assert.notEqual(current,chunk);
  for(const packet of packets)manager.handleWorkerMessage(stub,packet);manager.handleWorkerMessage(stub,terminal);
  manager.drainWorkerProgress(100);
  assert.equal(current.baseBlocksReady,false);assert.equal(current.mesh,null);
 });
});

test('changed decoration revisions reject old progressive meshes while accepting deterministic base data',async()=>{
 const {DEFAULT_SURFACE_DECORATION_RULES}=await import('../world/surface-decoration-rules.js');
 await withProgressiveHarness(({manager,chunk,stub,packets,terminal})=>{
  manager.setSurfaceDecorationRules(DEFAULT_SURFACE_DECORATION_RULES,{revision:1});
  for(const packet of packets)manager.handleWorkerMessage(stub,packet);manager.handleWorkerMessage(stub,terminal);
  for(let i=0;i<terminal.progressMessageCount+2&&manager.inFlightBuilds.size;i++)manager.drainWorkerProgress(5, { maxPackets: 1 });
  assert.equal(chunk.baseBlocksReady,true);assert.equal(manager.progressiveSectionsCommitted,0);
  assert.ok(chunk.dirty);assert.ok(manager.staleBuildResults>0);assert.equal(manager.idleWorkers.length,1);
 });
});

test('empty transport batches remain section-budgeted and skip unchanged initial summary traversal',async()=>{
 await withProgressiveHarness(({manager,chunk,stub,request,packets,terminal})=>{
  assert.ok(packets.some(packet=>packet.sectionResults.length>1));
  for(const packet of packets)manager.handleWorkerMessage(stub,packet);
  let emptyCommits=0,geometryCommits=0;
  for(let i=0;i<terminal.progressMessageCount;i++){
   const task=manager.inFlightBuilds.get(request.taskId);
   const message=task.pendingProgress.get(task.nextProgressToApply);
   const result=message.sectionResults[0];
   const empty=!result.mesh?.indexCount&&!result.visualMesh?.indexCount&&!result.visualError;
   const revision=chunk.renderSectionCommitRevision??0,committed=manager.progressiveSectionsCommitted;
   manager.drainWorkerProgress(5, { maxPackets: 1 });
   assert.equal(manager.progressiveSectionsCommitted,committed+1,'one logical section per reserved publication quantum');
   if(empty){emptyCommits++;assert.equal(chunk.renderSectionCommitRevision??0,revision,'empty-to-empty cannot change visible summary');}
   else{geometryCommits++;assert.ok(chunk.renderSectionCommitRevision>revision);}
  }
  assert.ok(emptyCommits>geometryCommits&&geometryCommits>0);
  assert.equal(manager.inFlightBuilds.size,1,'batch reception and logical commits do not settle without terminal');
  manager.handleWorkerMessage(stub,terminal);manager.drainWorkerProgress(5, { maxPackets: 1 });
  assert.equal(manager.inFlightBuilds.size,0);assert.equal(chunk.dirty,false);
 });
});

test('silent and incomplete terminal Workers time out and can be retried with clean ownership',async()=>{
 await withProgressiveHarness(({manager,chunk,stub,request,terminal})=>{
  manager.handleWorkerMessage(stub,terminal);
  const task=manager.inFlightBuilds.get(request.taskId);task.lastActivityAt=-100000;
  assert.equal(manager.recoverTimedOutWorkers(),1);assert.equal(manager.workerTaskTimeouts,1);
  assert.equal(stub.terminated,true);assert.equal(manager.inFlightBuilds.size,0);assert.equal(manager.useWorkers,true);
  assert.notEqual(chunk.buildState,'building');assert.equal(chunk.baseBlocksReady,false);
  manager.workerBuildFailures.get(chunk.id).retryAt=0;manager.rebuildDirtyChunks(5);
  assert.equal(manager.inFlightBuilds.size,1);
 });
});

test('a validated completed task releases compute capacity while its unconsumed geometry survives a newer Worker failure', async () => {
 await withProgressiveHarness(({ manager, chunk, stub, request, packets, terminal }) => {
  for (const packet of packets) manager.handleWorkerMessage(stub, packet);
  manager.handleWorkerMessage(stub, terminal);
  assert.equal(chunk.baseBlocksReady, false);
  assert.equal(manager.inFlightBuilds.get(request.taskId).computeReleased, true);
  const next = manager.ensureChunk(1, 0); manager.dispatchBuilds();
  assert.equal(stub.messages.filter(message => message.type === 'buildChunk').length, 2);
  assert.equal(manager.inFlightBuilds.size, 2);
  assert.equal(manager.idleWorkers.length, 0);
  manager.handleWorkerError(stub, new Error('Injected failure in the new computing job'));
  assert.ok(manager.inFlightBuilds.has(request.taskId), 'completed geometry is not owned by the failing computing slot');
  assert.notEqual(next.buildState, 'building');
  manager.drainWorkerProgress(1000);
  assert.ok(chunk.mesh?.indexCount);
  assert.equal(chunk.dirty, false);
  assert.equal(manager.inFlightBuilds.has(request.taskId), false);
 });
});
