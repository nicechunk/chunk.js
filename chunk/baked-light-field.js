import { BLOCK_FLAGS } from "../core/constants.js";
import { blockFlags, isOpaqueSolidBlock } from "../world/block-registry.js";
import { createDirectionalSunlight } from "./directional-sunlight.js";

export const DEFAULT_CAVE_LIGHTING = Object.freeze({ radius: 4, attenuation: 3 });
const STEPS=[[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]];

// Finite six-neighbour light transport, not a height-only AO approximation.
// A face only depends on sources reachable within the attenuation radius. Walk
// that exact neighbourhood from the samples instead of querying every buried
// solid in the entire section and halo. The lazy cell cache is shared by all
// samples; no early-out depends on a height-field assumption about cavities.
export function bakeSectionLighting(chunk, section, access, meshes, options = DEFAULT_CAVE_LIGHTING) {
  if(!meshes.some(mesh=>mesh?.vertexCount))return;
  const shadows=chunk.shadows!==false;
  const noLocalLightSources=(typeof access.noLocalLightSources==="function"?access.noLocalLightSources():access.noLocalLightSources)===true;
  // No-shadow gameplay must not bake roof/cave skylight masks either. With no
  // emitters the result is constant, so skip every cell, column and transport
  // allocation. Keep material/UV bits and the water-depth attribute intact.
  if(!shadows&&noLocalLightSources) {
    for(const mesh of meshes)if(mesh?.vertexCount) {
      const data=new DataView(mesh.vertices.buffer,mesh.vertices.byteOffset,mesh.vertices.byteLength);
      for(let v=0;v<mesh.vertexCount;v++)data.setUint16(v*20+18,(data.getUint16(v*20+18,true)&7)|0xff80,true);
      mesh.lightEncoding="sun4-sky4-local4-v1";
    }
    return {cells:0,domainCells:0,radius:0,skySeeds:0,localSeeds:0,samples:0,sunlight:null,transportCacheBytes:0,occlusion:false};
  }
  const radius=Math.max(1,Math.min(8,Math.trunc(options.radius??4)));
  const attenuation=Math.max(1,Math.ceil(15/radius));
  let minX=0,minZ=0,maxX=chunk.chunkSize,maxZ=chunk.chunkSize,minY=section.originY,maxY=section.originY+section.height;
  for(const mesh of meshes)if(mesh?.vertexCount&&mesh.bounds){const b=mesh.bounds;minX=Math.min(minX,b.minX);minZ=Math.min(minZ,b.minZ);maxX=Math.max(maxX,b.maxX);maxZ=Math.max(maxZ,b.maxZ);minY=Math.min(minY,b.minY+(mesh.originY??0));maxY=Math.max(maxY,b.maxY+(mesh.originY??0));}
  const width=Math.max(Math.ceil(maxX)-Math.floor(minX),Math.ceil(maxZ)-Math.floor(minZ))+2*radius,height=Math.ceil(maxY)-Math.floor(minY)+2*radius;
  const ox=chunk.chunkX*chunk.chunkSize+Math.floor(minX)-radius,oy=Math.floor(minY)-radius,oz=chunk.chunkZ*chunk.chunkSize+Math.floor(minZ)-radius;
  const count=width*width*height;
  const solid=new Uint8Array(count);solid.fill(255);
  const emissive=new Uint8Array(count);
  const tops=new Map(),samples=new Map();
  let sampledCells=0,skySeeds=0,localSeeds=0;
  const index=(x,y,z)=>x+z*width+y*width*width;
  const columnTop=(x,z)=>{
    const key=x+z*width;
    if(!tops.has(key))tops.set(key,access.getColumnTopAtWorld?.(ox+x,oz+z)??chunk.minY+chunk.height);
    return tops.get(key);
  };
  const readCell=(i,x,y,z)=>{
    if(solid[i]!==255)return;
    const id=access.getBlockAtWorld(ox+x,oy+y,oz+z);
    sampledCells++;
    solid[i]=isOpaqueSolidBlock(id)?1:0;
    emissive[i]=(blockFlags(id)&BLOCK_FLAGS.EMISSIVE)?1:0;
    if(shadows&&!solid[i]&&oy+y>columnTop(x,z))skySeeds++;
    if(emissive[i])localSeeds++;
  };
  const maxDistance=Math.floor(14/attenuation);
  const sunlight=!shadows?null:createDirectionalSunlight({
    getColumnTopAtWorld:(x,z)=>access.getColumnTopAtWorld?.(x,z)??chunk.minY+chunk.height,
    getBlockAtWorld:access.getBlockAtWorld,
  });
  // Cache finite-radius transport by cell and remaining distance. Adjacent wall
  // corners reuse the same subproblems instead of each walking the air volume.
  let transportCache=null;
  const transport=(i,x,y,z,remaining)=>{
    const cached=transportCache?.[remaining]?.[i];
    if(cached)return cached-1;
    readCell(i,x,y,z);
    let sky=shadows&&!solid[i]&&oy+y>columnTop(x,z)?15:0,local=emissive[i]?15:0;
    // Canonical generated terrain has no emissive blocks. The immutable edit
    // snapshot can prove this too. An outdoor sky seed is then already final;
    // do not walk six neighbours to search for a source that does not exist.
    if(noLocalLightSources&&sky===15)return 240;
    if(remaining>0&&!solid[i])for(const [dx,dy,dz]of STEPS){
      const nx=x+dx,ny=y+dy,nz=z+dz;
      if(nx<0||ny<0||nz<0||nx>=width||nz>=width||ny>=height)continue;
      const value=transport(index(nx,ny,nz),nx,ny,nz,remaining-1);
      sky=Math.max(sky,(value>>>4)-attenuation);local=Math.max(local,(value&15)-attenuation);
      if((sky===15&&local===15)||(noLocalLightSources&&sky>=15-attenuation))break;
    }
    const encoded=(sky<<4)|local;
    transportCache??=Array.from({length:maxDistance+1},()=>new Uint16Array(count));
    transportCache[remaining][i]=encoded+1;
    return encoded;
  };
  const sample=(p)=>{
    const x=Math.floor(p[0])-ox,y=Math.floor(p[1])-oy,z=Math.floor(p[2])-oz;
    if(x<0||y<0||z<0||x>=width||z>=width||y>=height)return {sun:shadows?0:15,sky:shadows?0:15,local:0};
    const first=index(x,y,z),cached=samples.get(first);
    if(cached)return cached;
    readCell(first,x,y,z);
    const light={sun:0,sky:0,local:0};
    const value=transport(first,x,y,z,maxDistance);
    light.sky=shadows?value>>>4:15;light.local=value&15;
    // Only enabled shadows may suppress sunlight or sky. Local emission remains
    // additive in the no-shadow policy and cannot create dark occlusion masks.
    light.sun=!shadows?15:solid[first]?0:sunlight.sample(ox+x,oy+y,oz+z);
    samples.set(first,light);return light;
  };
  for(const mesh of meshes) {
    if(!mesh)continue;
    const data=new DataView(mesh.vertices.buffer,mesh.vertices.byteOffset,mesh.vertices.byteLength);
    for(let v=0;v<mesh.vertexCount;v+=4) {
      const n=[data.getInt8(v*20+8)/127,data.getInt8(v*20+9)/127,data.getInt8(v*20+10)/127];
      const corners=Math.min(4,mesh.vertexCount-v);
      // A greedy wall may cross a roof/window lighting boundary. Sampling only
      // its center incorrectly made the whole wall equally dark or bright.
      // Shared world-space corners sample the same air cell across section seams;
      // the existing vertex interpolants provide the gradient without more faces.
      for(let j=0;j<corners;j++) {
        const o=(v+j)*20,s=data.getInt16(o+6,true);
        const p=[chunk.chunkX*chunk.chunkSize+data.getInt16(o,true)/s+n[0]*.1,
          (mesh.originY??0)+data.getInt16(o+2,true)/s+n[1]*.1,
          chunk.chunkZ*chunk.chunkSize+data.getInt16(o+4,true)/s+n[2]*.1];
        const light=sample(p),encoded=128|((light.sun*16+light.sky)<<8)|(light.local<<3);
        data.setUint16(o+18,(data.getUint16(o+18,true)&7)|encoded,true);
      }
    }
    mesh.lightEncoding="sun4-sky4-local4-v1";
  }
  return {cells:sampledCells,domainCells:count,radius,skySeeds,localSeeds,samples:samples.size,sunlight:sunlight?.stats??null,
    transportCacheBytes:transportCache?.reduce((total,field)=>total+field.byteLength,0)??0,occlusion:shadows};
}
