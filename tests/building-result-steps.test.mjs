import assert from "node:assert/strict";
import test from "node:test";
import { createBlueprint, encodeNcm3 } from "../ncm/blueprint-codec.js";
import { parseNcm3Building, createBuildingPlacement } from "../construction/building-parser.js";
import { createBuildingChunkMeshes } from "../construction/building-mesher.js";
import { createBuildingMeshResult, createBuildingMeshResultSteps,
  validateBuildingMeshResult, validateBuildingMeshResultSteps } from "../construction/building-mesh-result.js";

function fixture() {
  const code = encodeNcm3(createBlueprint({x: 24, y: 8, z: 24}, "validation-slices")
    .box(64, 0, 0, 0, 24, 1, 24).box(62, 0, 1, 0, 1, 6, 24)
    .box(58, 23, 1, 0, 1, 6, 24).box(96, 1, 7, 1, 22, 1, 22));
  const foundation = {id: "ground", minX: -19, minZ: 14, surfaceY: 111, width: 32, depth: 32};
  const request = {code,foundation,quarterTurns: 1,chunkSize: 16,revision: 7};
  const building = parseNcm3Building(code);
  const placement = createBuildingPlacement(building, foundation, {quarterTurns: 1, materializeWorldVoxels: false});
  const chunks = createBuildingChunkMeshes(placement, {revision: 7});
  return {building,placement,chunks,request,result:createBuildingMeshResult(building,placement,chunks)};
}
function finish(iterator, onYield = () => {}) {
  let step;
  do {step=iterator.next();if(!step.done)onYield(step.value);}while(!step.done);
  return step.value;
}

test("progressive summary and validation preserve the exact result and buffer ownership", () => {
  const {building,placement,chunks,request,result} = fixture();
  let summarySlices=0;
  const summary=finish(createBuildingMeshResultSteps(building,placement,chunks,{workBudget:1}),()=>summarySlices++);
  assert.deepEqual(summary,result);assert.ok(summarySlices>1);
  for(let i=0;i<chunks.length;i++){
    assert.strictEqual(summary.chunks[i].mesh.vertices,chunks[i].mesh.vertices);
    assert.strictEqual(summary.chunks[i].collisionMask,chunks[i].collisionMask);
  }
  const phases=new Set();
  assert.strictEqual(finish(validateBuildingMeshResultSteps(summary,{request,workBudget:8}),step=>phases.add(step.phase)),summary);
  assert.strictEqual(validateBuildingMeshResult(summary,{request}),summary);
  assert.ok(phases.has("building-result-indices"));
  assert.ok(phases.has("building-result-collision"));
  assert.ok(phases.has("building-result-code-id"));
});

test("index validation yields with bounded reads and cancellation changes no owned result data", () => {
  const {result,request}=fixture(), mesh=result.chunks[0].mesh;
  let reads=0, slices=0;
  const iterate=mesh.indices[Symbol.iterator].bind(mesh.indices);
  mesh.indices[Symbol.iterator]=function*(){for(const index of iterate()){reads++;yield index;}};
  const iterator=validateBuildingMeshResultSteps(result,{request,workBudget:8});
  let step;
  do {
    reads=0;step=iterator.next();
    assert.ok(reads<=9,`validation read ${reads} indices before yielding`);
    if(!step.done)slices++;
  }while(!step.done);
  assert.strictEqual(step.value,result);assert.ok(slices>10);
  delete mesh.indices[Symbol.iterator];
  const snapshot=structuredClone(result),cancelled=validateBuildingMeshResultSteps(result,{request,workBudget:1});
  assert.equal(cancelled.next().done,false);cancelled.return();
  assert.equal(cancelled.next().done,true);assert.deepEqual(result,snapshot);
});

test("malicious late indices and collision changes retain the protocol rejection code after yields", () => {
  for(const mode of ["late-index","collision-count","unexpected-array-field","reused-buffer"]){
    const {result,request}=fixture();
    if(mode==="late-index"){
      const mesh=result.chunks.at(-1).visualMesh ?? result.chunks.at(-1).mesh;
      mesh.indices[mesh.indices.length-1]=mesh.vertexCount;
    }else if(mode==="collision-count")result.chunks.at(-1).collisionBlockCount++;
    else if(mode==="unexpected-array-field")result.chunks.unexpected=true;
    else result.chunks.at(-1).mesh.vertices=result.chunks[0].mesh.vertices;
    let slices=0;
    assert.throws(()=>finish(validateBuildingMeshResultSteps(result,{request,workBudget:8}),()=>slices++),error=>error.code==="building-mesh-result-invalid",mode);
    assert.throws(()=>validateBuildingMeshResult(result,{request}),error=>error.code==="building-mesh-result-invalid",mode);
    assert.ok(slices>0,mode);
  }
});
