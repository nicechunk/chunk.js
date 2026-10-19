import assert from 'node:assert/strict';
import test from 'node:test';
import { WebGL2VoxelRenderer } from '../renderer/webgl2-renderer.js';
import { BufferManager } from '../renderer/buffer-manager.js';
import { SortedIndexStream } from '../renderer/sorted-index-stream.js';
import { VoxelParticleLayer } from '../renderer/voxel-particle-layer.js';
import { createCameraState, cameraViewProjection } from '../renderer/camera.js';
import { loadPeasantGuyAvatarMesh } from '../renderer/avatar-mesh.js';
import { avatarAnimationRadius, selectVisibleAvatars } from '../renderer/avatar-visibility.js';
import { prepareMeshDrawRanges, prepareMeshDrawRangesSteps, materialRenderPass } from '../renderer/mesh-draw-ranges.js';
import { ProjectedShadowLayer, ShadowCasterSelection } from '../renderer/projected-shadow-layer.js';
import { instrumentGl, GpuResourceLedger } from '../renderer/gpu-diagnostics.js';
import { BLOCK_ID } from '../world/block-registry.js';
import { traceGl, packedTriangles, animatedTriangles } from './helpers/gpu-trace-gl.mjs';

const camera = () => createCameraState({worldX:0,worldY:0,worldZ:0,targetWorldX:0,targetWorldY:0,targetWorldZ:10,far:500});
const origin = {worldX:0,worldY:0,worldZ:0};
const uniforms = new Proxy({}, {get:(_,key)=>String(key)});
function fixture(shared=false) {
  const state=traceGl(), canvas={width:640,height:360,clientWidth:640,clientHeight:360,addEventListener(){},removeEventListener(){}};
  const r=new WebGL2VoxelRenderer(canvas,{useRegionBatching:false,sharedChunkBuffers:shared,shadows:false});
  Object.assign(r,{gl:state.gl,initialized:true,program:{terrain:true},uniforms,avatarProgram:{avatar:true},avatarUniforms:uniforms,
    textureArray:{bind(){},dispose(){}},multiDraw:null,multiDrawCounts:new Int32Array(16),multiDrawOffsets:new Int32Array(16)});
  r.bufferManager=new BufferManager(state.gl,{shared});
  return {...state,r};
}
const chunk=(id,mesh,x=0)=>({id,mesh,chunkX:x,chunkZ:0,chunkSize:16,meshVersion:1,version:1});
const draw=(f,chunks=[],avatars=[])=>f.r.renderTransparentScene(camera(),chunks,avatars,cameraViewProjection(camera()),origin,f.r.lighting);
function expectedTerrain(entries) {
  return entries.flatMap(entry=>(entry.handle.blendUnits??[]).filter(u=>u.pass==='blend').map(unit=>({entry,unit,
    depth:unit.center[2]+entry.chunkZ*16,key:`terrain:${entry.id}:${unit.sortOffset??unit.offset}`})))
    .sort((a,b)=>b.depth-a.depth||a.key.localeCompare(b.key))
    .flatMap(({entry,unit})=>Array.from(entry.handle.drawIndices.slice(unit.offset-(entry.handle.indexStart??0),unit.offset-(entry.handle.indexStart??0)+unit.count)));
}

for (const index32 of [false,true]) test(`sorted EBO preserves global indices, fixed opaque VAO and committed source (${index32?'UInt32':'UInt16'})`,()=>{
  const f=fixture(), c=chunk('glass',packedTriangles(2000,{index32,mixed:true}));
  const entry=f.r.uploadChunk(c), canonical=Array.from(f.buffers.get(entry.handle.ibo)), expected=expectedTerrain([entry]);
  // The new CPU mesh is deliberately not committed. Sorting must read the old
  // GPU handle's partition, never the pending replacement's index sequence.
  c.mesh=packedTriangles(1);c.meshVersion++;f.reset();draw(f,[c]);
  assert.equal(f.trace.draws.length,1);assert.deepEqual(f.trace.draws[0].indices,expected);
  assert.equal(f.trace.draws[0].type,index32?f.gl.UNSIGNED_INT:f.gl.UNSIGNED_SHORT);
  assert.notEqual(f.trace.draws[0].element,entry.handle.ibo);
  assert.deepEqual(Array.from(f.buffers.get(entry.handle.ibo)),canonical);
  assert.equal(f.vaos.get(entry.handle.vao).element,entry.handle.ibo);
  assert.equal(f.trace.uploads.filter(u=>u.transfer&&u.target===f.gl.ARRAY_BUFFER).length,0);
  f.r.renderMeshPass([c],origin,['opaque']);
  assert.equal(f.trace.draws.at(-1).element,entry.handle.ibo);
  assert.equal(f.trace.draws.at(-1).depth,true);
  f.r.dispose();
});

test('shared slices retain rebased indices and origin attribute in one sorted storage segment',()=>{
  const f=fixture(true), a=chunk('a',packedTriangles(50)), b=chunk('b',packedTriangles(50,{index32:true}),1);
  const ea=f.r.uploadChunk(a), eb=f.r.uploadChunk(b);
  assert.ok(ea.handle.sharedPage);assert.equal(ea.handle.sharedPage,eb.handle.sharedPage);assert.ok(eb.handle.vertexStart>0);
  f.reset();draw(f,[a,b]);assert.equal(f.trace.draws.length,1);
  assert.deepEqual(f.trace.draws[0].indices,expectedTerrain([ea,eb]));
  assert.equal(f.trace.draws[0].attributes.get(8).buffer,ea.handle.sharedPage.origins);
  assert.equal(f.vaos.get(ea.handle.vao).element,ea.handle.ibo);
  f.r.dispose();
});

test('failed sorted upload and exhausted index capacity fall back in exact order without touching committed storage',()=>{
  for(const failure of ['buffer','vao','subdata','capacity']) {
    const f=fixture(), c=chunk('glass',packedTriangles(40)), entry=f.r.uploadChunk(c), expected=expectedTerrain([entry]);
    if(failure==='capacity')f.r.sortedIndexStream=new SortedIndexStream(f.gl,{maxBytes:64});else f.trace.fail=failure;
    f.reset();draw(f,[c]);
    assert.deepEqual(f.trace.draws.flatMap(d=>d.indices),expected,failure);
    assert.equal(f.trace.draws.length,40,failure);assert.equal(f.vaos.get(entry.handle.vao).element,entry.handle.ibo);
    assert.ok(f.buffers.has(entry.handle.vbo));
    f.trace.fail='';f.r.sortedIndexStream?.dispose();f.r.sortedIndexStream=null;f.reset();draw(f,[c]);
    assert.equal(f.trace.draws.length,1);assert.deepEqual(f.trace.draws[0].indices,expected);
    f.r.dispose();assert.equal(f.r.sortedIndexStream,null);
  }
});

test('mixed global queue respects every particle/actor barrier and uses each prepared particle interval once',()=>{
  const f=fixture(), mesh=packedTriangles(2), data=new DataView(mesh.vertices.buffer);
  for(let tri=0;tri<2;tri++)for(let v=0;v<3;v++)data.setInt16((tri*3+v)*20+4,(tri?3:1)*64,true);
  const c=chunk('glass',mesh);f.r.uploadChunk(c);
  const body=animatedTriangles(1);delete body.parts;f.r.uploadAvatarMesh('body',body);
  const particles=new VoxelParticleLayer(f.gl,{maxParticles:16});particles.init();f.r.voxelParticles=particles;
  for(const z of [.5,2.5,4])particles.addParticle({x:0,y:0,z,size:.1,life:1,a:.5});
  f.reset();draw(f,[c],[{id:'actor',meshId:'body',worldZ:2,opacity:.5}]);
  const types=f.trace.draws.map(d=>d.instances!=null?'particle':d.attributes.get(0).type===f.gl.FLOAT?'avatar':'terrain');
  assert.deepEqual(types,['particle','terrain','particle','avatar','terrain','particle']);
  const instanceDraws=f.trace.draws.filter(d=>d.instances!=null);
  assert.deepEqual(instanceDraws.map(d=>d.attributes.get(2).offset),[0,80,160]);
  assert.deepEqual(instanceDraws.flatMap(d=>d.instanceZ),[4,2.5,.5]);
  assert.equal(f.trace.uploads.filter(u=>u.transfer&&u.buffer===particles.instanceVbo).length,1);
  assert.equal(f.trace.uploads.find(u=>u.transfer&&u.buffer===particles.instanceVbo).bytes,240);
  assert.ok(f.trace.draws.every(d=>d.depth===false));f.r.dispose();
});

test('320 ordered particles use one upload and draw; empty and oversized inputs remain bounded',()=>{
  const f=fixture(), particles=new VoxelParticleLayer(f.gl,{maxParticles:320});particles.init();f.r.voxelParticles=particles;
  for(let i=0;i<320;i++)particles.addParticle({x:2**24+.125,y:0,z:i*.1,size:.1,life:1});
  f.reset();draw(f);assert.equal(f.trace.draws.length,1);assert.equal(f.trace.draws[0].instances,320);
  assert.equal(f.trace.uploads.filter(u=>u.transfer).length,1);assert.equal(f.trace.uploads[0].bytes,25600);
  const ordered=[...particles.particles].reverse();particles.prepareInstances(ordered,{worldX:2**24,worldY:0,worldZ:0});
  particles.renderPrepared({start:0,count:320,viewProjection:cameraViewProjection(camera()),lighting:f.r.lighting});
  assert.equal(f.trace.draws.at(-1).instanceX[0],.125);
  assert.equal(particles.prepareInstances([...ordered,...ordered],origin),320);
  particles.particles.length=0;f.reset();draw(f);assert.equal(f.trace.draws.length,0);assert.equal(f.trace.uploads.length,0);f.r.dispose();
});

test('interleaved real poses have independent persistent VBOs and one pose transfer per entity',async()=>{
  const f=fixture(), mesh=await loadPeasantGuyAvatarMesh({attachIronPickaxe:true});
  f.r.uploadAvatarMesh('shared',mesh);
  const avatars=[{id:'a',meshId:'shared',opacity:.5,animation:{moving:true,timeMs:100}},
    {id:'b',meshId:'shared',opacity:.5,worldZ:.01,animation:{moving:true,timeMs:800}}];
  const cpuStorage=new Set();
  for(let frame=0;frame<4;frame++) {
    f.r.avatarFrameStates.clear();f.reset();draw(f,[],avatars);
    const a=f.r.avatarInstances.get('a'), b=f.r.avatarInstances.get('b');
    assert.notEqual(a.handle.vbo,b.handle.vbo);assert.equal(a.handle.ibo,b.handle.ibo);
    assert.notDeepEqual(a.committedVertices,b.committedVertices);
    const transfers=f.trace.uploads.filter(u=>u.transfer&&u.target===f.gl.ARRAY_BUFFER);
    assert.equal(transfers.length,2);assert.equal(transfers.reduce((n,u)=>n+u.bytes,0),mesh.vertices.byteLength*2);
    for(const state of [a,b]) {
      cpuStorage.add(state.committedVertices.buffer);cpuStorage.add(state.pendingVertices.buffer);
      assert.deepEqual(f.buffers.get(state.handle.vbo),new Uint8Array(state.committedVertices.buffer));
    }
    avatars[0].animation.timeMs+=100;avatars[1].animation.timeMs+=100;
  }
  assert.equal(cpuStorage.size,4,'two reusable CPU pose buffers per entity, no frame allocations');
  f.r.dispose();assert.equal(f.r.avatarInstances.size,0);
});

test('failed next pose retains the previous complete instance; aliases and context ownership stay separate',()=>{
  const f=fixture(), mesh=animatedTriangles(3), a={id:'a',meshId:'first',opacity:.5}, b={id:'b',meshId:'second',opacity:.5};
  const first=f.r.uploadAvatarMesh('first',mesh), second=f.r.uploadAvatarMesh('second',mesh);assert.equal(first.handle,second.handle);
  draw(f,[],[a,b]);const old=f.r.avatarInstances.get('a').handle, other=f.r.avatarInstances.get('b').handle;
  f.r.avatarFrameStates.clear();f.trace.fail='subdata';draw(f,[],[a]);
  assert.equal(f.r.avatarInstances.get('a').handle,old);assert.ok(f.buffers.has(old.vbo));
  f.trace.fail='';f.r.removeAvatarMesh('first');assert.equal(f.r.avatarInstances.has('a'),false);
  assert.ok(f.buffers.has(other.vbo));assert.ok(f.buffers.has(second.handle.ibo));
  f.r.pauseContext();assert.equal(f.r.avatarInstances.size,0);assert.equal(f.r.sortedIndexStream,null);
  assert.equal(f.r.avatarMeshes.get('second'),mesh);f.r.dispose();
});

test('known hidden tools have no blend draw, while zero-alpha vertices with a texture are retained',async()=>{
  const f=fixture(), mesh=await loadPeasantGuyAvatarMesh({attachIronPickaxe:true});f.r.uploadAvatarMesh('default',mesh);
  f.reset();draw(f,[],[{id:'player',meshId:'default',animation:{rightHand:'empty',timeMs:0}}]);assert.equal(f.trace.draws.length,0);
  const vertices=new Float32Array(3*14);for(let i=0;i<3;i++)vertices.set([i===1?1:0,i===2?1:0,2,0,0,-1,1,1,1,0,0,0,3,0],i*14);
  f.r.uploadAvatarMesh('textured',{vertices,indices:new Uint16Array([0,1,2]),vertexStrideBytes:56,indexCount:3,triangleCount:1});
  f.reset();draw(f,[],[{id:'textured',opacity:.5}]);assert.equal(f.trace.draws.length,1);assert.equal(f.trace.draws[0].count,3);f.r.dispose();
});

test('known equipment ranges leave opaque and blend sources, and failed poses keep committed visibility',async()=>{
  const f=fixture(),mesh=await loadPeasantGuyAvatarMesh({attachIronPickaxe:true});f.r.uploadAvatarMesh('body',mesh);
  const avatar={id:'player',meshId:'body',animation:{equipment:{rightHand:'empty'},timeMs:100}};
  const expectedBody=mesh.parts.filter(p=>!p.equipment).reduce((sum,p)=>sum+p.indexCount,0);
  f.reset();f.r.renderAvatars(camera(),[avatar],cameraViewProjection(camera()),origin,f.r.lighting,{opaqueOnly:true});
  assert.equal(f.trace.draws.reduce((sum,d)=>sum+d.count,0),expectedBody);
  const old=f.r.avatarInstances.get('player'),bodyRanges=old.drawState.visible.slice(0,old.drawState.visibleCount).map(r=>({...r}));
  assert.equal(old.drawState.blendCount,0,'opaque body never enters per-triangle blend classification');
  f.r.avatarFrameStates.clear();avatar.animation.equipment={rightHand:'block',equipmentId:'held_block',blockId:BLOCK_ID.ice};
  f.trace.fail='subdata';draw(f,[],[avatar]);f.trace.fail='';
  assert.deepEqual(old.drawState.visible.slice(0,old.drawState.visibleCount),bodyRanges,'visibility and GPU pose commit atomically');
  assert.equal(old.drawState.blendCount,0);
  old.retryAfter=0;f.r.avatarFrameStates.clear();f.reset();draw(f,[],[avatar]);
  const held=mesh.parts.filter(p=>p.equipmentId==='held_block').reduce((sum,p)=>sum+p.indexCount,0);
  assert.equal(f.trace.draws.reduce((sum,d)=>sum+d.count,0),held,'only the visible transparent held part enters blend sorting');f.r.dispose();
});

test('animation envelope culls before pose generation but retains equipment reach and NCM4 parent rotations',async()=>{
  const f=fixture(), mesh=await loadPeasantGuyAvatarMesh({attachIronPickaxe:true});f.r.uploadAvatarMesh('body',mesh);
  const front={id:'front',meshId:'body',worldZ:20}, back={id:'back',meshId:'body',worldZ:-200};
  const resolve=a=>f.r.avatarBuffers.get(a.meshId);
  assert.deepEqual(selectVisibleAvatars([front,back],camera(),resolve),[front]);
  const radius=avatarAnimationRadius(mesh);assert.ok(radius>mesh.bounds.height);
  const ncm4={format:'NCM4',vertices:new Float32Array(14*3),vertexStrideBytes:56,
    parts:[{cx:0,cy:0,cz:0,sx:2,sy:2,sz:2,boneIndex:0}],skeleton:{bones:[{pivot:[100,0,0],parent:1},{pivot:[0,50,0],parent:-1}]}};
  assert.ok(avatarAnimationRadius(ncm4)>300,'animated chain reach must include both distant pivots');
  assert.equal(f.r.avatarInstances.size,0,'visibility alone must not generate a pose');f.r.dispose();
});

test('shared external deadline prevents expired work; retry cooldown does not consume another channel turn',()=>{
  const f=fixture(), near=chunk('near',packedTriangles(2)), other=chunk('other',packedTriangles(2));
  f.r.options.maxUploadCpuMs=10000;
  const expired=f.r.prepareChunksForRender([near,other],{maxUploads:1,deadline:performance.now()-1});
  assert.equal(expired.uploaded,0);assert.equal(expired.uploadedBytes,0);
  f.r.retryUploads.set('opaque:near',performance.now()+10000);
  const next=f.r.prepareChunksForRender([near,other],{maxUploads:1,deadline:performance.now()+10000});
  assert.equal(next.uploaded,1);assert.ok(f.r.entryForChunk(other));assert.equal(f.r.entryForChunk(near),null);f.r.dispose();
});

test('waiting visual gets bounded progress while a nearer opaque channel changes every frame',()=>{
  const f=fixture(), near=chunk('near',packedTriangles(2));near.visualMesh=packedTriangles(2);near.visualMeshVersion=1;
  f.r.options.maxUploadCpuMs=10000;f.r.options.maxUploadBytesPerFrame=4096;
  let completed=false;
  for(let frame=0;frame<6;frame++) {
    near.mesh=packedTriangles(2);near.meshVersion++;near.gpuUploaded=false;
    f.r.prepareChunksForRender([near],{maxUploads:1});
    if(f.r.entryForChunk(near,true)) {completed=true;break;}
  }
  assert.equal(completed,true);f.r.dispose();
});

test('material partition steps yield through every linear phase and match an independent stable partition',()=>{
  const source=packedTriangles(3000,{mixed:true,index32:true}), view=new DataView(source.vertices.buffer);
  const expected={opaque:[],cutout:[],shadow:[],blend:[]};
  for(let i=0;i<source.indices.length;i+=3) {
    const layer=view.getUint16(source.indices[i]*20+16,true);
    expected[materialRenderPass(layer)].push(...source.indices.slice(i,i+3));
  }
  const steps=prepareMeshDrawRangesSteps(source,{workBudget:37}), phases=new Set();let next;
  do {next=steps.next();if(!next.done)phases.add(next.value.phase);}while(!next.done);
  const result=next.value;
  assert.deepEqual([...phases].sort(),['material-bounds','material-classification','material-index-copy','material-sort-units']);
  assert.deepEqual(Array.from(result.indices),Object.values(expected).flat());
  assert.deepEqual(result.indices,prepareMeshDrawRanges({...source}).indices);
  const validation=prepareMeshDrawRangesSteps(result,{workBudget:31});let yields=0;
  do {next=validation.next();if(!next.done){assert.equal(next.value.phase,'material-layout-validation');yields++;}}while(!next.done);
  assert.ok(yields>20);assert.equal(next.value,result);
  const duplicated={...result,blendUnits:result.blendUnits.slice()};duplicated.blendUnits[1]=duplicated.blendUnits[0];
  assert.throws(()=>prepareMeshDrawRanges(duplicated),/Duplicate/);
  assert.deepEqual(source.indices,new Uint32Array(Array.from({length:9000},(_,i)=>i)),'canonical source remains immutable');
});

test('prepare/render share visibility and viewport work while observing source changes and first uploads',()=>{
  const f=fixture(), cameraState=camera(), list=[chunk('first',packedTriangles(16))];
  f.r.options.autoResizeEachFrame=false;f.r.options.maxUploadCpuMs=10000;
  let filters=0,restores=0;
  const filter=f.r.filterChunksForCamera.bind(f.r);
  f.r.filterChunksForCamera=(...args)=>{filters++;return filter(...args);};
  f.r.restoreAvatarUploads=()=>{restores++;};
  f.r.prepareChunksForRender(list,{maxUploads:10,cameraState});
  assert.ok(f.r.entryForChunk(list[0]),'first content is an upload candidate before it owns any handle');
  const first=f.r.render(cameraState,list);assert.equal(first.visibleChunks,1);assert.equal(filters,1);assert.equal(restores,1);
  f.r.prepareChunksForRender(list,{maxUploads:10,cameraState});
  list.push(chunk('new',packedTriangles(2)));f.r.render(cameraState,list);
  assert.equal(filters,3,'in-place input additions invalidate preparation');
  f.r.prepareChunksForRender(list,{maxUploads:10,cameraState});
  list[0].mesh={...list[0].mesh,bounds:{minX:0,maxX:1,minY:0,maxY:1,minZ:-200,maxZ:-199}};list[0].meshVersion++;
  f.r.render(cameraState,list);assert.equal(filters,5,'mesh and bounds replacement invalidates a static camera');
  f.r.prepareChunksForRender(list,{maxUploads:10,cameraState});
  list[1]={...list[1],generation:2};f.r.render(cameraState,list);assert.equal(filters,7,'same-coordinate replacement invalidates source identity');
  f.r.dispose();
});

test('canvas observations run before visibility and expire prepared viewport without extra layout reads',()=>{
  const previous=globalThis.ResizeObserver;let observation,disconnected=0,reads=0;
  globalThis.ResizeObserver=class{constructor(callback){observation=callback;}observe(){}disconnect(){disconnected++;}};
  const f=fixture(), cameraState=camera(), list=[chunk('first',packedTriangles(1))];
  f.r.canvas.getBoundingClientRect=()=>{reads++;return{width:640,height:360};};
  f.r.options.dpr=1;f.r.options.maxUploadCpuMs=10000;
  try {
    f.r.prepareChunksForRender(list,{maxUploads:10,cameraState});assert.equal(cameraState.aspect,640/360);
    f.r.render(cameraState,list);assert.equal(reads,1);
    f.r.prepareChunksForRender(list,{maxUploads:10,cameraState});
    observation([{target:f.r.canvas,contentRect:{width:360,height:640}}]);
    f.r.render(cameraState,list);assert.equal(cameraState.aspect,360/640);assert.equal(f.r.canvas.width,360);assert.equal(reads,1);
    f.r.prepareChunksForRender(list,{maxUploads:10,cameraState});f.r.render(cameraState,list);assert.equal(reads,1);
  } finally {f.r.dispose();globalThis.ResizeObserver=previous;}
  assert.equal(disconnected,1);
});

test('managed frame input keys never materialize legacy whole-column arrays or inspect empty storage',()=>{
  const f=fixture(),cameraState=camera(),section=chunk('column@0',packedTriangles(16));
  f.r.options.autoResizeEachFrame=false;f.r.options.maxUploadCpuMs=10000;
  let materialized=0,filters=0;
  const summary={sectionSummary:true,vertexCount:48,indexCount:48,
    get vertices(){materialized++;throw Error('legacy whole-column vertex merge');},
    get indices(){materialized++;throw Error('legacy whole-column index merge');}};
  const column={id:'column',chunkX:0,chunkZ:0,chunkSize:16,mesh:summary,renderSections:new Map([[0,section]]),renderActiveSections:[section],renderSectionCommitRevision:1};
  const empty={...chunk('empty',null),mesh:{vertexCount:0,indexCount:0,
    get vertices(){throw Error('empty storage inspection');},get indices(){throw Error('empty storage inspection');},get bounds(){throw Error('empty bounds inspection');}}};
  const emptyColumn={id:'empty-column',chunkX:0,chunkZ:0,chunkSize:16,mesh:empty.mesh,
    renderSections:new Map([[0,empty]]),renderActiveSections:[],renderSectionCommitRevision:1};
  const input=[column,emptyColumn],filter=f.r.filterChunksForCamera.bind(f.r);
  f.r.filterChunksForCamera=(...args)=>{filters++;return filter(...args);};
  assert.doesNotThrow(()=>f.r.prepareChunksForRender(input,{cameraState,maxUploads:10}));
  assert.doesNotThrow(()=>f.r.render(cameraState,input));
  assert.equal(materialized,0);assert.equal(filters,1,'managed summary reuses prepared visibility without unpacking');
  column.renderActiveSections=[];column.renderSectionCommitRevision++;
  f.r.prepareChunksForRender(input,{cameraState,maxUploads:0});f.r.render(cameraState,input);
  assert.equal(materialized,0);f.r.dispose();
});

test('main render culls pose work and prunes instances while separate shadow candidates remain available',async()=>{
  const f=fixture(), mesh=await loadPeasantGuyAvatarMesh({attachIronPickaxe:true});f.r.uploadAvatarMesh('body',mesh);
  f.r.options.autoResizeEachFrame=false;
  const front={id:'front',meshId:'body',worldZ:20,animation:{timeMs:100}},back={id:'back',meshId:'body',worldZ:-200,animation:{timeMs:200}};
  let shadowCandidates;
  f.r.renderProjectedShadows=(avatars)=>{shadowCandidates=avatars;return{drawCalls:0,triangles:0,bufferMemory:0};};
  f.r.render(camera(),[],[front,back]);assert.ok(f.r.avatarInstances.has('front'));assert.equal(f.r.avatarInstances.has('back'),false);
  assert.deepEqual(shadowCandidates,[front,back]);
  front.worldZ=-200;back.worldZ=20;f.r.render(camera(),[],[front,back]);
  assert.equal(f.r.avatarInstances.has('front'),false);assert.ok(f.r.avatarInstances.has('back'));f.r.dispose();
});

test('projected shadows enforce the actual nearest relevant caster cap and retain offscreen-body projections',()=>{
  const f=fixture(), layer=new ProjectedShadowLayer(f.gl,{maxCasters:2}), candidates=[20,4,10,2,30].map((z,i)=>({id:String(i),worldZ:z}));
  f.reset();const stats=layer.render({viewProjection:cameraViewProjection(camera()),origin,lighting:f.r.lighting,casters:candidates,cameraState:camera()});
  assert.equal(stats.triangles,4);assert.equal(f.trace.uploads.filter(u=>u.transfer).at(-1).bytes,2*6*24);
  assert.deepEqual(layer.casterSelection.selected.map(s=>s.caster.id),['3','1']);
  const selection=new ShadowCasterSelection(1), projected={id:'offscreen-body',worldZ:-20,shadowCasterHeight:150};
  assert.equal(selection.select([projected],origin,{sunDirection:[0,.34,-1]},camera()).length,1,'projected quad intersects despite the body being behind the camera');
  assert.equal(new ShadowCasterSelection(0).select(candidates,origin,f.r.lighting,camera()).length,0);
  layer.dispose();f.r.dispose();
});

test('first-draw observability follows actual submissions and GPU counters use transferred subranges',()=>{
  const f=fixture(true), events=[];
  f.r.renderLogger={enabled:true,record:(name,data)=>events.push({name,data})};
  const c=chunk('timed',packedTriangles(16));c.meshReadyAt=performance.now()-10;
  const entry=f.r.uploadChunk(c);assert.equal(entry.firstDrawAt,null);
  draw(f,[c]);assert.ok(entry.firstDrawAt>=entry.gpuReadyAt);draw(f,[c]);
  assert.equal(events.filter(e=>e.name==='mesh-gpu-ready').length,1);
  assert.equal(events.filter(e=>e.name==='mesh-first-draw').length,1);
  const gl=traceGl().gl,ledger=new GpuResourceLedger(),tracked=instrumentGl(gl,ledger),buffer=tracked.createBuffer();
  tracked.bindBuffer(gl.ARRAY_BUFFER,buffer);tracked.bufferData(gl.ARRAY_BUFFER,1024,gl.DYNAMIC_DRAW);
  tracked.bufferSubData(gl.ARRAY_BUFFER,0,new Uint16Array(128),10,7);
  assert.equal(ledger.snapshot().uploadBytes,14,'capacity outside the WebGL2 source interval was not transferred');
  tracked.deleteBuffer(buffer);f.r.dispose();
});

test('pending upload diagnostics include shared origins and report zero while completed transfer awaits validation',()=>{
  for(const shared of [false,true]) {
    const f=fixture(shared),source=packedTriangles(16),transaction=f.r.bufferManager.beginChunkBuffers(source,{x:0,y:0,z:0});
    const stage={mesh:source,transaction,source:chunk('pending',source),awaitingValidation:false};
    f.r.uploadStaging.set('opaque:pending',stage);
    assert.equal(Boolean(transaction.origins),shared);
    assert.equal(f.r.diagnostics().pendingUploadBytes,transaction.handle.byteLength);
    f.r.bufferManager.advanceChunkBuffers(transaction,source.vertices.byteLength-13,{validate:false});
    assert.equal(f.r.diagnostics().pendingUploadBytes,transaction.handle.byteLength-transaction.uploadedBytes);
    f.r.bufferManager.advanceChunkBuffers(transaction,30,{validate:false});
    assert.equal(f.r.diagnostics().pendingUploadBytes,transaction.handle.byteLength-transaction.uploadedBytes);
    f.r.bufferManager.advanceChunkBuffers(transaction,Infinity,{validate:false});stage.awaitingValidation=true;
    assert.equal(transaction.done,true);assert.equal(transaction.uploadedBytes,transaction.handle.byteLength);
    assert.equal(f.r.diagnostics().pendingUploadBytes,0,'validation wait retains staging ownership but no untransferred bytes');
    f.r.dispose();
  }
});
