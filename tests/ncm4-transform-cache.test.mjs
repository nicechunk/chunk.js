import assert from 'node:assert/strict';
import test from 'node:test';
import { createAvatarMeshFromNcm4Character, updateAvatarMeshVertices } from '../renderer/avatar-mesh.js';
import { NCM4_BONES } from '../ncm/character-codec.js';
import { ncm4RotationForBone, sampleNcm4Action } from '../renderer/avatar-action.js';

test('cached NCM4 poses preserve exact Float32 output through ancestor, pivot, geometry and action changes',()=>{
  const mesh=createAvatarMeshFromNcm4Character({format:'NCM4',version:1,unit:1,palette:['#bb7755','#5588cc'],
    bones:NCM4_BONES.map(bone=>({...bone,pivot:[bone.id*.013,bone.id*.027,-bone.id*.019]})),
    cuboids:[{origin:[-.3,.2,-.1],size:[.6,1.7,.4],bone:17,paletteIndex:0,group:0},
      {origin:[.7,1.2,.3],size:[.8,.3,.5],bone:11,paletteIndex:1,group:0}],
    actions:[{id:1,name:'wave',duration:30,ticksPerSecond:30,loop:true,visibleGroupMask:1,keyframes:[
      {tick:0,rotations:[{bone:0,rotation:[.1,-.2,.3]},{bone:3,rotation:[-.2,.1,.4]},{bone:11,rotation:[.7,-.3,-.2]}]},
      {tick:15,rotations:[{bone:0,rotation:[-.3,.4,-.1]},{bone:3,rotation:[.2,.7,-.5]},{bone:11,rotation:[-.6,.3,.5]}]},
      {tick:30,rotations:[{bone:0,rotation:[.1,-.2,.3]},{bone:3,rotation:[-.2,.1,.4]},{bone:11,rotation:[.7,-.3,-.2]}]}]}]});
  for(let pass=0;pass<3;pass++) {
    if(pass===1){mesh.skeleton.bones[3].pivot[0]+=.123456;mesh.parts[0].sx+=.137;}
    if(pass===2){mesh.skeleton.bones[11].parent=5;mesh.actions[0].keyframes[1].rotations[0].rotation[0]+=.153;}
    for(const progress of [0,.17,.5,.91]) {
      const animation={action:'wave',progress},actual=updateAvatarMeshVertices(mesh,animation).slice(),expected=referencePose(mesh,animation);
      assert.deepEqual(actual,expected,`exact pose bytes for pass ${pass}, progress ${progress}`);
    }
  }
});

// The original scalar hierarchy formula is the independent precision oracle.
// It deliberately recomputes trig and allocates intermediate vectors; neither
// the production cache nor its prepared face/normal buffers are used here.
function referencePose(mesh,animation) {
  const rotations=sampleNcm4Action(mesh.actions,animation).rotations,out=new Float32Array(mesh.vertices.length);let at=0;
  for(const part of mesh.parts) {
    const x0=part.cx-part.sx/2,x1=part.cx+part.sx/2,y0=part.cy-part.sy/2,y1=part.cy+part.sy/2,z0=part.cz-part.sz/2,z1=part.cz+part.sz/2;
    const faces=[
      [[1,0,0],[[x1,y0,z1],[x1,y1,z1],[x1,y1,z0],[x1,y0,z0]]],
      [[-1,0,0],[[x0,y0,z0],[x0,y1,z0],[x0,y1,z1],[x0,y0,z1]]],
      [[0,1,0],[[x0,y1,z1],[x0,y1,z0],[x1,y1,z0],[x1,y1,z1]]],
      [[0,-1,0],[[x0,y0,z0],[x0,y0,z1],[x1,y0,z1],[x1,y0,z0]]],
      [[0,0,1],[[x0,y0,z1],[x0,y1,z1],[x1,y1,z1],[x1,y0,z1]]],
      [[0,0,-1],[[x1,y0,z0],[x1,y1,z0],[x0,y1,z0],[x0,y0,z0]]],
    ];
    for(const [normal,points]of faces)for(const point of points) {
      let p=point,n=normal,index=part.boneIndex;
      for(let depth=0;index>=0&&depth<mesh.skeleton.bones.length;depth++) {
        const bone=mesh.skeleton.bones[index];if(!bone)break;const rotation=ncm4RotationForBone(rotations,bone);
        p=rotate(p.map((v,axis)=>v-bone.pivot[axis]),rotation).map((v,axis)=>v+bone.pivot[axis]);
        n=rotate(n,rotation);index=bone.parent;
      }
      out.set(p,at);out.set(n,at+3);
      // Color/UV/material are independent of pose; keep their canonical bytes.
      out.set(mesh.vertices.subarray(at+6,at+14),at+6);at+=14;
    }
  }
  return out;
}
function rotate(vector,rotation) {
  let [x,y,z]=vector;const rx=rotation.x||0,ry=rotation.y||0,rz=rotation.z||0;
  if(rz){const c=Math.cos(rz),s=Math.sin(rz),nx=x*c-y*s,ny=x*s+y*c;x=nx;y=ny;}
  if(rx){const c=Math.cos(rx),s=Math.sin(rx),ny=y*c-z*s,nz=y*s+z*c;y=ny;z=nz;}
  if(ry){const c=Math.cos(ry),s=Math.sin(ry),nx=x*c+z*s,nz=-x*s+z*c;x=nx;z=nz;}
  return[x,y,z];
}
