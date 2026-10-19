import assert from "node:assert/strict";
import test from "node:test";
import { ChunkManager } from "../chunk/chunk-manager.js";

test("expiry does no per-chunk work for a 1849-chunk view without remote overlays",()=>{
  const manager=new ChunkManager({useWorkers:false,viewDistance:20,preloadMargin:1,deferInitialBuilds:true});
  try {
    manager.ensureChunkRange(0,0);
    assert.equal(manager.chunks.size,43*43);
    for(const chunk of manager.chunks.values())chunk.expireRemoteDeltas=()=>assert.fail("clean chunks must not consume the snapshot apply budget");
    assert.equal(manager.remoteOverlayChunks.size,0);
    manager.expireRemoteDeltas(Date.now());
  } finally {manager.dispose();}
});

test("direct state hints enter the live index; a collision read expires them and invalidates neighbours",()=>{
  const manager=new ChunkManager({useWorkers:false,chunkSize:4,height:16,minY:0,viewDistance:1,deferInitialBuilds:true});
  try {
    const chunk=manager.ensureChunk(0,0),neighbor=manager.ensureChunk(1,0);
    let clock=Date.now();chunk.authorityNow=()=>clock;
    chunk.applyRemoteDelta([{worldX:3,worldY:5,worldZ:1,blockId:0}],{now:clock,ttlMs:10});
    assert.ok(manager.remoteOverlayChunks.has(chunk));
    const revision=neighbor.version;clock+=11;
    chunk.getFinalBlock(3,5,1);
    assert.equal(chunk.remoteDeltas.size,0);
    assert.equal(manager.remoteOverlayChunks.size,0);
    assert.ok(neighbor.version>revision,"expiry triggered by a read still invalidates the neighbour halo");
  } finally {manager.dispose();}
});

test("confirmation and complete authority snapshots release overlay index ownership",()=>{
  const manager=new ChunkManager({useWorkers:false,chunkSize:4,height:16,minY:0,viewDistance:1,deferInitialBuilds:true});
  try {
    const chunk=manager.ensureChunk(0,0),edit={worldX:1,worldY:5,worldZ:1,blockId:0};
    chunk.applyRemoteDelta([edit]);assert.equal(manager.remoteOverlayChunks.size,1);
    chunk.applyChainDelta([{...edit,blockId:3}],{protectUntilSnapshot:false});
    assert.equal(manager.remoteOverlayChunks.size,0);
    chunk.applyRemoteDelta([edit]);assert.equal(manager.remoteOverlayChunks.size,1);
    chunk.replaceChainDeltas([{...edit,blockId:3}],{snapshotToken:1,snapshotSlot:10,source:"rpc"});
    assert.equal(manager.remoteOverlayChunks.size,0);
    chunk.applyRemoteDelta([edit]);
    chunk.applyPendingDelta([{...edit,blockId:3}],"local");
    chunk.confirmPendingDelta("local",{slot:11,commitment:"confirmed"});
    assert.equal(manager.remoteOverlayChunks.size,0);
  } finally {manager.dispose();}
});

test("unload and dispose clear overlays; late updates cannot register an old instance",()=>{
  const manager=new ChunkManager({useWorkers:false,chunkSize:4,height:16,minY:0,viewDistance:1,preloadMargin:0,deferInitialBuilds:true});
  const chunk=manager.ensureChunk(10,10),edit={worldX:41,worldY:5,worldZ:41,blockId:0};
  chunk.applyRemoteDelta([edit]);assert.equal(manager.remoteOverlayChunks.size,1);
  manager.unloadFarChunks(0,0);assert.equal(manager.remoteOverlayChunks.size,0);
  chunk.applyRemoteDelta([edit]);assert.equal(manager.remoteOverlayChunks.size,0);
  manager.ensureChunk(0,0).applyRemoteDelta([{worldX:1,worldY:5,worldZ:1,blockId:0}]);
  manager.dispose();assert.equal(manager.remoteOverlayChunks.size,0);
});
