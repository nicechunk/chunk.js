import { BLOCK_FLAGS } from "../core/constants.js";
import { blockFlags, isOpaqueSolidBlock } from "../world/block-registry.js";

export const DEFAULT_CAVE_LIGHTING = Object.freeze({ radius: 4, attenuation: 3 });
const STEPS=[[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]];

// Finite six-neighbour light transport, not a height-only AO approximation.
// A face only depends on sources reachable within the attenuation radius. Walk
// that exact neighbourhood from the samples instead of querying every buried
// solid in the entire section and halo. The lazy cell cache is shared by all
// samples; no early-out depends on a height-field assumption about cavities.
export function bakeSectionLighting(chunk, section, access, meshes, options = DEFAULT_CAVE_LIGHTING) {
  if(!meshes.some(mesh=>mesh?.vertexCount))return;
  const radius=Math.max(1,Math.min(8,Math.trunc(options.radius??4)));
  const attenuation=Math.max(1,Math.ceil(15/radius));
  let minX=0,minZ=0,maxX=chunk.chunkSize,maxZ=chunk.chunkSize,minY=section.originY,maxY=section.originY+section.height;
  for(const mesh of meshes)if(mesh?.vertexCount&&mesh.bounds){const b=mesh.bounds;minX=Math.min(minX,b.minX);minZ=Math.min(minZ,b.minZ);maxX=Math.max(maxX,b.maxX);maxZ=Math.max(maxZ,b.maxZ);minY=Math.min(minY,b.minY+(mesh.originY??0));maxY=Math.max(maxY,b.maxY+(mesh.originY??0));}
  const width=Math.max(Math.ceil(maxX)-Math.floor(minX),Math.ceil(maxZ)-Math.floor(minZ))+2*radius,height=Math.ceil(maxY)-Math.floor(minY)+2*radius;
  const ox=chunk.chunkX*chunk.chunkSize+Math.floor(minX)-radius,oy=Math.floor(minY)-radius,oz=chunk.chunkZ*chunk.chunkSize+Math.floor(minZ)-radius;
  const count=width*width*height;
  const solid=new Uint8Array(count);solid.fill(255);
  const emissive=new Uint8Array(count),seen=new Uint32Array(count),distance=new Uint8Array(count),queue=new Uint32Array(count);
  const tops=new Map(),samples=new Map();
  let sampledCells=0,skySeeds=0,localSeeds=0,walkId=0;
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
    if(!solid[i]&&oy+y>columnTop(x,z))skySeeds++;
    if(emissive[i])localSeeds++;
  };
  const maxDistance=Math.floor(14/attenuation);
  const sample=(p)=>{
    const x=Math.floor(p[0])-ox,y=Math.floor(p[1])-oy,z=Math.floor(p[2])-oz;
    if(x<0||y<0||z<0||x>=width||z>=width||y>=height)return {sun:0,sky:0,local:0};
    const first=index(x,y,z),cached=samples.get(first);
    if(cached)return cached;
    readCell(first,x,y,z);
    const light={sun:!solid[first]&&oy+y>columnTop(x,z)?15:0,sky:0,local:0};
    walkId++;seen[first]=walkId;distance[first]=0;queue[0]=first;
    for(let q=0,end=1;q<end;q++){
      const i=queue[q],cy=Math.floor(i/(width*width)),rem=i-cy*width*width,cz=Math.floor(rem/width),cx=rem-cz*width;
      readCell(i,cx,cy,cz);
      const depth=distance[i],value=15-depth*attenuation;
      if(!solid[i]&&oy+cy>columnTop(cx,cz))light.sky=Math.max(light.sky,value);
      if(emissive[i])light.local=Math.max(light.local,value);
      if(depth>=maxDistance||solid[i]||(light.sky===15&&light.local===15))continue;
      for(const [dx,dy,dz]of STEPS){
        const nx=cx+dx,ny=cy+dy,nz=cz+dz;
        if(nx<0||ny<0||nz<0||nx>=width||nz>=width||ny>=height)continue;
        const n=index(nx,ny,nz);if(seen[n]===walkId)continue;
        seen[n]=walkId;distance[n]=depth+1;queue[end++]=n;
      }
    }
    samples.set(first,light);return light;
  };
  for(const mesh of meshes) {
    if(!mesh)continue;
    const data=new DataView(mesh.vertices.buffer,mesh.vertices.byteOffset,mesh.vertices.byteLength);
    for(let v=0;v<mesh.vertexCount;v+=4) {
      const n=[data.getInt8(v*20+8)/127,data.getInt8(v*20+9)/127,data.getInt8(v*20+10)/127],p=[0,0,0];
      const corners=Math.min(4,mesh.vertexCount-v);
      for(let j=0;j<corners;j++){const o=(v+j)*20,s=data.getInt16(o+6,true);for(let a=0;a<3;a++)p[a]+=(data.getInt16(o+a*2,true)/s+(a===1?(mesh.originY??0):0))/corners;}
      p[0]+=chunk.chunkX*chunk.chunkSize+n[0]*.1;p[1]+=n[1]*.1;p[2]+=chunk.chunkZ*chunk.chunkSize+n[2]*.1;
      const light=sample(p),encoded=128|((light.sun*16+light.sky)<<8)|(light.local<<3);
      for(let j=0;j<corners;j++){const o=(v+j)*20+18;data.setUint16(o,(data.getUint16(o,true)&7)|encoded,true);}
    }
    mesh.lightEncoding="sun4-sky4-local4-v1";
  }
  return {cells:sampledCells,domainCells:count,radius,skySeeds,localSeeds,samples:samples.size};
}
