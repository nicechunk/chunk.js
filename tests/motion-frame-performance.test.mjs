import assert from 'node:assert/strict';
import test from 'node:test';
import { ChunkManager } from '../chunk/chunk-manager.js';
import { ChunkState } from '../chunk/chunk-state.js';
import { ensureRenderSections, commitRenderSection, sectionRevision } from '../chunk/render-sections.js';
import { createCameraState } from '../renderer/camera.js';
import { cameraRenderCenterChunk, chunkIntersectsCameraFrustum, chunkWorldBounds, prepareCameraFrustum, publishCommittedWorldBounds } from '../renderer/frustum.js';
import { WebGL2VoxelRenderer } from '../renderer/webgl2-renderer.js';
import { loadPeasantGuyAvatarMesh } from '../renderer/avatar-mesh.js';

test('shared camera frustum observes every in-place projection input change', () => {
  const camera = createCameraState();
  let prior = prepareCameraFrustum(camera);
  assert.equal(prepareCameraFrustum(camera), prior);
  for (const key of ['worldX','worldY','worldZ','localOffsetX','localOffsetY','localOffsetZ',
    'targetWorldX','targetWorldY','targetWorldZ','targetLocalOffsetX','targetLocalOffsetY','targetLocalOffsetZ',
    'yaw','pitch','fov','aspect','near','far']) {
    camera[key] = (camera[key] ?? 0) + .125;
    const current = prepareCameraFrustum(camera);
    assert.notEqual(current, prior, key);
    assert.equal(prepareCameraFrustum(camera), current);
    prior = current;
  }
});

test('cached column order preserves live frustum, linger, replacements and direction changes', () => {
  const manager = new ChunkManager({ useWorkers: false, viewDistance: 3, visibilityLingerFrames: 3 });
  const memory = new Map();
  const camera = createCameraState({ worldX: 8, worldY: 8, worldZ: 8, pitch: 0, yaw: 0, far: 200 });
  for (let z = -4; z <= 4; z++) for (let x = -4; x <= 4; x++) {
    manager.chunks.set(`${x},${z}`, { id: `${x},${z}`, chunkX: x, chunkZ: z, chunkSize: 16, minY: 0, height: 16,
      mesh: { vertexCount: 3, originY: 0, bounds: { minX: -2, maxX: 18, minY: 0, maxY: 16, minZ: -2, maxZ: 18 } } });
  }
  const priority = (chunk, center) => {
    const dx = chunk.chunkX - center.chunkX, dz = chunk.chunkZ - center.chunkZ;
    const forward = dx * manager.loadDirX + dz * manager.loadDirZ;
    return Math.max(Math.abs(dx),Math.abs(dz)) * 1000.01
      + (forward < -.35 ? 180 + Math.min(120,Math.abs(forward) * 12) : 0)
      + Math.abs(-dx * manager.loadDirZ + dz * manager.loadDirX) * 8 - forward * 6;
  };
  try {
    for (let frame = 1; frame <= 80; frame++) {
      camera.yaw = frame * .09; camera.worldX = Math.trunc(frame / 7) - 4; camera.localOffsetZ = frame % 7 / 7;
      if (frame === 20) manager.chunks.set('0,0', { ...manager.chunks.get('0,0') });
      if (frame === 30) manager.chunks.get('1,0').chunkX = 2;
      if (frame === 40) { manager.loadDirX = -1; manager.loadDirZ = 0; }
      const center = cameraRenderCenterChunk(camera,16), expected = [];
      for (const chunk of manager.chunks.values()) {
        const distance = Math.max(Math.abs(chunk.chunkX-center.chunkX),Math.abs(chunk.chunkZ-center.chunkZ));
        if (distance > manager.viewDistance) { memory.delete(chunk.id); continue; }
        if (chunkIntersectsCameraFrustum(chunk,camera)) { memory.set(chunk.id,frame); expected.push(chunk); }
        else if (memory.has(chunk.id) && frame-memory.get(chunk.id) <= 3) expected.push(chunk);
      }
      expected.sort((a,b)=>priority(a,center)-priority(b,center));
      assert.deepEqual(manager.getVisibleChunks(camera),expected,`moving frame ${frame}`);
    }
  } finally { manager.dispose(); }
  assert.equal(manager.visibilityOrder,null);
});

test('managed bounds follow atomic terrain/resource commits and preserve the prior visible revision', () => {
  const chunk = new ChunkState({chunkX:-2,chunkZ:3,chunkSize:16,height:16,minY:-32,baseBlocks:new Uint16Array(4096)});
  const section = ensureRenderSections(chunk).get(0);
  const makeMesh = (minX,maxX,originY) => ({vertexCount:3,indexCount:3,triangleCount:1,originY,
    bounds:{minX,maxX,minY:1,maxY:5,minZ:0,maxZ:16}});
  const commit = result => commitRenderSection(chunk,section,result,sectionRevision(section,chunk.materialVersion));
  assert.equal(commit({mesh:makeMesh(0,16,-32),visualMesh:makeMesh(-3,19,-16)}),true);
  const first = {minX:-35,maxX:-13,minY:-31,maxY:-11,minZ:48,maxZ:64};
  assert.deepEqual(chunkWorldBounds(section),first);
  assert.deepEqual(chunkWorldBounds(chunk),first);
  section.dataRevision++;
  assert.equal(commitRenderSection(chunk,section,{mesh:makeMesh(-9,24,0)},'stale'),false);
  assert.deepEqual(chunkWorldBounds(section),first);
  assert.equal(commit({mesh:makeMesh(0,16,-32),visualMesh:makeMesh(1,15,-32)}),true);
  assert.deepEqual(chunkWorldBounds(section),{minX:-32,maxX:-16,minY:-31,maxY:-27,minZ:48,maxZ:64});
  assert.deepEqual(chunkWorldBounds(chunk),chunkWorldBounds(section));
});

test('shared animated mesh snapshots retain per-entity pose data and update reusable upload revisions', async () => {
  const renderer = Object.create(WebGL2VoxelRenderer.prototype);
  const mesh = await loadPeasantGuyAvatarMesh({attachIronPickaxe:true});
  const entry = {mesh}, a = {animation:{moving:true,timeMs:100}}, b = {animation:{moving:true,timeMs:800}};
  const first = renderer.avatarFrameState(a,entry), original = first.vertices.slice(), revision = first.revision;
  renderer.avatarFrameState(b,entry);
  assert.deepEqual(first.vertices,original,'another entity must not overwrite the first pose');
  const array = first.vertices;
  renderer.avatarFrameStates.clear(); a.animation.timeMs = 900;
  const second = renderer.avatarFrameState(a,entry);
  assert.equal(second.vertices,array,'reuse array storage across frames');
  assert.ok(second.revision > revision);
  assert.notDeepEqual(second.vertices,original,'walk animation must advance');
  assert.equal(renderer.avatarFrameState(a,entry).revision,second.revision,'opaque and transparent passes share one revision');
});

test('empty managed sections retire owned bounds without inspecting empty buffers', () => {
  const source = {chunkX:0,chunkZ:0,chunkSize:16,mesh:{vertexCount:3,originY:-32,
    bounds:{minX:0,maxX:16,minY:0,maxY:16,minZ:0,maxZ:16}}};
  publishCommittedWorldBounds(source);
  assert.ok(source.renderBounds);
  const empty = {vertexCount:0,indexCount:0,get bounds(){throw Error('empty bounds inspection');},
    get vertices(){throw Error('empty buffer inspection');}};
  source.mesh=empty;source.visualMesh=empty;
  assert.doesNotThrow(()=>publishCommittedWorldBounds(source));
  assert.equal(source.renderBounds,undefined);
  assert.doesNotThrow(()=>publishCommittedWorldBounds(source));
});

test('frame admission polls without waiting, consuming errors, or publishing partial uploads', () => {
  const renderer = Object.create(WebGL2VoxelRenderer.prototype);
  let status = 1, errors = 0, polls = 0;
  const fence = {};
  Object.assign(renderer,{gpuReady:()=>true,deferredUploadsSupported:()=>true,
    frameCompletionFences:[],uploadValidationFence:fence,gl:{TIMEOUT_EXPIRED:1,
      clientWaitSync(sync,flags,timeout){assert.equal(sync,fence);assert.equal(flags,0);assert.equal(timeout,0);polls++;return status;},
      getError(){errors++;return 0;}}});
  assert.equal(renderer.canPrepareFrame(),false);
  status = 2;
  assert.equal(renderer.canPrepareFrame(),true);
  assert.equal(renderer.uploadValidationFence,fence);
  assert.equal(errors,0);assert.equal(polls,2);
});
