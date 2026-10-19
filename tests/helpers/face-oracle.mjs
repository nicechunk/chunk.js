import assert from "node:assert/strict";
import { BLOCK_ID, isOpaqueSolidBlock, blockMaterialIdForFace } from "../../world/block-registry.js";
import { materialDef } from "../../world/material-registry.js";

export const DIRECTIONS = [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]];
const opaque = (id) => id !== BLOCK_ID.cactus && isOpaqueSolidBlock(id);

// Independent six-neighbour oracle. No mesher candidate/greedy helpers are used.
export function expectedFaces(chunk, getWorld) {
  const result = new Map();
  for (let z=0;z<chunk.chunkSize;z++) for(let y=chunk.minY;y<chunk.minY+chunk.height;y++) for(let x=0;x<chunk.chunkSize;x++) {
    const block=chunk.getFinalBlock(x,y,z);
    if(!opaque(block)) continue;
    DIRECTIONS.forEach(([dx,dy,dz],face)=>{
      const nx=x+dx,ny=y+dy,nz=z+dz;
      const other=nx>=0&&nx<chunk.chunkSize&&nz>=0&&nz<chunk.chunkSize&&ny>=chunk.minY&&ny<chunk.minY+chunk.height
        ?chunk.getFinalBlock(nx,ny,nz):getWorld(chunk.chunkX*chunk.chunkSize+nx,ny,chunk.chunkZ*chunk.chunkSize+nz);
      if(!opaque(other)) result.set(`${face}:${x}:${y}:${z}:${materialDef(blockMaterialIdForFace(block,face)).textureLayer}`,1);
    });
  }
  return result;
}

export function decodedVertices(mesh) {
  const view=new DataView(mesh.vertices.buffer,mesh.vertices.byteOffset,mesh.vertices.byteLength);
  return Array.from({length:mesh.vertexCount},(_,i)=>{
    const o=i*20,scale=view.getInt16(o+6,true);
    assert.ok(scale>0,"packed scale must be positive");
    return {p:[view.getInt16(o,true)/scale,view.getInt16(o+2,true)/scale+(mesh.originY??0),view.getInt16(o+4,true)/scale],n:[view.getInt8(o+8),view.getInt8(o+9),view.getInt8(o+10)],layer:view.getUint16(o+16,true),shade:view.getUint8(o+11)};
  });
}

// Rasterize each indexed triangle at two deliberately asymmetric samples per
// unit face. This catches both missing coverage and overlapping greedy quads.
export function actualFaces(mesh) {
  const vertices=decodedVertices(mesh),samples=new Map();
  for(let i=0;i<mesh.indices.length;i+=3){
    const tri=Array.from(mesh.indices.slice(i,i+3),j=>{
      assert.ok(j<vertices.length,"index out of range");return vertices[j];
    });
    const a=tri[0].p,b=tri[1].p,c=tri[2].p;
    const cross=[(b[1]-a[1])*(c[2]-a[2])-(b[2]-a[2])*(c[1]-a[1]),(b[2]-a[2])*(c[0]-a[0])-(b[0]-a[0])*(c[2]-a[2]),(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0])];
    assert.ok(Math.hypot(...cross)>1e-7,"degenerate triangle");
    const face=DIRECTIONS.findIndex(d=>d.every((v,j)=>tri[0].n[j]===v*127));
    if(face<0) continue;
    const axis=face<2?0:face<4?1:2,axes=[0,1,2].filter(j=>j!==axis),plane=a[axis];
    if(!Number.isInteger(plane)) continue; // micro models are tested separately
    const projected=tri.map(v=>axes.map(j=>v.p[j]));
    const min=axes.map(j=>Math.floor(Math.min(...tri.map(v=>v.p[j])))),max=axes.map(j=>Math.ceil(Math.max(...tri.map(v=>v.p[j]))));
    for(let u=min[0];u<max[0];u++)for(let v=min[1];v<max[1];v++){
      for(const [sample,offset] of [[0,[.231,.417]],[1,[.719,.863]]]){
        if(!inside([u+offset[0],v+offset[1]],projected))continue;
        const cell=[];cell[axis]=plane-(face%2===0?1:0);cell[axes[0]]=u;cell[axes[1]]=v;
        const key=`${face}:${cell[0]}:${cell[1]}:${cell[2]}:${tri[0].layer}:${sample}`;
        samples.set(key,(samples.get(key)??0)+1);
      }
    }
  }
  const faces=new Map();
  for(const [key,count]of samples){const base=key.slice(0,key.lastIndexOf(":"));assert.equal(count,1,`overlap ${key}`);faces.set(base,1);}
  for(const key of faces.keys())for(let s=0;s<2;s++)assert.equal(samples.get(`${key}:${s}`),1,`partial coverage ${key}`);
  return faces;
}

function inside(p,t){
  const sign=(a,b)=>(p[0]-b[0])*(a[1]-b[1])-(a[0]-b[0])*(p[1]-b[1]);
  const d=[sign(t[0],t[1]),sign(t[1],t[2]),sign(t[2],t[0])];
  return d.every(x=>x>=-1e-8)||d.every(x=>x<=1e-8);
}
