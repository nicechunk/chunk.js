import test from "node:test";
import assert from "node:assert/strict";
import { decodeNcf1 } from "../forge/forge-core.js";
import { restoreForgeRuntime } from "../forge/forge-runtime-cache.js";
import { STARTER_AXE_CODE, STARTER_AXE_BYTES, SHORT_STARTER_AXE_CODE, SHORT_STARTER_AXE_BYTES, LEGACY_STARTER_AXE_CODE, LEGACY_STARTER_AXE_BYTES, forgeAvatarGripForRuntime, forgePresentationForRuntime, isStarterAxeModelBytes } from "../forge/starter-axe.js";
import { AVATAR_VERTEX_STRIDE_FLOATS as STRIDE, DEFAULT_PEASANT_GUY_NCM, createAvatarMeshFromNcm, forgeRuntimeAvatarCollisionReport, updateAvatarMeshVertices } from "../renderer/avatar-mesh.js";
import { createAvatarToolCollisionResolver } from "../physics/voxel-item-collision.js";

const current=restoreForgeRuntime(STARTER_AXE_CODE),short=restoreForgeRuntime(SHORT_STARTER_AXE_CODE),legacy=restoreForgeRuntime(LEGACY_STARTER_AXE_CODE);
const versions=[current,short,legacy];
function avatar(runtime){return createAvatarMeshFromNcm(DEFAULT_PEASANT_GUY_NCM,{scale:(1.75/.4)/2.52,attachIronPickaxe:true,attachForgedPickaxe:true,forgeRuntime:runtime,forgeMetersToWorldUnits:2.5});}
function equipment(runtime){return {rightHand:"pickaxe",equipmentId:"forged_pickaxe",forged:true,designHash:runtime.designHash};}
function bounds(){return {min:[Infinity,Infinity,Infinity],max:[-Infinity,-Infinity,-Infinity]};}
function include(box,point){for(let a=0;a<3;a++){box.min[a]=Math.min(box.min[a],point[a]);box.max[a]=Math.max(box.max[a],point[a]);}}
function overlaps(a,b){return [0,1,2].every(i=>Math.min(a.max[i],b.max[i])-Math.max(a.min[i],b.min[i])>1e-5);}
function near(a,b){for(const side of ["min","max"])for(let i=0;i<3;i++)assert.ok(Math.abs(a[side][i]-b[side][i])<1e-5,`${side}[${i}]: ${a[side][i]} vs ${b[side][i]}`);}
function snapshot(mesh,runtime,animation={}){
  const vertices=new Float32Array(updateAvatarMeshVertices(mesh,{timeMs:0,equipment:equipment(runtime),...animation}));
  const components=Array.from({length:4},bounds),hand=bounds(),body=[],tool=bounds();
  const presented=forgePresentationForRuntime(runtime),packed=new DataView(presented.mesh.vertices.buffer,presented.mesh.vertices.byteOffset,presented.mesh.vertices.byteLength);
  let cursor=0;
  for(const part of mesh.parts){
    const count=part.geometry?part.geometry.vertices.length/STRIDE:24;
    const box=bounds();
    for(let i=0;i<count;i++){
      const point=Array.from(vertices.slice((cursor+i)*STRIDE,(cursor+i)*STRIDE+3));include(box,point);
      if(part.forgedTool){const component=packed.getUint16(i*presented.mesh.vertexStrideBytes+14,true);include(components[component],point);include(tool,point);}
    }
    if(part.bone==="right_arm"){include(hand,box.min);include(hand,box.max);}
    if(!part.equipment&&!["left_arm","right_arm","right_hand_item"].includes(part.bone))body.push(box);
    cursor+=count;
  }
  return {components,hand,body,tool};
}

test("canonical axe binds the north (-Z) face of its wooden handle",()=>{
  const design=decodeNcf1(STARTER_AXE_CODE,{requireCanonical:true});const handle=design.components[0];
  assert.equal(handle.resourceId,"handle");assert.deepEqual(handle.grip,{offsetQ:[0,-17,-1],axis:2,sign:-1,rotation:0});
  assert.deepEqual(current.grip.offsetQ,[0,7,-1]);assert.ok(Math.abs(handle.grip.offsetQ[2])<=handle.dimsQ[2]/2);
  assert.ok(design.components[2].offsetQ[2]>design.components[1].offsetQ[2]);
  assert.equal(STARTER_AXE_BYTES.length,62);
});
test("only the wooden shaft doubles in length, keeping the palm anchor and head dimensions",()=>{
  assert.equal(current.components[0].dimsQ[1],2*short.components[0].dimsQ[1]);
  assert.equal(current.components[0].dimsQ[1]/64,.84375);
  assert.equal(current.components[0].dimsQ[0],short.components[0].dimsQ[0]);
  assert.equal(current.components[0].dimsQ[2],short.components[0].dimsQ[2]);
  assert.deepEqual(current.grip,short.grip);
  for(let i=1;i<4;i++){
    assert.deepEqual(current.components[i].dimsQ,short.components[i].dimsQ);
    assert.deepEqual(current.components[i].offsetQ,[short.components[i].offsetQ[0],short.components[i].offsetQ[1]+27,short.components[i].offsetQ[2]]);
  }
});
test("new and already-crafted axes point the cutting edge down while carried",()=>{
  for(const runtime of versions){
    const mesh=avatar(runtime);
    assert.equal(forgeRuntimeAvatarCollisionReport(runtime,{avatarMesh:mesh,forgeMetersToWorldUnits:2.5}).collides,false);
    for(const animation of [{moving:false},{moving:true,timeMs:Math.PI*.5/.011},{moving:true,timeMs:Math.PI*1.5/.011}]){
      const pose=snapshot(mesh,runtime,animation);const center=box=>box.min.map((x,i)=>(x+box.max[i])/2);
      const edge=center(pose.components[2]),head=center(pose.components[1]);
      assert.ok(edge[1]<head[1]-.15,"the cutting edge must face ground, not sideways");
      assert.ok(overlaps(pose.components[0],pose.hand),"the wooden handle must touch the palm");
    }
  }
});
test("handle remains in the palm and collision follows the visible axe throughout the swing",()=>{
  for(const runtime of versions){
    const mesh=avatar(runtime);const selected=equipment(runtime);
    const collision=createAvatarToolCollisionResolver({getAvatarMesh:()=>mesh,getAvatar:()=>({worldX:0,worldY:0,worldZ:0,yaw:0}),getPlayer:()=>({worldX:0,worldY:0,worldZ:0,avatarYaw:0}),getPlayerWorldFloat:()=>[0,0,0],getSelectedEquipment:()=>selected,playerBodyHeight:4.375});
    for(const pitchOffset of [-.96,0,.96])for(const progress of [.01,.1,.2,.35,.55,.75,.95,.999]){
      const pose=snapshot(mesh,runtime,{miningProgress:progress,miningAimPitch:pitchOffset});
      assert.ok(overlaps(pose.components[0],pose.hand),"swing must keep the handle on the palm");
      for(const component of pose.components)for(const body of pose.body)assert.equal(overlaps(component,body),false,"axe must stay outside the body");
      const boxes=collision.toolCollisionFrame({progress,pitchOffset}).boxes;assert.equal(boxes.length,4);
      // Cloth wrapping has its own visual flutter. Rigid handle, head and edge
      // must each track their physical collision box exactly.
      for(let i=0;i<3;i++){const box=boxes[i];near(pose.components[i],{min:[box.minX,box.minY,box.minZ],max:[box.maxX,box.maxY,box.maxZ]});}
    }
  }
});
test("legacy custody bytes and equipment attributes stay intact with the same mounted shape",()=>{
  const a=snapshot(avatar(current),current);
  for(const runtime of versions){
    const oldGrip=structuredClone(runtime.grip),oldDesign=structuredClone(runtime.design),oldBytes=Array.from(runtime.bytes),oldHash=runtime.designHash;
    assert.equal(isStarterAxeModelBytes(runtime.bytes),true);
    assert.deepEqual(current.design.equipment,runtime.design.equipment);
    const b=snapshot(avatar(runtime),runtime);
    for(let i=0;i<4;i++)near(a.components[i],b.components[i]);
    assert.deepEqual(runtime.grip,oldGrip);assert.deepEqual(runtime.design,oldDesign);
    assert.deepEqual(Array.from(runtime.bytes),oldBytes);assert.equal(runtime.designHash,oldHash);
    assert.equal(avatar(runtime).parts.find(p=>p.forgedTool).forgeDesignHash,oldHash);
  }
  assert.equal(short.code,SHORT_STARTER_AXE_CODE);assert.equal(legacy.code,LEGACY_STARTER_AXE_CODE);
  assert.notEqual(legacy.designHash,current.designHash);assert.notEqual(short.designHash,current.designHash);
});
test("compatibility applies only to exact legacy axe bytes",()=>{
  for(const expected of [LEGACY_STARTER_AXE_BYTES,SHORT_STARTER_AXE_BYTES]){
    const bytes=Uint8Array.from(expected);bytes[bytes.length-1]^=1;
    const ordinary={bytes,grip:{offsetQ:[1,2,3],axis:1,sign:1,rotation:2}};
    assert.equal(isStarterAxeModelBytes(bytes),false);assert.equal(forgeAvatarGripForRuntime(ordinary),ordinary.grip);
    assert.equal(forgePresentationForRuntime(ordinary),ordinary);
  }
  assert.equal(forgeAvatarGripForRuntime(current),current.grip);
  assert.equal(forgePresentationForRuntime({grip:current.grip})?.grip,current.grip);
});
