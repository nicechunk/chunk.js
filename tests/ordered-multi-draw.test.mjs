import test from 'node:test';
import assert from 'node:assert/strict';
import {WebGL2VoxelRenderer} from '../renderer/webgl2-renderer.js';

function fixture(useExtension) {
  const calls=[],gl={TRIANGLES:4,DEPTH_TEST:1,CULL_FACE:2,BLEND:3,SRC_ALPHA:4,ONE_MINUS_SRC_ALPHA:5,
    enable(){},disable(){},depthMask(){},blendFunc(){},useProgram(){},uniformMatrix4fv(){},uniform1f(){},uniform3f(){},bindVertexArray(){},
    drawElements:(mode,count,type,offset)=>calls.push({kind:'draw',count,type,offset})};
  const renderer=Object.create(WebGL2VoxelRenderer.prototype);
  Object.assign(renderer,{gl,program:{},uniforms:{},lighting:{},contextLost:false,disposed:false,
    multiDrawCounts:new Int32Array(2),multiDrawOffsets:new Int32Array(2),
    multiDraw:useExtension?{multiDrawElementsWEBGL:(mode,counts,countsOffset,type,offsets,offsetsOffset,count)=>{
      calls.push({kind:'multi',type,counts:Array.from(counts.subarray(countsOffset,countsOffset+count)),offsets:Array.from(offsets.subarray(offsetsOffset,offsetsOffset+count))});
    }}:null});
  const handle={vao:{},indexType:5123,indexBytes:2,blendUnits:[
    {pass:'blend',offset:0,count:3,center:[0,0,0]},
    {pass:'blend',offset:3,count:3,center:[0,0,20]},
    {pass:'blend',offset:6,count:3,center:[0,0,10]},
  ]};
  renderer.entryForChunk=(chunk,visual)=>visual?null:({id:'terrain',originY:0,handle});
  return {renderer,calls,chunk:{id:'terrain',chunkX:0,chunkZ:0,chunkSize:16}};
}

for(const extension of [false,true])test(`ordered transparent ranges keep depth order with multi-draw=${extension}`,()=>{
  const {renderer,calls,chunk}=fixture(extension);
  const stats=renderer.renderTransparentScene({worldX:0,worldY:0,worldZ:-1,targetWorldX:0,targetWorldY:0,targetWorldZ:10},[chunk],[],[],{worldX:0,worldY:0,worldZ:0},{});
  assert.equal(stats.triangles,3);
  if(extension) {
    assert.equal(stats.drawCalls,1);assert.equal(calls.length,1);
    assert.deepEqual(calls[0].counts,[6,3]);assert.deepEqual(calls[0].offsets,[6,0]);
  }else {
    assert.equal(stats.drawCalls,2);
    assert.deepEqual(calls.map(c=>[c.offset,c.count]),[[6,6],[0,3]]);
  }
});

test('zero-alpha hidden avatar equipment never enters transparent submission',()=>{
  const {renderer}=fixture(true),vertices=new Float32Array(42);
  for(let v=0;v<3;v++)vertices[v*14+12]=-1;
  const mesh={vertices,indices:new Uint16Array([0,1,2]),vertexStrideBytes:56};
  renderer.avatarBuffers=new Map([['avatar',{handle:{},mesh}]]);
  renderer.avatarFrameState=()=>({vertices});
  let draws=0;renderer.renderAvatars=()=>{draws++;return {drawCalls:1,triangles:1};};
  const render=()=>renderer.renderTransparentScene({worldZ:-1,targetWorldZ:10},[],[{id:'avatar'}],[],{worldX:0,worldY:0,worldZ:0},{});
  assert.equal(render().drawCalls,0);assert.equal(draws,0);
  vertices[9]=.5;
  assert.equal(render().drawCalls,1);assert.equal(draws,1,'visible translucent triangles remain');
  vertices[9]=0;for(let v=0;v<3;v++)vertices[v*14+12]=3;
  assert.equal(render().drawCalls,1);assert.equal(draws,2,'textured materials can override vertex alpha and must remain');
});
