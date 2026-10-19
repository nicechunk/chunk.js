import test from 'node:test';
import assert from 'node:assert/strict';
import {WebGL2VoxelRenderer} from '../renderer/webgl2-renderer.js';
import {BufferManager} from '../renderer/buffer-manager.js';
import {traceGl,packedTriangles} from './helpers/gpu-trace-gl.mjs';

function fixture(extension) {
  const state=traceGl(),renderer=new WebGL2VoxelRenderer({width:640,height:360,addEventListener(){},removeEventListener(){}},{useRegionBatching:false,sharedChunkBuffers:false});
  const uniforms=new Proxy({},{get:(_,key)=>String(key)});
  Object.assign(renderer,{gl:state.gl,initialized:true,program:{},uniforms,avatarProgram:{},avatarUniforms:uniforms,
    bufferManager:new BufferManager(state.gl),textureArray:{bind(){},dispose(){}},
    multiDraw:extension?{multiDrawElementsWEBGL(){throw Error('Sorted EBO must not require the optional extension');}}:null});
  return {...state,renderer};
}
const camera={worldX:0,worldY:0,worldZ:-1,targetWorldX:0,targetWorldY:0,targetWorldZ:10};
const origin={worldX:0,worldY:0,worldZ:0};
for(const extension of [false,true])test(`ordered transparent indices preserve depth order with optional multi-draw=${extension}`,()=>{
  const f=fixture(extension),mesh=packedTriangles(3),view=new DataView(mesh.vertices.buffer);
  for(let i=0;i<3;i++)for(let v=0;v<3;v++)view.setInt16((i*3+v)*20+4,[0,20,10][i]*64,true);
  const chunk={id:'terrain',chunkX:0,chunkZ:0,chunkSize:16,mesh,meshVersion:1,version:1};
  f.renderer.uploadChunk(chunk);f.reset();
  const stats=f.renderer.renderTransparentScene(camera,[chunk],[],[],origin,f.renderer.lighting);
  assert.equal(stats.triangles,3);assert.equal(stats.drawCalls,1);
  assert.deepEqual(f.trace.draws[0].indices,[3,4,5,6,7,8,0,1,2]);
  f.renderer.dispose();
});

test('zero-alpha untextured hidden equipment exits submission while a textured fading face remains visible',()=>{
  const f=fixture(false);
  function render(alpha,layer) {
    const vertices=new Float32Array(42);
    for(let v=0;v<3;v++)vertices.set([v===1?1:0,v===2?1:0,2,0,0,-1,1,1,1,alpha,0,0,layer,0],v*14);
    f.renderer.uploadAvatarMesh('avatar',{vertices,indices:new Uint16Array([0,1,2]),vertexStrideBytes:56,indexCount:3,triangleCount:1});
    f.renderer.avatarFrameStates.clear();f.reset();
    return f.renderer.renderTransparentScene(camera,[],[{id:'avatar',opacity:.5}],[],origin,f.renderer.lighting);
  }
  assert.equal(render(0,-1).drawCalls,0);
  assert.equal(render(.5,-1).drawCalls,1);
  assert.equal(render(0,3).drawCalls,1,'texture alpha overrides vertex alpha before actor opacity');
  f.renderer.dispose();
});
