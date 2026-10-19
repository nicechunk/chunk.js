import { Worker } from "node:worker_threads";

/** Runs the production browser Worker module in a real Node worker thread. */
export async function createActualBuildWorker() {
  const source = new URL("../../chunk/chunk-build-worker.js", import.meta.url).href;
  const bootstrap = `import {parentPort} from "node:worker_threads";
    globalThis.self=globalThis;
    self.postMessage=(message,transfer)=>parentPort.postMessage(message,transfer);
    await import(${JSON.stringify(source)});
    parentPort.on("message",data=>self.onmessage({data}));
    parentPort.postMessage({type:"ready"});`;
  const worker=new Worker(new URL(`data:text/javascript,${encodeURIComponent(bootstrap)}`),{type:"module"});
  const pending=new Map();let sequence=1;
  const ready=new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error("Actual build Worker did not start")),20000);
    worker.once("error",reject);
    worker.on("message",message=>{if(message.type==="ready"){clearTimeout(timer);resolve();}});
  });
  worker.on("message",message=>{
    const entry=pending.get(message.taskId);if(!entry)return;
    if(message.type==="chunkProgress"){
      entry.progress.push(message);entry.onProgress?.(message);return;
    }
    pending.delete(message.taskId);clearTimeout(entry.timer);
    if(message.type==="chunkBuildError")entry.reject(new Error(message.error));
    else if(message.progressComplete){
      const first=entry.progress[0];
      entry.resolve({...message,baseProfile:first?.baseProfile??null,treeInstances:first?.treeInstances??null,
        sectionResults:entry.progress.flatMap(part=>part.sectionResults??[]).sort((a,b)=>a.sectionIndex-b.sectionIndex),progress:entry.progress});
    }else entry.resolve(message);
  });
  worker.on("error",error=>{for(const entry of pending.values()){clearTimeout(entry.timer);entry.reject(error);}pending.clear();});
  await ready;
  return {
    setSurfaceDecorationRules(rules, revision=1) {
      worker.postMessage({type:"setSurfaceDecorationRules",rules,revision});
    },
    build(task, { onProgress = null } = {}) {
      const taskId=sequence++;
      return new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>{pending.delete(taskId);reject(new Error(`Actual Worker timeout for task ${taskId}`));},30000);
        pending.set(taskId,{resolve,reject,timer,progress:[],onProgress});worker.postMessage({...task,type:"buildChunk",taskId});
      });
    },
    async dispose(){for(const entry of pending.values()){clearTimeout(entry.timer);entry.reject(new Error("Worker terminated"));}pending.clear();await worker.terminate();},
  };
}
