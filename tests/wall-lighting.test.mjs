import test from "node:test";
import assert from "node:assert/strict";
import { bakeSectionLighting } from "../chunk/baked-light-field.js";
import { BLOCK_ID } from "../world/block-registry.js";
import { blockFlags, isOpaqueSolidBlock } from "../world/block-registry.js";
import { BLOCK_FLAGS } from "../core/constants.js";

function wall(bottom, top, originY = 0) {
  const vertices = new Uint8Array(80), data = new DataView(vertices.buffer);
  [[4,bottom,4],[4,bottom,12],[4,top,12],[4,top,4]].forEach((point,i) => {
    const offset = i * 20;
    point.forEach((value,axis) => data.setInt16(offset+axis*2,(value-(axis===1?originY:0))*64,true));
    data.setInt16(offset+6,64,true);data.setInt8(offset+8,-127);data.setUint16(offset+18,2,true);
  });
  return { vertices, vertexCount:4, originY };
}
const chunk = {chunkX:0,chunkZ:0,chunkSize:16,minY:0,height:32};
const access = {
  getColumnTopAtWorld: (x,z) => x>=0&&x<4&&z>=0&&z<=16?8:-1,
  getBlockAtWorld: (x,y,z) => y===8&&x>=0&&x<4&&z>=0&&z<=16?BLOCK_ID.stone:BLOCK_ID.air,
};
function flags(mesh) {const d=new DataView(mesh.vertices.buffer);return [0,1,2,3].map(i=>d.getUint16(i*20+18,true));}

test("a greedy wall retains diffuse roof shade while low sunlight enters from its open side", () => {
  const mesh=wall(1,13);
  bakeSectionLighting(chunk,{originY:0,height:16},access,[mesh]);
  const light=flags(mesh);
  assert.equal(light[0]>>>12,15);assert.equal(light[1]>>>12,15);
  assert.equal(light[2]>>>12,15);assert.equal(light[3]>>>12,15);
  assert.ok(((light[0]>>>8)&15)<15);assert.ok(((light[1]>>>8)&15)<15);
  assert.equal((light[2]>>>8)&15,15);assert.equal((light[3]>>>8)&15,15);
  assert.ok(light.every(value=>(value&7)===2),"material flags must survive");
  assert.equal(mesh.vertexCount,4,"lighting must not add geometry");
});

test("adjacent section walls share identical corner illumination", () => {
  const lower=wall(1,16), upper=wall(16,29,16);
  bakeSectionLighting(chunk,{originY:0,height:16},access,[lower]);
  bakeSectionLighting(chunk,{originY:16,height:16},access,[upper]);
  assert.equal(flags(lower)[2],flags(upper)[1]);
  assert.equal(flags(lower)[3],flags(upper)[0]);
});

test("cached diffuse corner transport matches an independent finite six-neighbour oracle", () => {
  const block = (x,y,z) => {
    if (x<0||x>=16||y<0||y>=16||z<0||z>=16) return BLOCK_ID.air;
    const code=(x*73+y*31+z*17)%37;
    return code<9?BLOCK_ID.stone:code===12?BLOCK_ID.lava:BLOCK_ID.air;
  };
  const tops=new Map();
  const top=(x,z)=>{
    const key=x+","+z;if(tops.has(key))return tops.get(key);
    let y=15;while(y>=0&&!isOpaqueSolidBlock(block(x,y,z)))y--;
    tops.set(key,y);return y;
  };
  const oracle=(x,y,z)=>{
    const queue=[[x,y,z,0]],seen=new Set([`${x},${y},${z}`]);let sky=0,local=0;
    const sun=!isOpaqueSolidBlock(block(x,y,z))&&y>top(x,z)?15:0;
    for(let index=0;index<queue.length;index++) {
      const [cx,cy,cz,depth]=queue[index],id=block(cx,cy,cz),opaque=isOpaqueSolidBlock(id);
      if(!opaque&&cy>top(cx,cz))sky=Math.max(sky,15-depth*4);
      if(blockFlags(id)&BLOCK_FLAGS.EMISSIVE)local=Math.max(local,15-depth*4);
      if(opaque||depth===3)continue;
      for(const [dx,dy,dz]of [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]]) {
        const next=[cx+dx,cy+dy,cz+dz],key=next.join(",");
        if(!seen.has(key)){seen.add(key);queue.push([...next,depth+1]);}
      }
    }
    return 128|((sun*16+sky)<<8)|(local<<3);
  };
  const points=Array.from({length:128},(_,i)=>[3+i%10,3+Math.floor(i/10)%10,3+Math.floor(i/17)%10]);
  const vertices=new Uint8Array(points.length*20),data=new DataView(vertices.buffer);
  points.forEach((point,i)=>{point.forEach((value,axis)=>data.setInt16(i*20+axis*2,(value+.5)*64,true));data.setInt16(i*20+6,64,true);data.setInt8(i*20+8,-127);});
  bakeSectionLighting(chunk,{originY:0,height:16},{getBlockAtWorld:block,getColumnTopAtWorld:top},[{vertices,vertexCount:points.length}]);
  // Direct sunlight now follows a directional ray, rather than this legacy
  // vertical seed. Keep this independent BFS gate for diffuse and local light.
  points.forEach(([x,y,z],i)=>assert.equal(data.getUint16(i*20+18,true)&4095,oracle(x,y,z)&4095,`corner ${x},${y},${z}`));
});
