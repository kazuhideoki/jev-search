#!/usr/bin/env node
// Exploratory max-chunk scoring; same 64 KiB coverage as the production index.
import { readFile, writeFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { createIndex, addDocument, queryIndex } from "../src/ranking.mjs";
import { loadIndex, saveIndex, MAX_BYTES } from "../src/local-index.mjs";
import { readText } from "../src/engine.mjs";
const [directory, manifestPath] = process.argv.slice(2);
const manifest=JSON.parse(await readFile(manifestPath,"utf8"));
const original=await loadIndex(path.join(directory,"index.json.gz"),manifest.root);
const summary=[],results={};
for(const size of [2048,8192]) {
  const start=performance.now(),index=createIndex(original.root);
  for(const doc of original.docs) {
    const {text}=await readText(original.root,doc.relative,MAX_BYTES);
    for(let pos=0;pos<text.length;pos+=size-256){
      const part=text.slice(pos,pos+size);
      // No parent-title injection: test the effect of chunking on its own.
      addDocument(index,doc.relative,part,{parent:doc.relative,offset:pos,hash:null});
    }
  }
  const buildMs=performance.now()-start,cache=path.join(directory,`chunks-${size}.gz`);
  await saveIndex(cache,index);
  const search=query=>{
    const ranked=queryIndex(index,query,{limit:index.docs.length}),seen=new Set();
    return ranked.filter(row=>{if(seen.has(row.parent))return false;seen.add(row.parent);return true;}).slice(0,100);
  };
  results[size]=manifest.cases.map(c=>{
    const rows=search(c.query),rank=rows.findIndex(r=>c.expected.includes(r.parent));
    return {id:c.id,query:c.query,rank:rank<0?null:rank+1,top5:rows.slice(0,5).map(r=>({relative:r.parent,offset:r.offset,matched:r.matched}))};
  });
  for(const c of manifest.cases) search(c.query);
  const elapsed=[];
  for(let repeat=0;repeat<7;repeat++)for(const c of manifest.cases){const start=performance.now();search(c.query);elapsed.push(performance.now()-start);}
  elapsed.sort((a,b)=>a-b);
  summary.push({size,documents:original.docs.length,chunks:index.docs.length,buildMs,gzipBytes:(await stat(cache)).size,
    hit1:results[size].filter(r=>r.rank===1).length,hit5:results[size].filter(r=>r.rank&&r.rank<=5).length,hit100:results[size].filter(r=>r.rank).length,
    p50Ms:elapsed[Math.ceil(elapsed.length*.5)-1],p95Ms:elapsed[Math.ceil(elapsed.length*.95)-1]});
}
const output={date:new Date().toISOString(),manifestSha256:createHash("sha256").update(await readFile(manifestPath)).digest("hex"),summary,results,apiCalls:0};
await writeFile(path.join(directory,"chunks.json"),JSON.stringify(output,null,2)+"\n",{mode:0o600});
console.log(JSON.stringify(summary));
