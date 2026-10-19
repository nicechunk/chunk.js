import assert from "node:assert/strict";
import test from "node:test";
import { ChunkState } from "../chunk/chunk-state.js";

const edit={worldX:1,worldY:5,worldZ:1,blockId:0};
function fixture(){return new ChunkState({chunkX:0,chunkZ:0,chunkSize:4,height:16,minY:0,baseBlocks:new Uint16Array(4*4*16).fill(3)});}
function prepare(chunk){const task=chunk.prepareChainSnapshot([edit],{source:"rpc",snapshotToken:2,snapshotSlot:20});task.step({maxEntries:1,budgetMs:Infinity});return task;}
function finish(chunk,task){for(let i=0;i<10000&&!task.done;i++)task.step({maxEntries:1,budgetMs:Infinity});assert.ok(task.done);return chunk.commitPreparedChainSnapshot(task);}

test("render-only dirty revisions do not starve an otherwise current complete authority snapshot",()=>{
  const c=fixture(),task=prepare(c),initial=c.authorityInputRevision;
  while(!task.done){c.markDirty();task.step({maxEntries:1,budgetMs:Infinity});}
  assert.ok(c.version>1);assert.equal(c.authorityInputRevision,initial);
  assert.equal(c.commitPreparedChainSnapshot(task).applied,true);
  assert.equal(c.getFinalBlock(1,5,1),0);
});

for(const phase of ["during-preparation","before-commit"]){
  const mutations={
    pending:c=>c.applyPendingDelta([edit],"local"),
    "same-value-pending":c=>{c.applyPendingDelta([{...edit,blockId:3}],"local");},
    "pending-rollback":c=>c.rollbackPendingDelta("existing"),
    remote:c=>c.applyRemoteDelta([edit]),
    "remote-expiry":c=>{c.expireRemoteDeltas(Date.now()+6000);},
    "same-base-array-setter":c=>c.setBaseBlocks(c.baseBlocks),
  };
  for(const [name,mutate]of Object.entries(mutations))test(`${name} still rejects a stale snapshot ${phase}`,()=>{
    const c=fixture();
    if(name==="pending-rollback")c.applyPendingDelta([{...edit,worldX:2}],"existing");
    if(name==="remote-expiry")c.applyRemoteDelta([{...edit,worldX:2}]);
    const task=prepare(c);
    if(phase==="before-commit")while(!task.done)task.step({maxEntries:64,budgetMs:Infinity});
    const revision=c.authorityInputRevision;mutate(c);
    assert.ok(c.authorityInputRevision>revision);
    const result=finish(c,task);
    assert.equal(result.applied,false);assert.equal(result.reason,"stale-world-revision");
    assert.equal(c.chainDeltas.size,0);
  });
}

test("a newer acknowledged authority watermark rejects older staged data without a render change",()=>{
  const c=fixture();
  c.replaceChainDeltas([],{source:"rpc",snapshotToken:1,snapshotSlot:10});
  const task=prepare(c),renderRevision=c.version;
  assert.equal(c.acknowledgeChainSnapshot({snapshotToken:1,snapshotSlot:21}),true);
  assert.equal(c.version,renderRevision);
  assert.equal(finish(c,task).applied,false);
  assert.equal(c.chainSnapshotSlot,21);assert.equal(c.chainDeltas.size,0);
});

test("failed pending normalization leaves current preparation and its input revision intact",()=>{
  const c=fixture(),task=prepare(c),revision=c.authorityInputRevision;
  assert.throws(()=>c.applyPendingDelta([edit,{worldX:1,worldY:999,worldZ:1,blockId:0}],"invalid"));
  assert.equal(c.authorityInputRevision,revision);
  assert.equal(finish(c,task).applied,true);
});
