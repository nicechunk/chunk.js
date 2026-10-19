import { materialList } from '../world/material-registry.js';
const materials = new Map(materialList().map(m=>[m.textureLayer,m]));
const cache = new WeakMap();
export function materialRenderPass(layer) { const m=materials.get(layer);if(m?.style==='shadow')return 'shadow';if(m?.shaderType==='fluid'||m?.shaderType==='transparent')return 'blend';if(m?.shaderType==='cutout')return 'cutout';return 'opaque'; }
// Classify by material, not by which CPU channel happened to emit a face.
// Meshes are immutable commits. Replacing typed-array storage also invalidates this cache.
export function prepareMeshDrawRanges(mesh) {
  if(mesh.materialPassLayout===1){validateMaterialPassLayout(mesh);return mesh;}
  const cached=cache.get(mesh);if(cached?.sourceVertices===mesh.vertices&&cached.sourceIndices===mesh.indices)return cached.result;
  const stride=mesh.vertexStrideBytes||20;
  const view=new DataView(mesh.vertices.buffer,mesh.vertices.byteOffset,mesh.vertices.byteLength);
  const groups={opaque:[],cutout:[],shadow:[],blend:[]};
  const centers={blend:[],shadow:[]};
  const bounds={minX:Infinity,minY:Infinity,minZ:Infinity,maxX:-Infinity,maxY:-Infinity,maxZ:-Infinity};
  const point=(id)=>{const o=id*stride,s=Math.max(1,view.getInt16(o+6,true));return [view.getInt16(o,true)/s,view.getInt16(o+2,true)/s,view.getInt16(o+4,true)/s];};
  for(let i=0;i<mesh.vertices.byteLength/stride;i++){const p=point(i);bounds.minX=Math.min(bounds.minX,p[0]);bounds.maxX=Math.max(bounds.maxX,p[0]);bounds.minY=Math.min(bounds.minY,p[1]);bounds.maxY=Math.max(bounds.maxY,p[1]);bounds.minZ=Math.min(bounds.minZ,p[2]);bounds.maxZ=Math.max(bounds.maxZ,p[2]);}
  for(let i=0;i<mesh.indices.length;i+=3){const ids=[mesh.indices[i],mesh.indices[i+1],mesh.indices[i+2]];const pass=materialRenderPass(view.getUint16(ids[0]*stride+16,true));groups[pass].push(...ids);if(centers[pass]){const ps=ids.map(point);centers[pass].push(ps[0].map((v,k)=>(v+ps[1][k]+ps[2][k])/3));}}
  const indices=new mesh.indices.constructor(mesh.indices.length),drawRanges={},blendUnits=[];let start=0;
  for(const pass of ['opaque','cutout','shadow','blend']){indices.set(groups[pass],start);drawRanges[pass]={offset:start,count:groups[pass].length};if(centers[pass])centers[pass].forEach((center,i)=>blendUnits.push({pass,offset:start+i*3,count:3,center}));start+=groups[pass].length;}
  const result={...mesh,indices,drawRanges,blendUnits,bounds:mesh.vertexCount?bounds:{minX:0,minY:0,minZ:0,maxX:0,maxY:0,maxZ:0},materialPassLayout:1};cache.set(mesh,{sourceVertices:mesh.vertices,sourceIndices:mesh.indices,result});return result;
}
// Included separately in renderer diagnostics: the immutable index partition is
// cached while its source CPU mesh is reachable.
export function meshDrawRangeArrays(mesh) {const result=cache.get(mesh)?.result;return result?[result.vertices,result.indices]:[];}

export function validateMaterialPassLayout(mesh){
  if(!(mesh.indices instanceof Uint16Array||mesh.indices instanceof Uint32Array))throw new TypeError("Material pass layout requires integer indices");
  if(mesh.indices.length!==mesh.indexCount||mesh.indexCount%3!==0)throw new RangeError("Material pass index count mismatch");
  let cursor=0;
  for(const pass of ["opaque","cutout","shadow","blend"]){const range=mesh.drawRanges?.[pass];if(!range||!Number.isInteger(range.offset)||!Number.isInteger(range.count)||range.offset!==cursor||range.count<0||range.count%3)throw new RangeError(`Invalid ${pass} material draw range`);cursor+=range.count;if(cursor>mesh.indices.length)throw new RangeError("Material draw range exceeds index storage");}
  if(cursor!==mesh.indices.length)throw new RangeError("Material ranges do not cover all indices");
  const count=(mesh.drawRanges.shadow.count+mesh.drawRanges.blend.count)/3;
  if(!Array.isArray(mesh.blendUnits)||mesh.blendUnits.length!==count)throw new RangeError("Sortable material units do not cover blend/shadow ranges");
  const visited=new Uint8Array(count);const first=mesh.drawRanges.shadow.offset;
  for(const unit of mesh.blendUnits){const range=mesh.drawRanges[unit.pass];if((unit.pass!=="shadow"&&unit.pass!=="blend")||!range||unit.count!==3||!Number.isInteger(unit.offset)||unit.offset<range.offset||unit.offset+3>range.offset+range.count||(unit.offset-range.offset)%3||!Array.isArray(unit.center)||unit.center.length!==3||!unit.center.every(Number.isFinite))throw new RangeError("Invalid sortable material unit");const index=(unit.offset-first)/3;if(visited[index])throw new RangeError("Duplicate sortable material unit");visited[index]=1;}
  return true;
}
