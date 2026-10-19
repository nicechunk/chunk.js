import assert from 'node:assert/strict';
import test from 'node:test';
import {resolveCameraCollisionSegment,isCameraVolumeClear} from '../input/camera-collision.js';

// Enumerate every voxel in the swept enclosure independently of the DDA.
function oracle(start,end,blocked,radius,skin) {
 const delta=end.map((v,i)=>v-start[i]),length=Math.hypot(...delta),direction=delta.map(v=>v/length);
 let nearest=Infinity;
 const lower=start.map((v,i)=>Math.floor(Math.min(v,end[i])-radius)-1);
 const upper=start.map((v,i)=>Math.floor(Math.max(v,end[i])+radius)+1);
 for(let z=lower[2];z<=upper[2];z++)for(let y=lower[1];y<=upper[1];y++)for(let x=lower[0];x<=upper[0];x++) {
  if(!blocked(x,y,z))continue;
  const voxel=[x,y,z];let enter=0,exit=length;
  for(let a=0;a<3;a++) {
   const lo=voxel[a]-radius+1e-7,hi=voxel[a]+1+radius-1e-7;
   if(Math.abs(direction[a])<1e-7){if(start[a]<=lo||start[a]>=hi){exit=-Infinity;break;}}
   else {
    const times=[(lo-start[a])/direction[a],(hi-start[a])/direction[a]].sort((a,b)=>a-b);
    enter=Math.max(enter,times[0]);exit=Math.min(exit,times[1]);
   }
  }
  if(enter<=exit&&exit>=0)nearest=Math.min(nearest,Math.max(0,enter));
 }
 const distance=Number.isFinite(nearest)?Math.max(0,Math.min(length,nearest-skin-1e-7)):length;
 return {point:start.map((v,i)=>v+direction[i]*distance),distance};
}

test('deduplicated camera sweeps match an exhaustive voxel/slab oracle',()=>{
 let seed=83721;const random=()=>((seed=(Math.imul(seed,1664525)+1013904223)>>>0)/2**32);
 const blocked=(x,y,z)=>y<0||(x===3&&y<8)||(z===-3&&(x+y)%3===0);
 let cases=0;
 for(const radius of [0,.24,.7,1.35])for(let i=0;i<120;i++) {
  const start=[random()*12-6,random()*5+2,random()*12-6],end=[random()*16-8,random()*9,random()*16-8];
  if(!isCameraVolumeClear(...start,blocked,radius))continue;
  const expected=oracle(start,end,blocked,radius,.1),actual=resolveCameraCollisionSegment(...start,...end,blocked,{radius,skin:.1});
  assert.ok(Math.abs(actual.distance-expected.distance)<1e-6);
  for(const [i,k]of ['x','y','z'].entries())assert.ok(Math.abs(actual[k]-expected.point[i])<1e-6);
  cases++;
 }
 assert.ok(cases>200);
});

test('camera visit scratch remains independent during reentrant queries and oversized sweeps',()=>{
 const blocked=x=>x===4;
 let querying=false,nested=0;
 const provider=(x,y,z)=>{
  if(!querying){querying=true;
   const inner=resolveCameraCollisionSegment(.5,4,.5,8.5,4,.5,blocked,{radius:.24,skin:.1});
   assert.ok(Math.abs(inner.x-3.66)<1e-6);nested++;querying=false;
  }
  return blocked(x,y,z);
 };
 const a=resolveCameraCollisionSegment(.5,4,.5,8.5,4,.5,provider,{radius:.24,skin:.1});
 assert.ok(Math.abs(a.x-3.66)<1e-6);assert.ok(nested>0);
 const start=[.5,4,.5],end=[70,40,70],expected=oracle(start,end,blocked,.24,.1);
 const large=resolveCameraCollisionSegment(...start,...end,blocked,{radius:.24,skin:.1});
 assert.ok(Math.abs(large.distance-expected.distance)<1e-6,'oversized visit grid must keep the exact sweep fallback');
 const again=resolveCameraCollisionSegment(.5,4,.5,8.5,4,.5,blocked,{radius:.24,skin:.1});
 assert.ok(Math.abs(again.x-3.66)<1e-6,'old visit bits must be cleared');
});
