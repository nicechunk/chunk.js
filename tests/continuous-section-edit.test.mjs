import assert from "node:assert/strict";
import test from "node:test";
import { ChunkManager } from "../chunk/chunk-manager.js";
import { BLOCK_ID } from "../world/block-registry.js";
import { expectedFaces,actualFaces } from "./helpers/face-oracle.mjs";

test("explicit synchronous compensation keeps eight edits visible and rejects the old result",()=>{
  const previous=globalThis.Worker,workers=[];
  globalThis.Worker=class {
    constructor(){this.messages=[];workers.push(this);}
    postMessage(message){this.messages.push(message);}
    terminate(){}
  };
  let manager;
  try {
    manager=new ChunkManager({chunkSize:4,height:32,minY:0,viewDistance:1,useWorkers:false});
    const chunk=manager.ensureChunk(0,0);chunk.setBaseBlocks(new Uint16Array(4*4*32).fill(BLOCK_ID.stone));
    manager.rebuildDirtyChunks(10000);
    manager.useWorkers=true;manager.workerCount=1;manager.activeBuildLimit=1;manager.initWorkers(1);
    manager.centerChunkX=3;
    manager.applyPendingDelta([{worldX:1,worldY:5,worldZ:1,blockId:BLOCK_ID.air}],"initial");
    manager.rebuildDirtyChunks(10000);
    const [taskId,task]=[...manager.inFlightBuilds.entries()][0];assert.ok(task);
    const oldMesh=chunk.renderSections.get(task.sectionIndex).mesh;
    manager.centerChunkX=0;
    for(let edit=0;edit<8;edit++) {
      manager.applyPendingDelta([{worldX:1+edit%2,worldY:6+Math.floor(edit/2),worldZ:1,blockId:BLOCK_ID.air}],`edit-${edit}`);
      manager.rebuildDirtyChunks(10000, { synchronousNearField: true });
      assert.deepEqual(actualFaces(chunk.mesh),expectedFaces(chunk,(...p)=>manager.getBlockAtWorld(...p)));
      assert.equal(chunk.meshVersion,chunk.version);
    }
    const current=chunk.mesh;
    task.worker.onmessage({data:{type:"chunkBuilt",taskId,chunkX:0,chunkZ:0,mode:"section",taskVersion:task.version,materialVersion:task.materialVersion,sectionRevision:task.sectionRevision,mesh:oldMesh,visualMesh:null,visualPending:false}});
    assert.equal(chunk.mesh,current,"a delayed obsolete mesh must not replace near-field compensation");
    assert.ok(manager.nearFieldRepairs>=8);assert.equal(manager.inFlightBuilds.size,0);
  } finally {manager?.dispose();if(previous===undefined)delete globalThis.Worker;else globalThis.Worker=previous;}
});
