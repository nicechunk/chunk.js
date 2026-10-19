import assert from 'node:assert/strict';
import test from 'node:test';
import { ChunkManager } from '../chunk/chunk-manager.js';
import { createCameraState } from '../renderer/camera.js';
import { generateBaseChunkProfileFromConfig } from '../world/world-generator.js';
import { ensureRenderSections, buildRenderSection } from '../chunk/render-sections.js';
import { createActualBuildWorker } from './helpers/actual-build-worker.mjs';

test('visible initial work precedes nearer offscreen work, turns reorder the queue and background builds finish',()=>{
  const original=globalThis.Worker,starts=[];
  globalThis.Worker=class {postMessage(task){if(task.type==='buildChunk')starts.push(task);}terminate(){}};
  const manager=new ChunkManager({useWorkers:true,workerCount:1,deferInitialBuilds:true,deferContinuousBuildDispatch:true,
    shadows:false,viewDistance:4,height:16,minY:0});
  const camera=createCameraState({worldX:8,worldY:8,worldZ:0,targetWorldX:8,targetWorldY:8,targetWorldZ:64,aspect:1,far:160});
  const finish=()=>{
    const task=starts.at(-1),worker=manager.workers[0];
    const mesh={vertices:new Uint8Array(),indices:new Uint16Array(),vertexCount:0,indexCount:0,triangleCount:0};
    worker.onmessage({data:{...task,mode:'base',type:'chunkBuilt',
      baseProfile:generateBaseChunkProfileFromConfig(manager.config,task.chunkX,task.chunkZ),treeInstances:[],mesh,visualMesh:mesh}});
  };
  try {
    for(const z of [-2,3,4,-3])manager.ensureChunk(0,z);
    manager.setBuildCamera(camera);manager.setBuildConcurrencyLimit(1);
    assert.equal(starts[0].chunkZ,3,'visible distance 3 precedes the nearer column behind the camera');
    finish();camera.targetWorldZ=-64;manager.setBuildCamera(camera);manager.dispatchBuilds();
    assert.equal(starts[1].chunkZ,-2,'the same mutable camera object must update task visibility after a turn');
    finish();manager.dispatchBuilds();finish();manager.dispatchBuilds();finish();
    assert.deepEqual(new Set(starts.map(t=>t.chunkZ)),new Set([-2,3,4,-3]));
    assert.equal(manager.inFlightBuilds.size,0);assert.equal(manager.buildQueue.length,0);
    assert.ok([...manager.chunks.values()].every(c=>c.baseBlocksReady&&c.mesh));
  }finally{manager.dispose();if(original===undefined)delete globalThis.Worker;else globalThis.Worker=original;}
});

test('a superseded first base keeps the latest edits and retries the unpublished world in one complete batch',()=>{
  const original=globalThis.Worker,starts=[];
  globalThis.Worker=class {postMessage(task){if(task.type==='buildChunk')starts.push(task);}terminate(){}};
  const manager=new ChunkManager({useWorkers:true,workerCount:1,deferInitialBuilds:true,deferContinuousBuildDispatch:true,
    shadows:false,viewDistance:1});
  try {
    const chunk=manager.ensureChunk(0,0);
    manager.setBuildConcurrencyLimit(1);
    const first=starts[0];
    manager.applyChainDelta([{worldX:8,worldY:5,worldZ:8,blockId:20}]);
    const profile=generateBaseChunkProfileFromConfig(manager.config,0,0);
    const mesh={vertices:new Uint8Array(),indices:new Uint16Array(),vertexCount:0,indexCount:0,triangleCount:0};
    const respond=task=>manager.workers[0].onmessage({data:{...task,type:'chunkBuilt',
      baseProfile:task.mode==='base'?profile:null,treeInstances:[],sectionResults:[...ensureRenderSections(chunk)].map(([sectionIndex])=>
        ({sectionIndex,mesh,visualMesh:mesh,visualError:null}))}});
    respond(first);
    assert.equal(chunk.baseBlocksReady,true);assert.equal(chunk.mesh,null,'the superseded first mesh cannot be published');
    assert.equal(manager.staleBuildResults,1);
    manager.rebuildDirtyChunks(4);
    assert.equal(starts.length,2);assert.equal(starts[1].mode,'remesh');
    assert.equal(starts[1].sectionIndex,undefined,'23 initial layers must not become 23 sequential messages');
    assert.equal(manager.buildQueue.length,0);
    assert.equal(starts[1].baseProfile,chunk.baseProfile,'the already captured canonical profile is reusable');
    assert.deepEqual(Array.from(starts[1].finalDeltas),[8,5,8,20]);
    respond(starts[1]);
    assert.ok(chunk.mesh);assert.equal(chunk.dirty,false);
    assert.ok([...chunk.renderSections.values()].every(section=>section.mesh&&section.visualMesh));
    assert.equal(chunk.getFinalBlock(8,5,8),20,'retrying the initial build cannot drop the arriving authority edit');
  }finally{manager.dispose();if(original===undefined)delete globalThis.Worker;else globalThis.Worker=original;}
});

test('a real Worker initial retry matches the final edited world in every complete section',async()=>{
  const actual=await createActualBuildWorker(),original=globalThis.Worker,pending=[],starts=[];
  globalThis.Worker=class {
    postMessage(task) {
      if(task.type==='setSurfaceDecorationRules'){actual.setSurfaceDecorationRules(task.rules,task.revision);return;}
      starts.push(task);
      pending.push(actual.build(task).then(result=>this.onmessage?.({data:{...result,taskId:task.taskId}})));
    }
    terminate(){}
  };
  const manager=new ChunkManager({useWorkers:true,workerCount:1,deferInitialBuilds:true,deferContinuousBuildDispatch:true,
    shadows:false,viewDistance:1});
  try {
    const chunk=manager.ensureChunk(66,29);manager.setBuildConcurrencyLimit(1);
    manager.applyChainDelta([{worldX:1064,worldY:5,worldZ:472,blockId:20},
      {worldX:1065,worldY:6,worldZ:472,blockId:0}]);
    await pending[0];assert.equal(chunk.mesh,null);assert.equal(manager.staleBuildResults,1);
    manager.rebuildDirtyChunks(4);assert.equal(starts[1].mode,'remesh');await pending[1];
    assert.equal(starts.length,2);assert.equal(manager.buildQueue.length,0);assert.equal(chunk.dirty,false);
    const access={...manager.meshAccessForChunk(chunk),generatedTerrain:false,noLocalLightSources:false};
    for(const section of chunk.renderSections.values()) {
      const expected=buildRenderSection(chunk,section,access);
      for(const field of ['mesh','visualMesh']) {
        assert.equal(section[field].originY,expected[field].originY);
        assert.deepEqual(Buffer.from(section[field].vertices),Buffer.from(expected[field].vertices),section.id+' '+field+' vertices');
        assert.deepEqual(section[field].indices,expected[field].indices,section.id+' '+field+' topology');
      }
    }
    assert.equal(chunk.getFinalBlock(8,5,8),20);
  }finally{manager.dispose();await actual.dispose();if(original===undefined)delete globalThis.Worker;else globalThis.Worker=original;}
});
