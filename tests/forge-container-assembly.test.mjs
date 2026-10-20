import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { analyzeForgeContainer } from "../forge/forge-container.js";
import { decodeNcf1 } from "../forge/forge-core.js";
import { validateForgeGripSurface } from "../forge/forge-grip-validation.js";
const rows=JSON.parse(fs.readFileSync(new URL("./fixtures/water-assemblies.json",import.meta.url)));
for(const row of rows) test(`assembled water cavity: ${row.name}`,()=>{
 const result=analyzeForgeContainer(Buffer.from(row.codeHex,"hex"));
 assert.equal(result.valid,row.valid,row.name);assert.equal(result.capacityMl,row.capacityMl,row.name);
 if(row.valid) {
  // Independently known rectangular interior: 12/64 x 10/64 x 12/64 metres.
  assert.equal(result.volumeQ3,12*32*10*32*12*32);
  assert.equal(result.capacityMl,Math.floor(12*10*12*1_000_000/64**3));
  assert.equal(analyzeForgeContainer(Buffer.from(row.codeHex,"hex"),{seedIndex:result.seedIndex}).volumeQ3,result.volumeQ3);
 }
});
test("a valid source-component grip stays valid beside coplanar assembled walls",()=>{
 const row=rows.find(x=>x.name==="mixed-five-walls-coplanar-shaft");const d=decodeNcf1(Buffer.from(row.codeHex,"hex"));
 const i=d.components.findIndex(c=>c.grip);
 assert.ok(new Set(d.components.map(c=>c.resource)).size>=4,"fixture must contain real distinct resource classes");
 assert.equal(validateForgeGripSurface(d.components[i],d.components[i].grip,{components:d.components,componentIndex:i}).valid,true);
 assert.equal(analyzeForgeContainer(Buffer.from(row.codeHex,"hex")).valid,true);
});
