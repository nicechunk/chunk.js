// Same-input alternating CPU benchmark. No GPU, RPC, Worker or production writes.
// node --expose-gc benchmarks/section-edit-bench.mjs --before /path/to/baseline
//   --after /path/to/candidate --output /path/to/section-performance.json
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { cpus, loadavg } from 'node:os';
const argv=process.argv.slice(2),option=(name,fallback)=>{const i=argv.indexOf(name);return i<0?fallback:argv[i+1];};
const engineRoot=fileURLToPath(new URL('../',import.meta.url));
const roots={before:resolve(option('--before',resolve(engineRoot,'../baseline-chunk.js'))),after:resolve(option('--after',engineRoot))};
const output=resolve(option('--output','evidence/section-performance.json'));
const samples=Number(option('--samples','5')),counts=option('--counts','0,128,1024,8192,24576').split(',').map(Number),frameBudgetMs=4;
if(!Number.isInteger(samples)||samples<5)throw Error('At least five samples are required.');
if(argv.includes('--summarize-only')){
 const recorded=JSON.parse(await readFile(output,'utf8'));
 for(const group of recorded.results)for(const mode of ['single-dig','single-backfill','sparse','continuous'])for(const side of ['before','after'])group.scenarios[mode][side]=summarize(recorded.raw.filter(row=>row.initialDeltaCount===group.initialDeltaCount&&row.mode===mode&&row.side===side));
 recorded.quantileMethod='nearest-rank; all samples retained, no outlier filtering';
 await writeFile(output,JSON.stringify(recorded,null,2));await writeFile(output.replace(/\.json$/,'.md'),markdown(recorded));process.exit(0);
}
const modules={};for(const [name,root]of Object.entries(roots))modules[name]=await import(pathToFileURL(root+'/chunk/chunk-manager.js'));
const fixture={chunkX:0,chunkZ:0,chunkSize:16,minY:-32,height:353,worldSeed:'mainnet default (MAINNET_WORLD_SEED)',targetY:65,initialDeltaLayout:'i -> x=i%16,y=floor(i/256)-32,z=floor(i/16)%16,blockId=air'};
const result={kind:'Same-machine CPU wall/process time and CPU mesh commit latency. Not GPU, FPS, end-to-end frame latency or production measurements.',startedAt:new Date().toISOString(),node:process.version,quantileMethod:'nearest-rank; all samples retained, no outlier filtering',roots,samples,frameBudgetMs,fixture,environment:{cpu:cpus()[0]?.model,logicalCpus:cpus().length,cgroupCpuMax:await safeRead('/sys/fs/cgroup/cpu.max'),loadavgAtStart:loadavg(),background:option('--background','Controlled SwiftShader renderer/real Worker long session remains active; no other benchmark pair. Shared cgroup and concurrent team activity mean this is not an idle target device.')},source:{},results:[],raw:[],limitations:[]};
for(const [name,root]of Object.entries(roots)){result.source[name]={};for(const f of ['chunk/chunk-manager.js','chunk/chunk-mesher.js','chunk/chunk-state.js','chunk/render-sections.js','chunk/baked-light-field.js','chunk/chunk-authority.js','chunk/chunk-delta.js','world/world-generator.js','world/block-registry.js','renderer/mesh-draw-ranges.js']){const bytes=await safeRead(root+'/'+f,false);if(bytes!==null)result.source[name][f]=createHash('sha256').update(bytes).digest('hex');}}
await mkdir(dirname(output),{recursive:true});
const allStartCpu=process.cpuUsage();
for(let countIndex=0;countIndex<counts.length;countIndex++){
 const initialCount=counts[countIndex],engines={},setup={};
 const edits=Array.from({length:initialCount},(_,i)=>({worldX:i%16,worldY:Math.floor(i/256)-32,worldZ:Math.floor(i/16)%16,blockId:0}));
 for(const side of countIndex%2?['after','before']:['before','after']){
  const start=performance.now(),cpu=process.cpuUsage();const manager=new modules[side].ChunkManager({useWorkers:false,viewDistance:1,preloadMargin:0});
  const chunk=manager.ensureChunk(0,0);if(chunk.height!==353||chunk.minY!==-32)throw Error('Default world dimensions changed.');
  const events=[];manager.setRenderLogger({record(type,data){events.push({type,recordedAt:performance.now(),...data});}});
  if(edits.length)manager.applyChainDelta(edits);
  drain(manager,Infinity);
  setup[side]={wallMs:performance.now()-start,cpuMs:cpuMilliseconds(process.cpuUsage(cpu)),initialDeltaCount:chunk.getFinalDeltaMap().size,triangles:triangles(manager),cpuMeshBytes:meshBytes(manager),renderSections:chunk.renderSections?.size??0};
  engines[side]={manager,chunk,events};
 }
 for(const p of [[8,65,8],[3,65,3],[12,65,3],[3,69,12],[12,69,12],...Array.from({length:8},(_,i)=>[5+i,66,10])]){
  const before=engines.before.manager.getBlockAtWorld(...p),after=engines.after.manager.getBlockAtWorld(...p);if(before!==after||before===0)throw Error('Expected identical solid baseline target '+p);}
 const bases=new Map();for(const p of [[8,65,8],[3,65,3],[12,65,3],[3,69,12],[12,69,12],...Array.from({length:8},(_,i)=>[5+i,66,10])])bases.set(p.join(','),engines.before.manager.getBlockAtWorld(...p));
 const sparse=[[3,65,3],[12,65,3],[3,69,12],[12,69,12]],continuous=Array.from({length:8},(_,i)=>[5+i,66,10]);
 for(let sample=0;sample<samples;sample++){
  const order=(sample+countIndex)%2?['after','before']:['before','after'];
  for(const [phase,block]of [['dig',0],['backfill',bases.get('8,65,8')]])for(const side of order){const row=measure(engines[side],side,initialCount,sample,'single-'+phase,[[{worldX:8,worldY:65,worldZ:8,blockId:block}]],true);result.raw.push(row);}
  for(let step=0;step<sparse.length*2;step++){
    const p=sparse[Math.floor(step/2)],blockId=step%2?bases.get(p.join(',')):0;
    for(const side of order)result.raw.push(measure(engines[side],side,initialCount,sample,'sparse',[[{worldX:p[0],worldY:p[1],worldZ:p[2],blockId}]],true,{step}));
  }
  const batches=continuous.map(p=>[{worldX:p[0],worldY:p[1],worldZ:p[2],blockId:sample%2?bases.get(p.join(',')):0}]);
  for(const side of order)result.raw.push(measure(engines[side],side,initialCount,sample,'continuous',batches,true,{burstEdits:batches.length}));
 }
 const hashes={};for(const side of ['before','after']){const e=engines[side];hashes[side]=deltaHash(e.chunk);e.manager.dispose();}
 if(hashes.before!==hashes.after)throw Error('Before/after final voxel edit maps diverged.');
 const group={initialDeltaCount:initialCount,setup,finalDeltaHash:hashes.before,scenarios:{}};
 for(const mode of ['single-dig','single-backfill','sparse','continuous']){group.scenarios[mode]={};for(const side of ['before','after']){const rows=result.raw.filter(r=>r.initialDeltaCount===initialCount&&r.mode===mode&&r.side===side);group.scenarios[mode][side]=summarize(rows);}}
 result.results.push(group);result.updatedAt=new Date().toISOString();await writeFile(output,JSON.stringify(result,null,2));
 console.log(JSON.stringify({initialDeltaCount:initialCount,single:group.scenarios['single-dig'],continuous:group.scenarios.continuous}));
 for(const key of Object.keys(engines))delete engines[key];global.gc?.();
}
result.finishedAt=new Date().toISOString();result.totalProcessCpuMs=cpuMilliseconds(process.cpuUsage(allStartCpu));result.environment.loadavgAtEnd=loadavg();
result.limitations=[
 'Each sample invokes real synchronous ChunkManager.rebuildDirtyChunks(4) until a complete CPU mesh commit. No renderer/GPU frame is submitted; latestCpuCommitMs excludes GPU scheduling/upload and real requestAnimationFrame intervals.',
 'The initial accumulated edits use a deterministic excavated slab; subsequent sparse and continuous sequences are both tested. Initialization, initial bulk merge and the first complete rebuild are combined in setup.wallMs/setup.cpuMs and excluded from edit samples. Those setup phases are not individually timed.',
 'Five dig/backfill and continuous samples, forty sparse edit steps per side/count. No slow sample is removed; percentile summaries retain all recorded samples. Sequential pair order alternates.',
 'The baseline has no voxelVisits/uniqueVoxelQueries/lightCells instrumentation; these fields remain null. Candidate work values are actual render-log sums, not inferred from a 4096-voxel section bound. Per-section unique counts may count the same halo coordinate in multiple sections.',
 'voxelCacheBytesAllocated sums temporary voxel caches across completed section tasks. It is not retained CPU mesh size or simultaneous memory peak. cpuMeshBytes counts unique retained typed-array backing buffers without forcing the candidate lazy whole-chunk compatibility mesh.',
 'The candidate also computes cave/local lighting and correct section/halo faces; raw triangle totals can differ through section partitioning and correctness fixes. The benchmark does not replace the independent face oracle.',
 'Shared two-CPU cgroup and background controlled long sessions produce wall-time contention. Process CPU time helps distinguish work from scheduling delay; these are not universal device speed/FPS promises.'
];
await writeFile(output,JSON.stringify(result,null,2));await writeFile(output.replace(/\.json$/,'.md'),markdown(result));
console.log(JSON.stringify({finishedAt:result.finishedAt,totalProcessCpuMs:result.totalProcessCpuMs,output}));

function measure(engine,side,initialDeltaCount,sample,mode,batches,_verify,extra={}){
 const {manager,chunk,events}=engine;events.length=0;const oldCpu=process.cpuUsage(),start=performance.now();let firstEditAt=null,lastEditAt=null,editApplyMs=0,changedChunks=0;
 for(const batch of batches){const at=performance.now();firstEditAt??=at;lastEditAt=at;const applied=manager.applyChainDelta(batch);editApplyMs+=performance.now()-at;changedChunks+=applied.changedChunks??0;}
 if(!changedChunks)throw Error('Measured input unexpectedly had no state change.');
 const applyEnd=performance.now(),pumps=drain(manager,4),finish=performance.now(),usedCpu=process.cpuUsage(oldCpu);
 const buildEvents=events.filter(e=>e.type==='section-build-sync'||e.type==='chunk-build-sync');
 if(!buildEvents.length)throw Error('No completed build was observed.');
 const committedAt=Math.max(...buildEvents.map(e=>e.recordedAt));
 const sectionEvents=buildEvents.filter(e=>e.type==='section-build-sync');
 const sum=key=>sectionEvents.reduce((n,e)=>n+(Number(e[key])||0),0);
 for(const batch of batches)for(const delta of batch){const actual=manager.getBlockAtWorld(delta.worldX,delta.worldY,delta.worldZ);if(actual!==delta.blockId)throw Error('Final edit did not survive rebuild.');}
 return {side,initialDeltaCount,sample,mode,...extra,inputEdits:batches.flat(),finalDeltaCount:chunk.getFinalDeltaMap().size,wallMs:finish-start,processCpuMs:cpuMilliseconds(usedCpu),deltaApplyMs:editApplyMs,rebuildMs:finish-applyEnd,latestCpuCommitMs:committedAt-lastEditAt,oldestCpuCommitMs:committedAt-firstEditAt,pumpCount:pumps.length,maxPumpMs:Math.max(...pumps),pumpMs:pumps,buildTaskCount:buildEvents.length,sectionCount:sectionEvents.length,
  work:sectionEvents.length?{voxelVisits:sum('voxelVisits'),uniqueVoxelQueries:sum('uniqueVoxelQueries'),voxelCacheBytesAllocated:sum('voxelCacheBytes'),lightCells:sum('lightCells')}:null,
  triangles:triangles(manager),cpuMeshBytes:meshBytes(manager),committedWorldVersion:chunk.version,committedMeshVersion:chunk.meshVersion,remainingDirty:chunk.dirty,buildLog:buildEvents};
}
function drain(manager,budget){const pumps=[];for(let guard=0;guard<256&&[...manager.chunks.values()].some(c=>c.dirty);guard++){const at=performance.now();manager.rebuildDirtyChunks(budget);pumps.push(performance.now()-at);}if([...manager.chunks.values()].some(c=>c.dirty))throw Error('Dirty mesh did not converge in 256 CPU pumps');return pumps;}
function triangles(manager){const stats=manager.stats();return stats.triangles+stats.visualTriangles;}
function meshBytes(manager){if(manager.diagnostics)return manager.diagnostics({maxEntries:0}).cpuMeshBytes;const seen=new Set();let bytes=0;for(const c of manager.chunks.values())for(const m of [c.mesh,c.visualMesh])for(const a of [m?.vertices,m?.indices])if(a?.buffer&&!seen.has(a.buffer)){seen.add(a.buffer);bytes+=a.buffer.byteLength;}return bytes;}
function deltaHash(chunk){return createHash('sha256').update(JSON.stringify([...chunk.getFinalDeltaMap().values()].map(d=>[d.localX,d.localY,d.localZ,d.blockId]).sort((a,b)=>a[1]-b[1]||a[2]-b[2]||a[0]-b[0]))).digest('hex');}
function cpuMilliseconds(cpu){return (cpu.user+cpu.system)/1000;}
function percentiles(values){const a=[...values].sort((x,y)=>x-y),at=q=>a[Math.min(a.length-1,Math.max(0,Math.ceil(a.length*q)-1))];return {min:a[0],median:at(.5),p95:at(.95),p99:at(.99),max:a.at(-1)};}
function summarize(rows){const out={samples:rows.length};for(const key of ['wallMs','processCpuMs','deltaApplyMs','rebuildMs','latestCpuCommitMs','oldestCpuCommitMs','maxPumpMs','pumpCount','triangles','cpuMeshBytes','finalDeltaCount','buildTaskCount'])out[key]=percentiles(rows.map(r=>r[key]));out.work=rows[0].work?Object.fromEntries(Object.keys(rows[0].work).map(k=>[k,percentiles(rows.map(r=>r.work[k]))])):null;return out;}
async function safeRead(path,text=true){try{const b=await readFile(path);return text?b.toString().trim():b;}catch{return null;}}
function markdown(r){const lines=['# Section local edit CPU benchmark','',r.kind,'',...(r.measurementStage?[r.measurementStage,'']:[]),...(r.supersededForFinalReleaseTimingBy?['Final release timing is recorded separately in `'+r.supersededForFinalReleaseTimingBy+'`. This earlier dataset is retained without replacing its raw samples.','']:[]),`Node ${r.node}; ${r.environment.cpu}; CPU cgroup: ${r.environment.cgroupCpuMax}.`,`Background: ${r.environment.background}`,'',`Seed/config: default mainnet seed, chunk (0,0), 16×16×353, minY=-32. Five paired samples/count, alternating before/after order. Build scheduler budget ${r.frameBudgetMs}ms.`,'','| Initial deltas | Scenario | Baseline wall median / max ms | Candidate wall median / max ms | Baseline / candidate CPU median ms | Candidate actual queries / visits median | Candidate light cells median | Candidate max pump ms |','| --- | --- | --- | --- | --- | --- | --- | --- |'];for(const group of r.results)for(const [name,pair]of Object.entries(group.scenarios)){const a=pair.before,b=pair.after,fmt=v=>Number(v).toFixed(3);lines.push(`| ${group.initialDeltaCount} | ${name} | ${fmt(a.wallMs.median)} / ${fmt(a.wallMs.max)} | ${fmt(b.wallMs.median)} / ${fmt(b.wallMs.max)} | ${fmt(a.processCpuMs.median)} / ${fmt(b.processCpuMs.median)} | ${b.work?.uniqueVoxelQueries.median??'n/a'} / ${b.work?.voxelVisits.median??'n/a'} | ${b.work?.lightCells.median??'n/a'} | ${fmt(b.maxPumpMs.max)} |`);}lines.push('','## Newest edit CPU commit and retained mesh','','These are input-to-complete CPU commit intervals from continuous local pumping. They exclude GPU upload and real frame scheduling. Percentiles use nearest rank; five-sample p95/p99 therefore report the maximum.','','| Initial deltas | Scenario | Baseline commit p50 / p95 / p99 ms | Candidate commit p50 / p95 / p99 ms | Baseline / candidate retained CPU mesh bytes | Baseline / candidate triangles |','| --- | --- | --- | --- | --- | --- |');for(const group of r.results)for(const [name,pair]of Object.entries(group.scenarios)){const a=pair.before,b=pair.after,fmt=v=>Number(v).toFixed(3),commit=v=>[v.median,v.p95,v.p99].map(fmt).join(' / ');lines.push(`| ${group.initialDeltaCount} | ${name} | ${commit(a.latestCpuCommitMs)} | ${commit(b.latestCpuCommitMs)} | ${a.cpuMeshBytes.median} / ${b.cpuMeshBytes.median} | ${a.triangles.median} / ${b.triangles.median} |`);}lines.push('','## Budget interpretation','','60 FPS allows 16.67ms for an entire frame. The chosen 4ms CPU build scheduling budget leaves room for simulation, upload and submission, but it is a soft deadline checked between tasks. Compare measured maximum pump duration against that budget: one slow section/driver call can exceed it. CPU commit latency here is a continuously pumped local measurement, not a measured GPU frame SLA.','','## Limitations','',...r.limitations.map(x=>'- '+x),'','All raw timings, source hashes, real build logs, CPU mesh sizes and triangle totals are preserved in the adjacent JSON.');if(r.postMeasurementChanges?.length){lines.push('','## Changes after measurement','');for(const change of r.postMeasurementChanges)lines.push(`- ${change.file}: ${change.change} ${change.recordedSourceSha256?'Measured':'Previous delivered'} SHA256 ${change.recordedSourceSha256??change.previousDeliveredSourceSha256}; delivered SHA256 ${change.newSourceSha256}. ${change.excludedPath} ${change.reachedNoOpPath??''} ${change.exactDiff?'Exact diff: '+change.exactDiff+'. ':''}${change.performanceRerun}`);}return lines.join('\n')+'\n';}
