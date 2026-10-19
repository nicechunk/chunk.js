// Controlled renderer/real Worker endurance test. No wallets, RPC, or chain writes.
// npm install playwright in the host workspace; DURATION_MS defaults to 60 minutes.
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, mkdir, appendFile, writeFile } from 'node:fs/promises';
import { resolve, dirname, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const evidence=resolve(process.env.EVIDENCE_DIR??resolve(root,'evidence/gpu-long-session'));
const durationMs=Number(process.env.DURATION_MS??3600000);
await mkdir(evidence,{recursive:true});
const server=createServer(async(req,res)=>{try{const path=resolve(root,'.'+decodeURIComponent(new URL(req.url,'http://localhost').pathname));if(path!==root&&!path.startsWith(root+sep))throw Error('outside root');const bytes=await readFile(path);res.setHeader('Content-Type',extname(path)==='.js'?'text/javascript':'text/plain');res.end(bytes);}catch{res.statusCode=404;res.end('not found');}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
let browser;
const harnessStartedAt=Date.now(),logs=[];
let rendererElapsedMs=0;
try{
 browser=await chromium.launch({headless:true,args:['--no-sandbox','--disable-gpu-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
 const page=await browser.newPage({viewport:{width:640,height:360}});
 const errors=[];page.on('pageerror',e=>{if(errors.length<50)errors.push(String(e));});
 await page.goto(origin+'/README.md');
 await page.evaluate(async()=>{
  const {WebGL2VoxelRenderer}=await import('/renderer/webgl2-renderer.js');
  const {createCameraState}=await import('/renderer/camera.js');
  const canvas=document.createElement('canvas');canvas.style.cssText='width:640px;height:360px';document.body.replaceChildren(canvas);document.body.style.margin='0';
  const renderer=new WebGL2VoxelRenderer(canvas,{dpr:1,textureTileSize:16,cloudRadius:1,maxVoxelParticles:32});renderer.init();
  const gl=renderer.gl,dbg=gl.getExtension('WEBGL_debug_renderer_info');
  const state={startedAt:performance.now(),frames:0,workerTasks:0,workerResults:0,workerErrors:[],contextCycles:0,maxResidentBytes:0,viewDistances:[],running:true,renderer,canvas,chunks:new Map(),frameTimes:[],failures:[]};
  state.environment={renderer:dbg?gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER),version:gl.getParameter(gl.VERSION),worker:'/chunk/chunk-build-worker.js',hardwareGpu:false};
  const worker=new Worker('/chunk/chunk-build-worker.js',{type:'module'});state.worker=worker;
  let inFlight=false,task=0,lastDispatch=-1,lastLoss=-1,lastEdit=-1;
  const fixtures=new Map();
  worker.onmessage=({data})=>{inFlight=false;if(data.type!=='chunkBuilt'){if(state.workerErrors.length<30)state.workerErrors.push(data);return;}state.workerResults++;
   const id=`${data.chunkX},${data.chunkZ}`;let chunk=state.chunks.get(id);
   if(!chunk){chunk={id,chunkX:data.chunkX,chunkZ:data.chunkZ,chunkSize:16,renderSections:new Map()};state.chunks.set(id,chunk);}
   for(const result of data.sectionResults??[data]){let section=chunk.renderSections.get(result.sectionIndex);if(!section){section={id:`${id}@${result.sectionIndex}`,parentId:id,chunkX:data.chunkX,chunkZ:data.chunkZ,chunkSize:16,generation:state.workerResults,originY:result.mesh?.originY??0};chunk.renderSections.set(result.sectionIndex,section);}Object.assign(section,{mesh:result.mesh,visualMesh:result.visualMesh,meshVersion:data.taskId,visualMeshVersion:data.taskId,gpuUploaded:false,visualGpuUploaded:false});}
  };
  worker.onerror=e=>{inFlight=false;if(state.workerErrors.length<30)state.workerErrors.push(String(e.message));};
  const avatar={vertices:new Float32Array([-0.3,0,0,0,0,-1,1,0,0,1,.3,0,0,0,0,-1,1,0,0,1,0,1,0,0,0,-1,1,0,0,1]),indices:new Uint16Array([0,2,1]),indexCount:3,triangleCount:1};renderer.uploadAvatarMesh('stable-avatar',avatar);
  const camera=createCameraState({worldX:15,worldY:12,worldZ:-8,targetWorldX:16,targetWorldY:4,targetWorldZ:8,far:400});
  const tick=()=>{if(!state.running)return;const start=performance.now(),elapsed=start-state.startedAt;const second=Math.floor(elapsed/1000);
   try{
    camera.worldX=15+Math.floor(Math.sin(elapsed/15000)*20);camera.targetWorldX=16;camera.localOffsetX=0.25*Math.sin(elapsed/1300);
    const distance=[2,7,20][Math.floor(elapsed/30000)%3];if(renderer.options.viewDistance!==distance){renderer.options.viewDistance=distance;state.viewDistances.push({second,value:distance});}
    if(second!==lastEdit&&second%5===0&&!inFlight){lastEdit=second;inFlight=true;task++;state.workerTasks++;
      const cx=task%2,cut=(Math.floor(task/2)%2)===0,id=`${cx},0`;fixtures.set(id,new Int32Array([cx*16+(cx===0?15:0),4,8,cut?0:3]));
      worker.postMessage({type:'buildChunk',taskId:task,chunkX:cx,chunkZ:0,worldSeed:'controlled-render-endurance-v1',mode:'base',taskVersion:task,materialVersion:1,options:{chunkSize:16,height:16,minY:0,maxBuildY:15,maxTerrainHeight:10,seaLevel:5,renderSections:true},finalDeltas:fixtures.get(id),neighborDeltas:fixtures.get(`${1-cx},0`)??new Int32Array()});
    }
    if(second>0&&second%300===0&&lastLoss!==second){lastLoss=second;const ext=renderer.gl.getExtension('WEBGL_lose_context');if(ext){ext.loseContext();setTimeout(()=>ext.restoreContext(),350);state.contextCycles++;}}
    const chunks=[...state.chunks.values()];renderer.prepareChunksForRender(chunks);renderer.render(camera,chunks,[{id:'avatar',meshId:'stable-avatar',worldX:15,worldY:5,worldZ:4}]);
    if(second%90===89){state.chunks.delete(`${task%2},0`);renderer.pruneChunks(new Set(state.chunks.keys()));}
    if(renderer.lastUploadError&&state.failures.length<30)state.failures.push(String(renderer.lastUploadError));
    state.maxResidentBytes=Math.max(state.maxResidentBytes,renderer.resourceLedger.bytes);state.frames++;
   }catch(error){if(state.failures.length<30)state.failures.push(String(error.stack??error));}
   state.frameTimes.push(performance.now()-start);if(state.frameTimes.length>4096)state.frameTimes.shift();setTimeout(tick,100);
  };tick();window.renderEnduranceState=state;
 });
 // Measure endurance from the renderer's own clock, excluding browser launch
 // and initialization. The final sample must itself reach the requested span.
 rendererElapsedMs=await page.evaluate(()=>performance.now()-window.renderEnduranceState.startedAt);
 while(rendererElapsedMs<durationMs){await new Promise(r=>setTimeout(r,Math.min(30000,durationMs-rendererElapsedMs)));
  const sample=await page.evaluate(()=>{const s=window.renderEnduranceState,sorted=[...s.frameTimes].sort((a,b)=>a-b),p=q=>sorted[Math.min(sorted.length-1,Math.floor(sorted.length*q))]??null;return {elapsedMs:performance.now()-s.startedAt,frames:s.frames,workerTasks:s.workerTasks,workerResults:s.workerResults,workerErrors:s.workerErrors,contextCycles:s.contextCycles,failures:s.failures,maxResidentBytes:s.maxResidentBytes,chunks:s.chunks.size,viewDistances:s.viewDistances.slice(-3),stats:s.renderer.stats,cpuFrameMs:{p50:p(.5),p95:p(.95),p99:p(.99)}};});
  rendererElapsedMs=sample.elapsedMs;
  logs.push(sample);await appendFile(resolve(evidence,'samples.jsonl'),JSON.stringify(sample)+'\n');console.log(JSON.stringify({elapsedMs:sample.elapsedMs,frames:sample.frames,workerResults:sample.workerResults,errors:sample.workerErrors.length+sample.failures.length,residentBytes:sample.stats.applicationResidentBytes}));
 }
 await page.screenshot({path:resolve(evidence,'final.png')});
 const stopped=await page.evaluate(()=>{const s=window.renderEnduranceState,rendererElapsedMs=performance.now()-s.startedAt;s.running=false;s.worker.terminate();s.renderer.dispose();return {rendererElapsedMs,cleanup:s.renderer.resourceLedger.snapshot()};});
 rendererElapsedMs=stopped.rendererElapsedMs;
 const summary={scope:'Renderer/resource/real module Worker component endurance. Synthetic local dig/backfill records; no Guardian, no RPC, no production transactions; not a full two-client game session.',timingClock:'performance.now() minus renderer state.startedAt; browser launch/init excluded',durationMs:rendererElapsedMs,rendererDurationMs:rendererElapsedMs,harnessDurationMs:Date.now()-harnessStartedAt,requestedDurationMs:durationMs,environment:await page.evaluate(()=>window.renderEnduranceState.environment),samples:logs.length,final:logs.at(-1),cleanup:stopped.cleanup,errors,completeRequestedRendererDuration:logs.at(-1)?.elapsedMs>=durationMs&&rendererElapsedMs>=durationMs,complete60Minutes:durationMs>=3600000&&logs.at(-1)?.elapsedMs>=3600000&&rendererElapsedMs>=3600000};
 await writeFile(resolve(evidence,'summary.json'),JSON.stringify(summary,null,2));if(errors.length||summary.final.workerErrors.length||summary.final.failures.length||!summary.final.workerResults)process.exitCode=1;
}catch(error){await writeFile(resolve(evidence,'fatal.json'),JSON.stringify({message:String(error.stack??error),harnessElapsedMs:Date.now()-harnessStartedAt,rendererElapsedMs}));throw error;}
finally{await browser?.close();server.close();}
