// Dense source-to-face reference retained to verify sparse transport equivalence.
import { BLOCK_FLAGS } from "../../core/constants.js";
import { blockFlags, isOpaqueSolidBlock } from "../../world/block-registry.js";

export const DEFAULT_CAVE_LIGHTING = Object.freeze({ radius: 4, attenuation: 3 });
const STEPS=[[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]];

// Finite six-neighbour light transport, not a height-only AO approximation.
// The complete radius is captured on every side, including across sections.
// Direct sunlight and sky transport are separate from emissive local sources.
export function bakeDenseLightingOracle(chunk, section, access, meshes, options = DEFAULT_CAVE_LIGHTING) {
  if(!meshes.some(mesh=>mesh?.vertexCount))return;
  const radius=Math.max(1,Math.min(8,Math.trunc(options.radius??4)));
  const attenuation=Math.max(1,Math.ceil(15/radius));
  let minX=0,minZ=0,maxX=chunk.chunkSize,maxZ=chunk.chunkSize,minY=section.originY,maxY=section.originY+section.height;
  for(const mesh of meshes)if(mesh?.vertexCount&&mesh.bounds){const b=mesh.bounds;minX=Math.min(minX,b.minX);minZ=Math.min(minZ,b.minZ);maxX=Math.max(maxX,b.maxX);maxZ=Math.max(maxZ,b.maxZ);minY=Math.min(minY,b.minY+(mesh.originY??0));maxY=Math.max(maxY,b.maxY+(mesh.originY??0));}
  const width=Math.max(Math.ceil(maxX)-Math.floor(minX),Math.ceil(maxZ)-Math.floor(minZ))+2*radius,height=Math.ceil(maxY)-Math.floor(minY)+2*radius;
  const ox=chunk.chunkX*chunk.chunkSize+Math.floor(minX)-radius,oy=Math.floor(minY)-radius,oz=chunk.chunkZ*chunk.chunkSize+Math.floor(minZ)-radius;
  const count=width*width*height;
  const solid=new Uint8Array(count),sky=new Uint8Array(count),local=new Uint8Array(count);
  const tops=new Int32Array(width*width),skyQueue=[],localQueue=[];
  const index=(x,y,z)=>x+z*width+y*width*width;
  for(let z=0;z<width;z++)for(let x=0;x<width;x++)tops[x+z*width]=access.getColumnTopAtWorld?.(ox+x,oz+z)??chunk.minY+chunk.height;
  for(let y=0;y<height;y++)for(let z=0;z<width;z++)for(let x=0;x<width;x++) {
    const i=index(x,y,z),id=access.getBlockAtWorld(ox+x,oy+y,oz+z);
    solid[i]=isOpaqueSolidBlock(id)?1:0;
    if(!solid[i]&&oy+y>tops[x+z*width]){sky[i]=15;skyQueue.push(i);}
    if(blockFlags(id)&BLOCK_FLAGS.EMISSIVE){local[i]=15;localQueue.push(i);}
  }
  const propagate=(field,queue)=>{
    for(let q=0;q<queue.length;q++){
      const i=queue[q],y=Math.floor(i/(width*width)),rem=i-y*width*width,z=Math.floor(rem/width),x=rem-z*width;
      const value=field[i]-attenuation;if(value<=0)continue;
      for(const [dx,dy,dz]of STEPS){const nx=x+dx,ny=y+dy,nz=z+dz;if(nx<0||ny<0||nz<0||nx>=width||nz>=width||ny>=height)continue;
        const n=index(nx,ny,nz);if(solid[n]||field[n]>=value)continue;field[n]=value;queue.push(n);
      }
    }
  };
  propagate(sky,skyQueue);propagate(local,localQueue);
  const sample=(p)=>{
    const x=Math.floor(p[0])-ox,y=Math.floor(p[1])-oy,z=Math.floor(p[2])-oz;
    if(x<0||y<0||z<0||x>=width||z>=width||y>=height)return {sun:0,sky:0,local:0};
    const i=index(x,y,z);
    return {sun:!solid[i]&&Math.floor(p[1])>tops[x+z*width]?15:0,sky:sky[i],local:local[i]};
  };
  for(const mesh of meshes) {
    if(!mesh)continue;
    const data=new DataView(mesh.vertices.buffer,mesh.vertices.byteOffset,mesh.vertices.byteLength);
    for(let v=0;v<mesh.vertexCount;v+=4) {
      const n=[data.getInt8(v*20+8)/127,data.getInt8(v*20+9)/127,data.getInt8(v*20+10)/127];
      const corners=Math.min(4,mesh.vertexCount-v);
      for(let j=0;j<corners;j++) {
        const offset=(v+j)*20,scale=data.getInt16(offset+6,true);
        const origin=[chunk.chunkX*chunk.chunkSize,mesh.originY??0,chunk.chunkZ*chunk.chunkSize];
        const point=origin.map((value,axis)=>value+data.getInt16(offset+axis*2,true)/scale+n[axis]*.1);
        const light=sample(point),encoded=128|((light.sun*16+light.sky)<<8)|(light.local<<3);
        data.setUint16(offset+18,(data.getUint16(offset+18,true)&7)|encoded,true);
      }
    }
    mesh.lightEncoding="sun4-sky4-local4-v1";
  }
  return {cells:count,radius,skySeeds:skyQueue.length,localSeeds:localQueue.length};
}
