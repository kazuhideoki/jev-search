#!/usr/bin/env node
// Actual NDJSON worker process; excludes Raycast rendering and its 150 ms debounce.
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";
const [directory,manifestPath]=process.argv.slice(2);
const manifest=JSON.parse(await readFile(manifestPath,"utf8"));
const startup=[],queries=[],runtimes=[];
for(let trial=0;trial<5;trial++) {
  const start=performance.now();
  const child=spawn(process.execPath,["--max-old-space-size=512",fileURLToPath(new URL("../src/local-worker.mjs",import.meta.url)),manifest.root,path.resolve(directory,"index.json.gz"),"/opt/homebrew/bin/rg"],{stdio:["pipe","pipe","pipe"]});
  const exited=new Promise(resolve=>child.once("close",resolve));
  const lines=createInterface({input:child.stdout});
  let pending,diagnostic="";
  child.stderr.on("data",b=>diagnostic+=b);
  child.on("error",e=>pending?.reject(e));
  child.on("exit",code=>pending?.reject(Error(`worker exit ${code}: ${diagnostic}`)));
  lines.on("line",line=>{
    const event=JSON.parse(line);
    if(event.event==="error") pending?.reject(Error(event.message));
    else if(event.event==="ready"||event.event==="results"&&event.snapshot.complete)pending?.resolve(event);
  });
  const wait=()=>new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>reject(Error("worker timed out")),30000);
    pending={
      resolve:v=>{clearTimeout(timeout);pending=null;resolve(v);},
      reject:e=>{clearTimeout(timeout);pending=null;reject(e);},
    };
  });
  try {
    const ready=await wait();startup.push(performance.now()-start);runtimes.push(ready.runtime);
    for(let i=0;i<manifest.cases.length;i++) {
      const q=manifest.cases[i],promise=wait(),t=performance.now();
      child.stdin.write(JSON.stringify({type:"search",id:i,query:q.query})+"\n");
      const event=await promise;
      if(event.id!==i)throw Error("stale worker response");
      queries.push({id:q.id,trial,wallMs:performance.now()-t,reportedMs:event.snapshot.elapsedMs});
    }
  }finally{child.stdin.end();await exited;lines.close();}
}
const stats=values=>{const sorted=[...values].sort((a,b)=>a-b);return {n:values.length,p50Ms:sorted[Math.ceil(sorted.length*.5)-1],p95Ms:sorted[Math.ceil(sorted.length*.95)-1]};};
const result={date:new Date().toISOString(),startup:stats(startup),query:stats(queries.map(q=>q.wallMs)),runtimes,queries,apiCalls:0};
await writeFile(path.join(directory,"worker.json"),JSON.stringify(result,null,2)+"\n",{mode:0o600});console.log(JSON.stringify({startup:result.startup,query:result.query,runtimes}));
