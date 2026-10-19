import { meshChunkOpaque, meshChunkOpaqueFast, meshChunkVisual, packChunkVertices } from "./chunk-mesher.js";
import { deltaKey } from "./chunk-delta.js";
import { bakeSectionLighting } from "./baked-light-field.js";
import { isVisualBlock,isOpaqueSolidBlock,BLOCK_ID } from "../world/block-registry.js";
import { prepareMeshDrawRanges } from "../renderer/mesh-draw-ranges.js";

export const RENDER_SECTION_HEIGHT = 16;
let generationSerial = 1;
let submissionSerial = 1;

export function sectionIndexAt(chunk, y) {
  return Math.floor((y - chunk.minY) / RENDER_SECTION_HEIGHT);
}

export function ensureRenderSections(chunk) {
  if (chunk.renderSections) return chunk.renderSections;
  chunk.generation ??= generationSerial++;
  chunk.renderSections = new Map();
  chunk.renderDeltaColumns = new Map();
  chunk.renderDeltaSections = new Map();
  chunk.renderColumnRevisions = new Map();
  chunk.renderColumnEpoch = 1;
  for (const delta of chunk.getFinalDeltaMap().values()) indexDelta(chunk, delta);
  chunk.renderColumnTops=new Map();
  for(let z=0;z<chunk.chunkSize;z++)for(let x=0;x<chunk.chunkSize;x++)chunk.renderColumnTops.set(x+z*chunk.chunkSize,finalColumnTop(chunk,x,z));
  for (let i = 0; i < Math.ceil(chunk.height / RENDER_SECTION_HEIGHT); i++) {
    const originY = chunk.minY + i * RENDER_SECTION_HEIGHT;
    chunk.renderSections.set(i, {
      id: `${chunk.id}@${i}`, parentId: chunk.id, sectionIndex: i,
      generation: generationSerial++, chunkX: chunk.chunkX, chunkZ: chunk.chunkZ,
      chunkSize: chunk.chunkSize, originY,
      height: Math.min(RENDER_SECTION_HEIGHT, chunk.minY + chunk.height - originY),
      dataRevision: 0, haloRevision: 0, lightRevision: 0, materialVersion: chunk.materialVersion,
      meshVersion: -1, visualMeshVersion: -1, meshCommitToken: 0, visualCommitToken: 0,
      mesh: null, visualMesh: null, dirty: true, visualDirty: true,
      dirtyReason: "initial", oldestDirtyAt: performance.now(), buildState: "ready",
      buildTaskId: null, visualError: null, visualRetryAt: 0, visualFailures: 0,
      gpuUploaded: false, visualGpuUploaded: false,
    });
  }
  chunk.invalidateRenderSections = (deltas, reason = "edit") => invalidateRenderSections(chunk, deltas, reason);
  chunk.prepareRenderSnapshotInvalidation=(next,changes,options)=>prepareRenderSnapshotInvalidation(chunk,next,changes,options);
  return chunk.renderSections;
}

// Expensive full-snapshot index preparation is isolated from the live world.
// The authority state machine steps this generator under the same frame budget
// as normalization, then validates its world revision before the constant-size
// reference swap. No collider or renderer can observe these partial maps.
export function* prepareRenderSnapshotInvalidation(chunk,nextChain,changes,{dropRemote=false}={}) {
  const instance=chunk.renderSections;
  if(!changes.length)return {handlesNeighborhood:false,isCurrent:()=>chunk.renderSections===instance,commit(){}};
  const final=new Map(),columns=new Map(),sections=new Map(),tops=new Map(),data=new Set(),light=new Set();
  for(const [key,delta]of nextChain){final.set(key,delta);yield;}
  if(!dropRemote)for(const [key,delta]of chunk.remoteDeltas??[]){final.set(key,delta);yield;}
  for(const [key,delta]of chunk.pendingDeltas){final.set(key,delta);yield;}
  for(const [key,delta]of final){
    const column=delta.localX+delta.localZ*chunk.chunkSize,index=sectionIndexAt(chunk,delta.localY);
    let list=columns.get(column);if(!list)columns.set(column,list=new Map());list.set(key,delta);
    list=sections.get(index);if(!list)sections.set(index,list=new Map());list.set(key,delta);yield;
  }
  let skyBelow=-Infinity;
  for(let z=0;z<chunk.chunkSize;z++)for(let x=0;x<chunk.chunkSize;x++) {
    const column=x+z*chunk.chunkSize;
    let candidate=chunk.baseProfile?Math.min(chunk.minY+chunk.height-1,chunk.baseProfile.surfaceY[column]):chunk.minY+chunk.height-1;
    for(const delta of columns.get(column)?.values()??[]){if(isOpaqueSolidBlock(delta.blockId))candidate=Math.max(candidate,delta.localY);yield;}
    let top=chunk.minY-1;
    for(let y=candidate;y>=chunk.minY;y--) {
      const block=final.get(deltaKey(x,y,z,chunk.chunkSize))?.blockId??chunk.getBaseBlock(x,y,z);
      yield;if(isOpaqueSolidBlock(block)){top=y;break;}
    }
    const before=chunk.renderColumnTops.get(column);
    if(before!==top)skyBelow=Math.max(skyBelow,before??top,top);
    tops.set(column,top);yield;
  }
  for(const delta of changes){
    const y=delta.localY??delta.worldY;
    for(const sy of [y-1,y,y+1])data.add(sectionIndexAt(chunk,sy));
    for(const sy of [y-4,y,y+4])light.add(sectionIndexAt(chunk,sy));yield;
  }
  // Tree proxies are sparse and owned by their base section. Conservatively
  // refresh these owners on an authoritative snapshot without an N*tree loop.
  for(const tree of chunk.treeInstances??[]){data.add(sectionIndexAt(chunk,tree.baseY));yield;}
  const neighborhood=chunk.prepareRenderSnapshotNeighborhood?yield* chunk.prepareRenderSnapshotNeighborhood(changes):null;
  return {handlesNeighborhood:Boolean(neighborhood),isCurrent:()=>chunk.renderSections===instance,commit(){
    chunk.renderDeltaColumns=columns;chunk.renderDeltaSections=sections;chunk.renderColumnTops=tops;
    chunk.renderColumnRevisions=new Map();chunk.renderColumnEpoch++;chunk.renderInvalidationPending=true;
    for(const [index,section]of chunk.renderSections) {
      if(data.has(index)){section.dataRevision++;section.haloRevision++;}
      else if(!light.has(index)&&section.originY>skyBelow)continue;
      if(!data.has(index)&&!section.mesh?.indexCount&&!section.visualMesh?.indexCount)continue;
      section.lightRevision++;section.dirty=true;section.visualDirty=true;section.dirtyReason="atomic-snapshot";section.oldestDirtyAt??=performance.now();
    }
    neighborhood?.commit();
  }};
}

function indexDelta(chunk, delta) {
  const key = deltaKey(delta.localX, delta.localY, delta.localZ, chunk.chunkSize);
  const column = delta.localX + delta.localZ * chunk.chunkSize;
  const section = sectionIndexAt(chunk, delta.localY);
  chunk.renderColumnRevisions.set(column,(chunk.renderColumnRevisions.get(column)??0)+1);
  for (const [map,id] of [[chunk.renderDeltaColumns,column],[chunk.renderDeltaSections,section]]) {
    let list = map.get(id);
    if (!list) map.set(id, list = new Map());
    list.set(key, delta);
  }
}

export function invalidateRenderSections(chunk, deltas = null, reason = "edit") {
  if (!chunk.renderSections) return;
  chunk.renderInvalidationPending = true;
  const affected = new Set();
  const nearbyLight = new Set();
  let skyChangedBelow=-Infinity;
  if (deltas === null) {
    for (const index of chunk.renderSections.keys()) affected.add(index);
    chunk.renderDeltaColumns.clear(); chunk.renderDeltaSections.clear();
    chunk.renderColumnRevisions.clear();chunk.renderColumnEpoch++;
    for (const delta of chunk.getFinalDeltaMap().values()) indexDelta(chunk, delta);
    chunk.renderColumnTops.clear();
    for(let z=0;z<chunk.chunkSize;z++)for(let x=0;x<chunk.chunkSize;x++)chunk.renderColumnTops.set(x+z*chunk.chunkSize,finalColumnTop(chunk,x,z));
  } else {
    for (const delta of deltas) {
      const y = delta.localY ?? delta.worldY;
      for (const sy of [y-1,y,y+1]) affected.add(sectionIndexAt(chunk, sy));
      for(const sy of [y-4,y,y+4])nearbyLight.add(sectionIndexAt(chunk,sy));
      if (delta.localX !== undefined) {
        const key=deltaKey(delta.localX,y,delta.localZ,chunk.chunkSize);
        const current=chunk.pendingDeltas.get(key) ?? chunk.remoteDeltas?.get(key) ?? chunk.chainDeltas.get(key);
        if (current) indexDelta(chunk,current);
        else {
          chunk.renderDeltaColumns.get(delta.localX+delta.localZ*chunk.chunkSize)?.delete(key);
          chunk.renderDeltaSections.get(sectionIndexAt(chunk,y))?.delete(key);
          const column=delta.localX+delta.localZ*chunk.chunkSize;
          chunk.renderColumnRevisions.set(column,(chunk.renderColumnRevisions.get(column)??0)+1);
        }
        const column=delta.localX+delta.localZ*chunk.chunkSize;
        const before=chunk.renderColumnTops.get(column),after=finalColumnTop(chunk,delta.localX,delta.localZ);
        if(before!==after)skyChangedBelow=Math.max(skyChangedBelow,before??after,after);
        chunk.renderColumnTops.set(column,after);
      }
      // A tree is owned by the section containing its base; a canopy edit must
      // also rebuild that owner, even when the crown crosses a section boundary.
      for (const tree of chunk.treeInstances ?? []) {
        if (Math.abs((delta.worldX ?? 0)-tree.x)<=5 && Math.abs((delta.worldZ ?? 0)-tree.z)<=5
          && y>=tree.baseY && y<=tree.baseY+tree.trunkHeight+8) affected.add(sectionIndexAt(chunk,tree.baseY));
      }
    }
  }
  for (const index of affected) {
    const section=chunk.renderSections.get(index); if (!section) continue;
    section.dataRevision++; section.haloRevision++; section.lightRevision++;
    section.dirty = true; section.visualDirty = true; section.dirtyReason = reason;
    section.oldestDirtyAt ??= performance.now();
  }
  for(const [index,section] of chunk.renderSections) {
    if(affected.has(index)||(!nearbyLight.has(index)&&section.originY>skyChangedBelow))continue;
    if(!section.mesh?.indexCount&&!section.visualMesh?.indexCount)continue;
    section.lightRevision++;section.dirty=true;section.visualDirty=true;
    section.dirtyReason="sky-or-local-light";section.oldestDirtyAt??=performance.now();
  }
}

function finalColumnTop(chunk,x,z) {
  let candidate=chunk.baseProfile?Math.min(chunk.minY+chunk.height-1,chunk.baseProfile.surfaceY[x+z*chunk.chunkSize]):chunk.minY+chunk.height-1;
  for(const delta of chunk.renderDeltaColumns.get(x+z*chunk.chunkSize)?.values()??[])if(isOpaqueSolidBlock(delta.blockId))candidate=Math.max(candidate,delta.localY);
  for(let y=candidate;y>=chunk.minY;y--)if(isOpaqueSolidBlock(chunk.getFinalBlock(x,y,z)))return y;
  return chunk.minY-1;
}

export function sectionRevision(section, materialVersion = section.materialVersion) {
  return `${section.generation}:${section.dataRevision}:${section.haloRevision}:${section.lightRevision}:${materialVersion}`;
}

export function sectionDeltaValues(chunk, index, marginSections = 1) {
  ensureRenderSections(chunk);
  const values=[];
  for(let i=index-marginSections;i<=index+marginSections;i++) for(const delta of chunk.renderDeltaSections.get(i)?.values() ?? []) values.push(delta);
  return values;
}

export function buildRenderSection(chunk, section, access = {}, { visualOnly = false } = {}) {
  const startedAt=performance.now();
  const view=Object.create(chunk);
  view.minY=section.originY; view.height=section.height; view.renderOriginY=section.originY;
  view.baseProfile=null;
  view.getBaseBlock=chunk.getBaseBlock.bind(chunk);
  view.hasDeltaAt=chunk.hasDeltaAt.bind(chunk);
  view.treeInstances=(chunk.treeInstances ?? []).filter(t=>sectionIndexAt(chunk,t.baseY)===section.sectionIndex);
  const localDeltas=new Map();
  for(const delta of sectionDeltaValues(chunk,section.sectionIndex))localDeltas.set(deltaKey(delta.localX,delta.localY,delta.localZ,chunk.chunkSize),delta);
  view.getFinalDeltaMap=()=>localDeltas;
  const margin=8,width=chunk.chunkSize+margin*2,cacheHeight=section.height+margin*2;
  const originX=chunk.chunkX*chunk.chunkSize-margin,originZ=chunk.chunkZ*chunk.chunkSize-margin,originY=section.originY-margin;
  const voxels=new Uint16Array(width*width*cacheHeight);voxels.fill(65535);
  let voxelQueries=0,voxelVisits=0;
  const columns=new Map();
  const getWorld=(x,y,z)=>{
    voxelVisits++;
    const lx=x-chunk.chunkX*chunk.chunkSize,lz=z-chunk.chunkZ*chunk.chunkSize;
    const cx=x-originX,cy=y-originY,cz=z-originZ;
    const key=cx>=0&&cy>=0&&cz>=0&&cx<width&&cz<width&&cy<cacheHeight?cx+cz*width+cy*width*width:-1;
    if(key>=0&&voxels[key]!==65535)return voxels[key];
    voxelQueries++;
    const block=lx>=0&&lz>=0&&lx<chunk.chunkSize&&lz<chunk.chunkSize
      ?chunk.getFinalBlock(lx,y,lz):(access.getBlockAtWorld?.(x,y,z) ?? 0);
    if(key>=0)voxels[key]=block;
    return block;
  };
  view.getFinalBlock=(x,y,z)=>getWorld(chunk.chunkX*chunk.chunkSize+x,y,chunk.chunkZ*chunk.chunkSize+z);
  const snapshotAccess={...access,getBlockAtWorld:getWorld,getColumnTopAtWorld:(x,z)=>{
    const key=`${x}:${z}`;
    if(columns.has(key))return columns.get(key);
    const value=access.getColumnTopAtWorld?.(x,z)??chunk.minY+chunk.height;
    columns.set(key,value);return value;
  }};
  if(!snapshotAccess.neighborDeltas&&access.getNeighborDeltas) snapshotAccess.neighborDeltas=access.getNeighborDeltas(section.sectionIndex);
  const opaqueView=Object.create(view);
  opaqueView.baseProfile=chunk.baseProfile;
  // Generated profile columns have no unrecorded underground cavities. Use the
  // complete delta/halo candidate mesher within this bounded vertical slice.
  let mesh=visualOnly?null:(chunk.baseProfile?meshChunkOpaqueFast(opaqueView,snapshotAccess):meshChunkOpaque(view,snapshotAccess));
  let visualMesh=null,visualError=null;
  let visualPossible=!chunk.baseProfile||view.treeInstances.length>0;
  if(chunk.baseProfile) {
    const end=section.originY+section.height;
    for(let i=0;i<chunk.chunkSize*chunk.chunkSize&&!visualPossible;i++) {
      const surface=chunk.baseProfile.surfaceY[i],water=chunk.baseProfile.waterY[i];
      visualPossible=(surface>=section.originY-1&&surface<end)||(water!==chunk.baseProfile.noWater&&water>=section.originY&&water<end);
    }
    for(const delta of localDeltas.values())if(delta.localY>=section.originY&&delta.localY<end&&(isVisualBlock(delta.blockId)||delta.blockId===BLOCK_ID.cactus))visualPossible=true;
  }
  try { visualMesh=visualPossible?meshChunkVisual(view,snapshotAccess):emptySectionMesh(chunk,section); }
  catch(error) { visualError=error?.message || String(error); }
  for(const part of [mesh,visualMesh]) if(part) {
    part.sectionIndex=section.sectionIndex;
    part.originY=section.originY;
    // Models owned by a section can extend into the section above it.
    part.bounds=packedMeshBounds(part);
  }
  const lighting=bakeSectionLighting(chunk,section,snapshotAccess,[mesh,visualMesh],access.caveLighting);
  // Prepare material ranges in the same bounded task, including inside the real
  // Worker. The GPU uploader validates and reuses these immutable partitions.
  if(mesh)mesh=prepareMeshDrawRanges(mesh);
  if(visualMesh)visualMesh=prepareMeshDrawRanges(visualMesh);
  return {mesh,visualMesh,visualError,lighting,voxelQueries,voxelVisits,voxelCacheBytes:voxels.byteLength,opaqueCellBudget:chunk.chunkSize*chunk.chunkSize*section.height,elapsedMs:performance.now()-startedAt};
}

function emptySectionMesh(chunk,section) {
  return {vertices:new Uint8Array(),indices:new Uint16Array(),vertexCount:0,indexCount:0,triangleCount:0,quadCount:0,blockCount:0,vertexStrideBytes:20,chunkX:chunk.chunkX,chunkZ:chunk.chunkZ,chunkSize:chunk.chunkSize,originY:section.originY};
}

export function commitRenderSection(chunk, section, result, expectedRevision = sectionRevision(section,chunk.materialVersion)) {
  if (sectionRevision(section,chunk.materialVersion)!==expectedRevision) return false;
  if(result.mesh) {
    section.mesh=result.mesh; section.meshVersion=section.dataRevision;
    section.meshCommitToken=submissionSerial++; section.gpuUploaded=false; section.dirty=false;
  }
  if(result.visualError) {
    section.visualError=result.visualError; section.visualDirty=true; section.visualFailures++;
    section.visualRetryAt=performance.now()+Math.min(3200,100*2**Math.min(5,section.visualFailures-1));
  } else {
    section.visualMesh=result.visualMesh; section.visualMeshVersion=section.dataRevision;
    section.visualCommitToken=submissionSerial++; section.visualGpuUploaded=false;
    section.visualDirty=false;section.visualError=null;section.visualFailures=0;section.visualRetryAt=0;
  }
  section.materialVersion=chunk.materialVersion;
  section.buildTaskId=null;section.buildState="ready";
  if(!section.dirty&&!section.visualDirty)section.oldestDirtyAt=null;
  updateChunkSectionSummary(chunk);
  return true;
}

export function updateChunkSectionSummary(chunk) {
  const sections=[...chunk.renderSections.values()];
  chunk.mesh=combinedSectionMesh(chunk,sections,"mesh");
  chunk.visualMesh=combinedSectionMesh(chunk,sections,"visualMesh");
  chunk.dirty=sections.some(s=>s.dirty||s.visualDirty);
  if(!sections.some(s=>s.dirty))chunk.meshVersion=chunk.version;
  if(!sections.some(s=>s.visualDirty))chunk.visualMeshVersion=chunk.version;
  chunk.buildState="ready";chunk.buildTaskId=null;chunk.gpuUploaded=false;chunk.visualGpuUploaded=false;
}

// Legacy readers can still request one whole-chunk mesh. Renderer paths consume
// sections directly, so no packing occurs during normal visibility/rotation.
function combinedSectionMesh(chunk,sections,field) {
  const meshes=sections.map(s=>s[field]).filter(Boolean);
  if(!meshes.length)return null;
  const summary={chunkX:chunk.chunkX,chunkZ:chunk.chunkZ,chunkSize:chunk.chunkSize,minY:chunk.minY,height:chunk.height,originY:0,
    vertexStrideBytes:20,vertexCount:meshes.reduce((a,m)=>a+m.vertexCount,0),indexCount:meshes.reduce((a,m)=>a+m.indexCount,0),triangleCount:meshes.reduce((a,m)=>a+m.triangleCount,0),sectionSummary:true};
  let materialized=null;
  const build=()=>materialized??=(mergeMeshes(meshes));
  Object.defineProperties(summary,{
    materializedArrays:{get(){return materialized?[materialized.vertices,materialized.indices]:[];}},
    vertices:{enumerable:true,get(){const result=build();summary.originY=result.originY;return result.vertices;}},
    indices:{enumerable:true,get(){const result=build();summary.originY=result.originY;return result.indices;}},
  });
  return summary;
}

export function unpackChunkVertices(mesh) {
  const view=new DataView(mesh.vertices.buffer,mesh.vertices.byteOffset,mesh.vertices.byteLength);
  return Array.from({length:mesh.vertexCount},(_,i)=>{
    const o=i*20,s=view.getInt16(o+6,true);
    return {p:[view.getInt16(o,true)/s,view.getInt16(o+2,true)/s+(mesh.originY??0),view.getInt16(o+4,true)/s],n:[view.getInt8(o+8),view.getInt8(o+9),view.getInt8(o+10)],ao:view.getUint8(o+11),uv:[view.getUint16(o+12,true),view.getUint16(o+14,true)],layer:view.getUint16(o+16,true),flags:view.getUint16(o+18,true)};
  });
}

function mergeMeshes(meshes) {
  const vertices=[],indices=[];
  for(const mesh of meshes){const offset=vertices.length;for(const vertex of unpackChunkVertices(mesh))vertices.push(vertex);for(const index of mesh.indices)indices.push(index+offset);}
  const packed=packChunkVertices(vertices);
  return {vertices:packed,indices:vertices.length>65535?new Uint32Array(indices):new Uint16Array(indices),originY:packed.positionOriginY??0};
}

export function packedMeshBounds(mesh) {
  const bounds={minX:Infinity,minY:Infinity,minZ:Infinity,maxX:-Infinity,maxY:-Infinity,maxZ:-Infinity};
  const view=new DataView(mesh.vertices.buffer,mesh.vertices.byteOffset,mesh.vertices.byteLength);
  for(let i=0;i<mesh.vertexCount;i++) {
    const o=i*20,s=view.getInt16(o+6,true),p=[view.getInt16(o,true)/s,view.getInt16(o+2,true)/s,view.getInt16(o+4,true)/s];
    for(let a=0;a<3;a++){const axis="XYZ"[a];bounds[`min${axis}`]=Math.min(bounds[`min${axis}`],p[a]);bounds[`max${axis}`]=Math.max(bounds[`max${axis}`],p[a]);}
  }
  return bounds;
}
