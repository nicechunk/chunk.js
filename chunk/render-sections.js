import { meshChunkOpaque, meshChunkOpaqueFast, meshChunkVisual, packChunkVertices, buildGeneratedVisualCandidates, meshChunkOpaqueSteps, meshChunkOpaqueFastSteps, meshChunkVisualSteps, buildGeneratedVisualCandidatesSteps } from "./chunk-mesher.js";
import { deltaKey } from "./chunk-delta.js";
import { bakeSectionLightingSteps } from "./baked-light-field.js";
import { isVisualBlock,isOpaqueSolidBlock,BLOCK_ID } from "../world/block-registry.js";
import { prepareMeshDrawRanges, prepareMeshDrawRangesSteps } from "../renderer/mesh-draw-ranges.js";
import { SUNLIGHT_HORIZONTAL_REACH, SUNLIGHT_VERTICAL_REACH } from "../world/sunlight.js";
import { publishCommittedWorldBounds } from "../renderer/frustum.js";

export const RENDER_SECTION_HEIGHT = 16;
let generationSerial = 1;
let submissionSerial = 1;
const generatedPlans = new WeakMap();
const voxelScratchPool = [];
const MAX_RETAINED_VOXEL_SCRATCH_BYTES = 128 * 1024;

// Canonical generated terrain has no buried cavities. Chain/halo edits still
// enumerate their exact affected sections; custom/dense worlds use the full path.
function* generatedSectionPlan(chunk, access, workBudget) {
  let units=0;
  if (!access.generatedTerrain || typeof access.generatedSurfaceAtWorld!=="function" || !chunk.baseProfile || chunk.baseBlocks) return null;
  const cached = generatedPlans.get(access);
  if (cached?.chunk === chunk && cached.version === chunk.version && cached.profile === chunk.baseProfile) return cached.sections;
  let lower = Infinity, upper = -Infinity;
  const profile = chunk.baseProfile;
  for (let i = 0; i < chunk.chunkSize * chunk.chunkSize; i++) {
    lower = Math.min(lower, profile.surfaceY[i]);
    upper = Math.max(upper, profile.surfaceY[i] + 1);
    if (profile.waterY[i] !== profile.noWater) upper = Math.max(upper, profile.waterY[i] + 1);
    if(++units>=workBudget){units=0;yield {phase:"section-plan-columns",workUnits:workBudget};}
  }
  // A lower adjacent column can expose a chunk-edge cliff. Include the complete
  // one-cell geometry halo, using generated height rather than edited column tops.
  const ox = chunk.chunkX * chunk.chunkSize, oz = chunk.chunkZ * chunk.chunkSize;
  for (let offset = -1; offset <= chunk.chunkSize; offset++) {
    for (const [x,z] of [[offset,-1],[offset,chunk.chunkSize],[-1,offset],[chunk.chunkSize,offset]]) {
      const surface = access.generatedSurfaceAtWorld(ox+x,oz+z);
      if (!Number.isFinite(surface)) return null;
      lower = Math.min(lower,surface);
      if(++units>=workBudget){units=0;yield {phase:"section-plan-halo",workUnits:workBudget};}
    }
  }
  // The first three subsurface cells may use biome-specific non-opaque material.
  const sections = new Set([0]);
  const first=Math.max(0,sectionIndexAt(chunk,lower-4));
  const last=Math.min(Math.ceil(chunk.height/RENDER_SECTION_HEIGHT)-1,sectionIndexAt(chunk,upper));
  for (let index = first; index <= last; index++) sections.add(index);
  for (const tree of chunk.treeInstances ?? []) sections.add(sectionIndexAt(chunk,tree.baseY));
  for (const deltas of [chunk.getFinalDeltaMap().values(), access.neighborDeltas ?? access.getNeighborDeltas?.() ?? []]) for (const delta of deltas) {
    const y = delta.localY ?? delta.worldY;
    for (const sample of [y-1,y,y+1]) sections.add(sectionIndexAt(chunk,sample));
    if(++units>=workBudget){units=0;yield {phase:"section-plan-deltas",workUnits:workBudget};}
  }
  generatedPlans.set(access,{chunk,version:chunk.version,profile:chunk.baseProfile,sections});
  return sections;
}

export function sectionIndexAt(chunk, y) {
  return Math.floor((y - chunk.minY) / RENDER_SECTION_HEIGHT);
}

export function ensureRenderSections(chunk, { initializeColumnTops = true } = {}) {
  if (chunk.renderSections) return chunk.renderSections;
  chunk.generation ??= generationSerial++;
  chunk.renderSections = new Map();
  chunk.renderDeltaColumns = new Map();
  chunk.renderDeltaSections = new Map();
  chunk.renderColumnRevisions = new Map();
  chunk.renderColumnEpoch = 1;
  for (const delta of chunk.getFinalDeltaMap().values()) indexDelta(chunk, delta);
  chunk.renderColumnTops=new Map();
  if(initializeColumnTops&&chunk.shadows!==false)for(let z=0;z<chunk.chunkSize;z++)for(let x=0;x<chunk.chunkSize;x++)chunk.renderColumnTops.set(x+z*chunk.chunkSize,finalColumnTop(chunk,x,z));
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
  if(chunk.shadows!==false)for(let z=0;z<chunk.chunkSize;z++)for(let x=0;x<chunk.chunkSize;x++) {
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
    for(const sy of [y-(chunk.shadows===false?4:SUNLIGHT_VERTICAL_REACH),y,y+4])light.add(sectionIndexAt(chunk,sy));yield;
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
      else if(!light.has(index)&&(chunk.shadows===false||section.originY>skyBelow))continue;
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
    if(chunk.shadows!==false)for(let z=0;z<chunk.chunkSize;z++)for(let x=0;x<chunk.chunkSize;x++)chunk.renderColumnTops.set(x+z*chunk.chunkSize,finalColumnTop(chunk,x,z));
  } else {
    for (const delta of deltas) {
      const y = delta.localY ?? delta.worldY;
      for (const sy of [y-1,y,y+1]) affected.add(sectionIndexAt(chunk, sy));
      for(const sy of [y-(chunk.shadows===false?4:SUNLIGHT_VERTICAL_REACH),y,y+4])nearbyLight.add(sectionIndexAt(chunk,sy));
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
        if(chunk.shadows!==false) {
          const column=delta.localX+delta.localZ*chunk.chunkSize;
          const before=chunk.renderColumnTops.get(column),after=finalColumnTop(chunk,delta.localX,delta.localZ);
          if(before!==after)skyChangedBelow=Math.max(skyChangedBelow,before??after,after);
          chunk.renderColumnTops.set(column,after);
        }
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
    if(affected.has(index)||(!nearbyLight.has(index)&&(chunk.shadows===false||section.originY>skyChangedBelow)))continue;
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
  return `${section.generation}:${section.dataRevision}:${section.haloRevision}:${section.lightRevision}:${materialVersion}:${section.decorationRevision ?? 0}`;
}

// Ground models belong to the section containing their support cell. Rules and
// pickups never change the opaque terrain/tree channel, even when a model's
// material is opaque. Edited columns can also have exposed cave floors.
export function invalidateSurfaceDecorations(chunk, { surfaces = null, columns = null } = {}) {
  if (!chunk.renderSections) { chunk.markDirty(); return; }
  const affected = new Set();
  if (!chunk.baseProfile || chunk.baseBlocks) {
    for (const index of chunk.renderSections.keys()) affected.add(index);
  } else {
    const profile = chunk.baseProfile;
    for (let column = 0; column < chunk.chunkSize * chunk.chunkSize; column++) {
      if (columns && !columns.has(column)) continue;
      if (!surfaces || !profile.surfaceBlock || surfaces.has(profile.surfaceBlock[column])) {
        affected.add(sectionIndexAt(chunk, profile.surfaceY[column]));
      }
    }
    for (const delta of chunk.getFinalDeltaMap().values()) {
      if (columns && !columns.has(delta.localX + delta.localZ * chunk.chunkSize)) continue;
      affected.add(sectionIndexAt(chunk, delta.localY));
      affected.add(sectionIndexAt(chunk, delta.localY - 1));
    }
  }
  let changed = false;
  for (const index of affected) {
    const section = chunk.renderSections.get(index);
    if (!section) continue;
    section.decorationRevision = (section.decorationRevision ?? 0) + 1;
    section.visualDirty = true;
    section.visualRetryAt = 0;
    section.dirtyReason = "surface-decoration";
    section.oldestDirtyAt ??= performance.now();
    changed = true;
  }
  if (changed) {
    const reusable = chunk.reusableBaseVersion === chunk.version;
    chunk.renderInvalidationPending = true;
    chunk.markDirty();
    // The generated voxel inputs did not change. Once the new visual channels
    // finish, their current rule/pickup signature may be retained as well.
    if (reusable) chunk.reusableBaseVersion = chunk.version;
  }
}

export function sectionDeltaValues(chunk, index, marginSections = 1) {
  ensureRenderSections(chunk);
  const values=[];
  for(let i=index-marginSections;i<=index+marginSections;i++) for(const delta of chunk.renderDeltaSections.get(i)?.values() ?? []) values.push(delta);
  return values;
}

export function buildRenderSection(chunk, section, access = {}, options = {}) {
  return drainSectionSteps(buildRenderSectionSteps(chunk, section, access, options));
}

// Callers stepping across frames must provide an immutable input snapshot and
// validate its section/halo revision before publication. Progress never mutates
// the live section, and iterator.return() releases its private scratch buffer.
export function* buildRenderSectionSteps(chunk, section, access = {}, { visualOnly = false, workBudget = 256 } = {}) {
  if(!Number.isInteger(workBudget)||workBudget<1||workBudget>4096)throw new RangeError("Section workBudget must be from 1 to 4096.");
  let units=0;
  const startedAt=performance.now();
  const plan=yield* generatedSectionPlan(chunk,access,workBudget);
  if (plan && !plan.has(section.sectionIndex)) {
    const empty=()=>prepareMeshDrawRanges({...emptySectionMesh(chunk,section),sectionIndex:section.sectionIndex});
    return {mesh:visualOnly?null:empty(),visualMesh:empty(),visualError:null,lighting:undefined,
      skippedGeneratedEmpty:true,voxelQueries:0,voxelVisits:0,voxelCacheBytes:0,
      opaqueCellBudget:0,elapsedMs:performance.now()-startedAt};
  }
  const view=Object.create(chunk);
  view.minY=section.originY; view.height=section.height; view.renderOriginY=section.originY;
  view.baseProfile=null;
  view.getBaseBlock=chunk.getBaseBlock.bind(chunk);
  view.hasDeltaAt=chunk.hasDeltaAt.bind(chunk);
  view.treeInstances=(chunk.treeInstances ?? []).filter(t=>sectionIndexAt(chunk,t.baseY)===section.sectionIndex);
  const localDeltas=new Map();
  for(let index=section.sectionIndex-1;index<=section.sectionIndex+1;index++)for(const delta of chunk.renderDeltaSections.get(index)?.values()??[]) {
    localDeltas.set(deltaKey(delta.localX,delta.localY,delta.localZ,chunk.chunkSize),delta);
    if(++units>=workBudget){units=0;yield {phase:"section-delta-snapshot",workUnits:workBudget};}
  }
  view.getFinalDeltaMap=()=>localDeltas;
  // Generation v5 only has visual base blocks at the surface or in its water
  // column. Keep the ordinary z/y/x emission order, but never reconstruct ores
  // and other buried opaque cells just to reject them in the visual pass.
  // Explicit edits still enumerate every visual cell, including underground.
  if(access.generatedTerrain && chunk.generationVersion===5 && chunk.baseProfile && !chunk.baseBlocks) {
    const size=chunk.chunkSize,mask=new Uint8Array(size*size*section.height);
    const editedColumns=new Set();
    for(let z=0;z<size;z++)for(let x=0;x<size;x++) {
      const column=x+z*size,surface=chunk.baseProfile.surfaceY[column],water=chunk.baseProfile.waterY[column];
      const end=Math.min(section.originY+section.height-1,Math.max(surface,water===chunk.baseProfile.noWater?surface:water));
      for(let y=Math.max(section.originY,surface);y<=end;y++) {
        mask[x+z*size+(y-section.originY)*size*size]=1;
        if(++units>=workBudget){units=0;yield {phase:"section-visual-mask",workUnits:workBudget};}
      }
      if(++units>=workBudget){units=0;yield {phase:"section-visual-columns",workUnits:workBudget};}
    }
    for(const delta of localDeltas.values()) {
      editedColumns.add(delta.localX+delta.localZ*size);
      const y=delta.localY;
      if(y>=section.originY&&y<section.originY+section.height&&isVisualBlock(delta.blockId))mask[delta.localX+delta.localZ*size+(y-section.originY)*size*size]=1;
    }
    view.generatedVisualProfile={profile:chunk.baseProfile,editedColumns,mask};
  }
  const margin=chunk.shadows===false?8:SUNLIGHT_HORIZONTAL_REACH,verticalMargin=8,width=chunk.chunkSize+margin*2,cacheHeight=section.height+verticalMargin*2;
  const originX=chunk.chunkX*chunk.chunkSize-margin,originZ=chunk.chunkZ*chunk.chunkSize-margin,originY=section.originY-verticalMargin;
  const length=width*width*cacheHeight;
  const scratchIndex=voxelScratchPool.findIndex(array=>array.length===length);
  const voxels=scratchIndex<0?new Uint16Array(length):voxelScratchPool.splice(scratchIndex,1)[0];
  voxels.fill(65535);
  try {
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
  const snapshotAccess={...access,workBudget,getBlockAtWorld:getWorld,getColumnTopAtWorld:(x,z)=>{
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
  let mesh=visualOnly?null:(chunk.baseProfile?yield* meshChunkOpaqueFastSteps(opaqueView,snapshotAccess):yield* meshChunkOpaqueSteps(view,snapshotAccess));
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
  try {
    const candidates = yield* buildGeneratedVisualCandidatesSteps(view, { finalDeltas: localDeltas, workBudget });
    view.visualCandidates = candidates;
    visualMesh = candidates
      ? candidates.empty ? { ...emptySectionMesh(chunk, section), blockCount: candidates.blockCount } : yield* meshChunkVisualSteps(view, snapshotAccess)
      : visualPossible ? yield* meshChunkVisualSteps(view, snapshotAccess) : emptySectionMesh(chunk, section);
  }
  catch(error) { visualError=error?.message || String(error); }
  for(const part of [mesh,visualMesh]) if(part) {
    part.sectionIndex=section.sectionIndex;
    part.originY=section.originY;
    // Models owned by a section can extend into the section above it.
    part.bounds=yield* packedMeshBoundsSteps(part,{workBudget});
  }
  const lighting=yield* bakeSectionLightingSteps(chunk,section,snapshotAccess,[mesh,visualMesh],access.caveLighting,{workBudget});
  // Prepare material ranges in the same bounded task, including inside the real
  // Worker. The GPU uploader validates and reuses these immutable partitions.
  if(mesh)mesh=yield* prepareMeshDrawRangesSteps(mesh,{workBudget});
  if(visualMesh)visualMesh=yield* prepareMeshDrawRangesSteps(visualMesh,{workBudget});
  return {mesh,visualMesh,visualError,lighting,voxelQueries,voxelVisits,voxelCacheBytes:voxels.byteLength,opaqueCellBudget:chunk.chunkSize*chunk.chunkSize*section.height,elapsedMs:performance.now()-startedAt};
  } finally {
    if (voxels.byteLength<=MAX_RETAINED_VOXEL_SCRATCH_BYTES && voxelScratchPool.reduce((bytes,array)=>bytes+array.byteLength,0)+voxels.byteLength<=MAX_RETAINED_VOXEL_SCRATCH_BYTES) voxelScratchPool.push(voxels);
  }
}

function emptySectionMesh(chunk,section) {
  return {vertices:new Uint8Array(),indices:new Uint16Array(),vertexCount:0,indexCount:0,triangleCount:0,quadCount:0,blockCount:0,vertexStrideBytes:20,chunkX:chunk.chunkX,chunkZ:chunk.chunkZ,chunkSize:chunk.chunkSize,originY:section.originY};
}

export function commitRenderSection(chunk, section, result, expectedRevision = sectionRevision(section,chunk.materialVersion), { updateSummary = true } = {}) {
  if (sectionRevision(section,chunk.materialVersion)!==expectedRevision) return false;
  if(result.mesh) {
    section.mesh=result.mesh; section.meshVersion=section.dataRevision;
    section.meshCommitToken=submissionSerial++; section.gpuUploaded=false; section.dirty=false;
    section.meshReadyAt=performance.now();
  }
  if(result.visualError) {
    section.visualError=result.visualError; section.visualDirty=true; section.visualFailures++;
    section.visualRetryAt=performance.now()+Math.min(3200,100*2**Math.min(5,section.visualFailures-1));
  } else {
    section.visualMesh=result.visualMesh; section.visualMeshVersion=section.dataRevision;
    section.visualCommitToken=submissionSerial++; section.visualGpuUploaded=false;
    section.visualMeshReadyAt=performance.now();
    section.visualDirty=false;section.visualError=null;section.visualFailures=0;section.visualRetryAt=0;
  }
  section.materialVersion=chunk.materialVersion;
  section.buildTaskId=null;section.buildState="ready";
  if(!section.dirty&&!section.visualDirty)section.oldestDirtyAt=null;
  publishCommittedWorldBounds(section);
  if(updateSummary)updateChunkSectionSummary(chunk);
  return true;
}

export function updateChunkSectionSummary(chunk) {
  const sections=[...chunk.renderSections.values()];
  chunk.mesh=combinedSectionMesh(chunk,sections,"mesh");
  chunk.visualMesh=combinedSectionMesh(chunk,sections,"visualMesh");
  chunk.renderActiveSections = sections.filter(section => section.mesh?.indexCount || section.visualMesh?.indexCount);
  chunk.renderSectionCommitRevision = (chunk.renderSectionCommitRevision ?? 0) + 1;
  publishCommittedWorldBounds(chunk);
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
  // Aggregate immutable committed bounds once, instead of traversing every
  // section/channel in each visibility and render pass. Keep legacy lazy mesh
  // materialization independent of the summary's world-height bounds.
  const bounded = meshes.filter(mesh => mesh.vertexCount);
  if (bounded.length && bounded.every(mesh => mesh.bounds)) {
    summary.bounds = {
      minX: Math.min(...bounded.map(mesh => mesh.bounds.minX)),
      maxX: Math.max(...bounded.map(mesh => mesh.bounds.maxX)),
      minZ: Math.min(...bounded.map(mesh => mesh.bounds.minZ)),
      maxZ: Math.max(...bounded.map(mesh => mesh.bounds.maxZ)),
      minY: Math.min(...bounded.map(mesh => mesh.bounds.minY + (mesh.originY ?? 0))),
      maxY: Math.max(...bounded.map(mesh => mesh.bounds.maxY + (mesh.originY ?? 0))),
    };
  }
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
  return drainSectionSteps(packedMeshBoundsSteps(mesh));
}

export function* packedMeshBoundsSteps(mesh,{workBudget=256}={}) {
  let units=0;
  let minX=Infinity,minY=Infinity,minZ=Infinity,maxX=-Infinity,maxY=-Infinity,maxZ=-Infinity;
  const view=new DataView(mesh.vertices.buffer,mesh.vertices.byteOffset,mesh.vertices.byteLength);
  for(let i=0;i<mesh.vertexCount;i++) {
    const o=i*20,s=view.getInt16(o+6,true),x=view.getInt16(o,true)/s,y=view.getInt16(o+2,true)/s,z=view.getInt16(o+4,true)/s;
    minX=Math.min(minX,x);maxX=Math.max(maxX,x);
    minY=Math.min(minY,y);maxY=Math.max(maxY,y);
    minZ=Math.min(minZ,z);maxZ=Math.max(maxZ,z);
    if(++units>=workBudget){units=0;yield {phase:"section-bounds",workUnits:workBudget};}
  }
  return {minX,minY,minZ,maxX,maxY,maxZ};
}

function drainSectionSteps(iterator) {
  let step;
  do {step=iterator.next();} while(!step.done);
  return step.value;
}
