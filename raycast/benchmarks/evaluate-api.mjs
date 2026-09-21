#!/usr/bin/env node
// Opt-in real API benchmark. Sends selected local excerpts to TypeSafe.
import { readFile, writeFile, appendFile, mkdir, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { loadIndex } from "../src/local-index.mjs";
import { queryIndex, selectCandidates, termsFor } from "../src/ranking.mjs";
import { evaluate, excerpts, readKey } from "../src/engine.mjs";
import { assertUnusedRun, reserveRun } from "./api-run-state.mjs";

const args=process.argv.slice(2);
const get=(name,fallback)=>args.includes(name)?args[args.indexOf(name)+1]:fallback;
if(!args.includes("--live")&&!args.includes("--prepare"))throw Error("Use --prepare (offline) or --live (sends excerpts to TypeSafe)");
const base=path.resolve(get("--base","raycast/reports/local-evaluation"));
const out=path.resolve(get("--out",path.join(base,"api")));
await mkdir(out,{recursive:true,mode:0o700});
const manifestBytes=await readFile(path.join(base,"manifest.json"));
const manifest=JSON.parse(manifestBytes),index=await loadIndex(path.join(base,"index.json.gz"),manifest.root);
const key=args.includes("--prepare")?"":await readKey(path.resolve(get("--env-file",".env")));
if(!args.includes("--prepare")&&!key)throw Error("Missing TypeSafe credential");
await assertUnusedRun(out);
const modes=get("--budgets","20,80").split(",").map(Number);
if(modes.some(n=>!Number.isInteger(n)||n<1||n>80))throw Error("Budget must be 1..80");
const repeats=Number(get("--repeats","1"));
if(!Number.isInteger(repeats)||repeats<1||repeats>3)throw Error("Repeats must be 1..3");
const filter=get("--cases","").split(",").filter(Boolean);
const cases=filter.length?manifest.cases.filter(c=>filter.includes(c.id)):manifest.cases;
const settings={budgets:modes,batch:10,concurrency:2,excerptChars:1800,deadlineMs:15000,repeats,
  inputUsdPerMillion:.042,priceSource:"https://typesafe.ai/blog/introducing-system-one-models-and-jev",priceChecked:"2026-09-21"};
const rows=[],ledger=[],plans=[];
const write=async(name,value)=>writeFile(path.join(out,name),JSON.stringify(value,null,2)+"\n",{mode:0o600});
const rank=(c,results)=>{const i=results.findIndex(r=>c.expected.includes(r.relative));return i<0?null:i+1;};
// Freeze eligible inputs and check that the local documents still match the prior index.
const documents=new Map();
for(const c of cases){
  const ranked=queryIndex(index,c.query,{limit:index.docs.length});
  for(const budget of modes)for(const doc of selectCandidates(ranked,budget))documents.set(doc.relative,doc);
}
for(const doc of documents.values()){
  const current=await stat(path.join(index.root,doc.relative));
  if(current.size!==doc.size||current.mtimeMs!==doc.mtimeMs)throw Error(`Corpus changed: ${doc.relative}`);
}
// No raw secrets are printed or persisted by the credential checks.
const secretPattern=/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:sk-proj-|sk-live-|ghp_|github_pat_)[A-Za-z0-9_-]{20,}/;
const prepared=[];
for(const c of cases){
  const ranked=queryIndex(index,c.query,{limit:index.docs.length});
  for(const budget of modes){
    const files=[];
    for(const doc of selectCandidates(ranked,budget)){
      const excerpt=(await excerpts(index.root,doc.relative,termsFor(c.query),settings.excerptChars)).content;
      if(secretPattern.test(excerpt))throw Error(`Secret-shaped content in selected excerpt: ${doc.relative}`);
      files.push({relative:doc.relative,excerpt});
    }
    prepared.push({caseId:c.id,query:c.query,budget,files});
  }
}
await write("settings.json",{date:new Date().toISOString(),settings,manifestSha256:createHash("sha256").update(manifestBytes).digest("hex"),caseIds:cases.map(c=>c.id),documents:documents.size});
const plan={destination:"https://api.typesafe.ai/v1/systemone",model:"jev-latest",settings,prepared};
if(args.includes("--prepare"))await write("planned-excerpts.json",plan);
else {
  const reviewed=JSON.parse(await readFile(path.join(out,"planned-excerpts.json"),"utf8"));
  if(JSON.stringify(reviewed)!==JSON.stringify(plan))throw Error("Prepared payload changed; prepare and review the updated payload before sending");
}
if(args.includes("--prepare")){
  console.log(JSON.stringify({offline:true,cases:cases.length,documents:documents.size,requests:prepared.reduce((n,p)=>n+Math.ceil(p.files.length/settings.batch),0)*repeats,output:path.join(out,"planned-excerpts.json")}));
  process.exit(0);
}
const nativeFetch=globalThis.fetch;
await reserveRun(out);
let inputTokens=0,requests=0;
for(let repeat=0;repeat<repeats;repeat++)for(let ci=0;ci<cases.length;ci++){
  const c=cases[ci],order=(ci+repeat)%2?[...modes].reverse():modes;
  for(const budget of order){
    const start=performance.now(),cpu=process.cpuUsage(),signal=AbortSignal.timeout(settings.deadlineMs);
    const ranked=queryIndex(index,c.query,{limit:index.docs.length});
    const localMs=performance.now()-start,selected=selectCandidates(ranked,budget),scores=new Map(),events=[],errors=[];
    let offset=0,firstApiMs=null;
    const finalRank=()=>[...ranked].sort((a,b)=>(scores.get(b.relative)??-1)-(scores.get(a.relative)??-1)||b.priority-a.priority||a.relative.localeCompare(b.relative));
    const traceFetch=async(url,init)=>{
      if(++requests>1000||inputTokens>3000000)throw Error("Experiment spending bound reached");
      if(url!=="https://api.typesafe.ai/v1/systemone")throw Error("Unexpected API host");
      const requestStart=performance.now();
      const item={caseId:c.id,budget,repeat,request:requests,requestBytes:Buffer.byteLength(init.body),payloadSha256:createHash("sha256").update(init.body).digest("hex")};
      try{
        const response=await nativeFetch(url,init);item.http=response.status;
        if(response.ok){const body=await response.clone().json();item.model=body.model;item.usage=body.usage;inputTokens+=body.usage?.input_tokens??0;}
        return response;
      }catch(error){item.error=error.name;throw error;}
      finally{item.elapsedMs=performance.now()-requestStart;ledger.push(item);await appendFile(path.join(out,"requests.jsonl"),JSON.stringify(item)+"\n",{mode:0o600});}
    };
    await Promise.all(Array.from({length:settings.concurrency},async()=>{
      while(offset<selected.length&&!signal.aborted){
        const slice=selected.slice(offset,offset+=settings.batch);
        try{
          const batch=[];
          const frozen=prepared.find(p=>p.caseId===c.id&&p.budget===budget);
          for(const doc of slice){
            const current=await excerpts(index.root,doc.relative,termsFor(c.query),settings.excerptChars);
            const reviewed=frozen.files.find(f=>f.relative===doc.relative).excerpt;
            if(current.content!==reviewed)throw Error("Excerpt changed during run");
            batch.push({...doc,excerpt:reviewed});
          }
          plans.push({caseId:c.id,budget,repeat,files:batch.map(({relative,excerpt})=>({relative,excerpt}))});
          const result=await evaluate(c.query,batch,key,signal,traceFetch);
          batch.forEach((doc,i)=>scores.set(doc.relative,result.scores[i]));
          firstApiMs??=performance.now()-start;
          events.push({ms:performance.now()-start,rank:rank(c,finalRank()),evaluated:scores.size});
        }catch(error){errors.push({files:slice.map(d=>d.relative),error:error.name,message:/API HTTP \d+|API応答が不正/.test(error.message)?error.message:"API request failed"});}
      }
    }));
    const results=finalRank(),used=process.cpuUsage(cpu),e2eMs=performance.now()-start;
    const calls=ledger.filter(x=>x.caseId===c.id&&x.budget===budget&&x.repeat===repeat);
    const tokens=calls.reduce((sum,x)=>sum+(x.usage?.input_tokens??0),0);
    const row={id:c.id,category:c.category,query:c.query,expected:c.expected,budget,repeat,
      localRank:rank(c,ranked),rank:rank(c,results),localMs,e2eMs,firstApiMs,cpuMs:(used.user+used.system)/1000,
      admitted:selected.some(d=>c.expected.includes(d.relative)),selected:selected.length,evaluated:scores.size,
      requests:calls.length,inputTokens:tokens,estimatedUsd:tokens/1e6*settings.inputUsdPerMillion,
      missingUsage:calls.filter(x=>!Number.isInteger(x.usage?.input_tokens)).length,timedOut:signal.aborted,errors,events,
      results:results.slice(0,100).map(d=>({relative:d.relative,localScore:d.priority,apiScore:scores.get(d.relative)??null}))};
    rows.push(row);
    await appendFile(path.join(out,"results.jsonl"),JSON.stringify(row)+"\n",{mode:0o600});
    await write("results.json",{settings,rows,ledger});
    await write("sent-excerpts.json",plans);
    console.log(JSON.stringify({id:c.id,budget,repeat,local:row.localRank,rank:row.rank,ms:Math.round(e2eMs),tokens,evaluated:scores.size,errors:errors.length}));
    if(calls.some(x=>[401,402,403].includes(x.http)))throw Error("Credential/billing failure; stopped remaining requests");
  }
}
