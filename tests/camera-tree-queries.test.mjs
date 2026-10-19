import assert from 'node:assert/strict';
import test from 'node:test';
import {ChunkManager} from '../chunk/chunk-manager.js';
import {ChunkState} from '../chunk/chunk-state.js';
import {BLOCK_ID,isBlockingBlock} from '../world/block-registry.js';

function scene() {
 const manager=new ChunkManager({useWorkers:false,deferInitialBuilds:true,height:16,minY:0,shadows:false});
 for(let z=-1;z<=1;z++)for(let x=-1;x<=1;x++)manager.chunks.set(`${x},${z}`,new ChunkState({chunkX:x,chunkZ:z,height:16,minY:0,chunkSize:16,baseBlocks:new Uint16Array(4096),treeInstances:[]}));
 return manager;
}
const legacy=(manager,x,y,z)=>{
 const id=manager.getBlockAtWorld(x,y,z);
 return id!==BLOCK_ID.leaves&&id!==BLOCK_ID.pineLeaves&&isBlockingBlock(id);
};

test('camera tree shortcut preserves leaf-overlap order and loaded/missing-neighbor fallbacks',()=>{
 const manager=scene();
 try {
  manager.chunks.get('-1,0').treeInstances=[{x:-1,z:0,baseY:1,trunkHeight:5,pine:false}];
  manager.chunks.get('0,0').treeInstances=[{x:0,z:0,baseY:1,trunkHeight:7,pine:true}];
  for(let z=-2;z<=2;z++)for(let x=-2;x<=2;x++)for(let y=0;y<12;y++)assert.equal(manager.isCameraOccluderAtWorld(x,y,z),legacy(manager,x,y,z));
  const full=manager.getLoadedTreeBlockAtWorld.bind(manager);let fullQueries=0;
  manager.getLoadedTreeBlockAtWorld=(...args)=>{fullQueries++;return full(...args);};
  assert.equal(manager.isCameraOccluderAtWorld(5,10,5),false);assert.equal(fullQueries,0,'proven empty air bypasses crown hashing');
  manager.isCameraOccluderAtWorld(0,2,0);assert.ok(fullQueries>0,'possible trunks preserve the complete overlap query');
  manager.chunks.get('-1,0').baseBlocksReady=false;
  fullQueries=0;
  assert.equal(manager.isCameraOccluderAtWorld(0,6,1),legacy(manager,0,6,1));assert.ok(fullQueries>0,'missing roots retain the generated fallback');
 } finally {manager.dispose();}
});

test('camera shortcut sees current block edits and supplemental colliders',()=>{
 const manager=scene();
 try {
  for(const id of Object.values(BLOCK_ID)) {
   manager.applyPendingDelta([{worldX:5,worldY:5,worldZ:5,blockId:id}],'camera-edit');
   assert.equal(manager.isCameraOccluderAtWorld(5,5,5),legacy(manager,5,5,5),`block ${id}`);
  }
  manager.supplementalCollisionProvider={hasCollisionAtWorld:()=>true};
  assert.equal(manager.isCameraOccluderAtWorld(5,10,5),true);
 } finally {manager.dispose();}
});

test('generated camera shortcut matches full voxel queries across loaded column boundaries',()=>{
 const manager=new ChunkManager({useWorkers:false,deferInitialBuilds:true,shadows:false});
 try {
  for(let z=27;z<=30;z++)for(let x=71;x<=74;x++)manager.ensureChunkBaseSync(manager.ensureChunk(x,z));
  for(let z=447;z<481;z+=3)for(let x=1151;x<1185;x+=3) {
   const top=manager.getOpaqueColumnTopAtWorld(x,z);
   for(let y=top-1;y<top+10;y++)assert.equal(manager.isCameraOccluderAtWorld(x,y,z),legacy(manager,x,y,z),`${x},${y},${z}`);
  }
 } finally {manager.dispose();}
});
