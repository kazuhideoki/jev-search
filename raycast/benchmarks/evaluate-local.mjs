#!/usr/bin/env node
// Reproducible, offline diagnostics. Private manifests and reports belong in reports/.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, mkdtemp, rm, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createIndex, addDocument, queryIndex, tokenize } from "../src/ranking.mjs";
import { buildIndex, saveIndex, loadIndex, MAX_BYTES } from "../src/local-index.mjs";
import { allowed } from "../src/engine.mjs";
import { searchLocalIndex } from "../src/local-service.mjs";
import { queryExperimental, VARIANTS } from "./experimental-ranking.mjs";
import { diagnosticCases } from "./diagnostic-cases.mjs";

globalThis.fetch = () => { throw Error("Benchmark is offline"); };
const args = process.argv.slice(2);
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const out = path.resolve(option("--out", "raycast/reports/local-evaluation"));
await mkdir(out, { recursive: true, mode: 0o700 });
const variants = { baseline: (index, query) => queryIndex(index, query, { limit: 100 }),
  ...Object.fromEntries(Object.entries(VARIANTS).map(([name, options]) => [name, (index, query) => queryExperimental(index, query, options)])) };
const ms = (value) => Math.round(value * 1000) / 1000;
const percentile = (values, p) => [...values].sort((a,b) => a-b)[Math.max(0, Math.ceil(values.length * p) - 1)];
const timing = (values) => ({ n: values.length, p50Ms: ms(percentile(values, .5)), p95Ms: ms(percentile(values, .95)), maxMs: ms(Math.max(...values)) });
const meta = { date: new Date().toISOString(), node: process.version, platform: process.platform, arch: process.arch,
  cpu: os.cpus()[0].model, productionCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), apiCalls: 0, apiTokens: 0, apiCost: 0 };
const write = async (name, value) => writeFile(path.join(out, name), JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
function record(c, rows, index) {
  const hashes = new Set(index.docs.filter(d => c.expected.includes(d.relative) && d.hash).map(d => d.hash));
  const position = rows.findIndex(d => c.expected.includes(d.relative) || (d.hash && hashes.has(d.hash)));
  return { id: c.id, category: c.category, query: c.query, expected: c.expected,
    indexed: c.expected.some(f => index.docs.some(d => d.relative === f)),
    rank: position < 0 ? null : position + 1, hit1: position === 0, hit5: position >= 0 && position < 5,
    hit100: position >= 0, reciprocalRank100: position < 0 ? 0 : 1/(position+1),
    returned: rows.length, top5: rows.slice(0,5).map(d => ({ relative: d.relative, score: d.priority, matched: d.matched })) };
}
function summarize(rows) {
  const positive = rows.filter(r => r.expected.length), negative = rows.filter(r => !r.expected.length);
  return { queries: rows.length, positives: positive.length, indexed: positive.filter(r=>r.indexed).length,
    hit1: positive.filter(r=>r.hit1).length, hit5: positive.filter(r=>r.hit5).length, hit100: positive.filter(r=>r.hit100).length,
    mrr100: positive.reduce((a,r)=>a+r.reciprocalRank100,0)/Math.max(1,positive.length),
    absentQueries: negative.length, absentWithResults: negative.filter(r=>r.returned).length };
}

if (!args.includes("--scale-only")) {
  const diagnostic = {};
  for (const [name, run] of Object.entries(variants)) {
    diagnostic[name] = diagnosticCases().map(c => {
      const index = createIndex("/fixture");
      for (const doc of c.docs) {
        const bytes = Buffer.from(doc.text), truncated = bytes.length > MAX_BYTES;
        const text = new TextDecoder().decode(bytes.subarray(0, MAX_BYTES));
        addDocument(index, doc.relative, text, { truncated, hash: truncated ? null : createHash("sha256").update(text).digest("hex") });
      }
      const rows = run(index,c.query);
      if (name === "lean") assert.deepEqual(rows, variants.baseline(index,c.query));
      return record(c,rows,index);
    });
  }
  await write("diagnostics.json", { meta, summary: Object.fromEntries(Object.entries(diagnostic).map(([name,rows])=>[name,summarize(rows)])), rows: diagnostic,
    tokenProbes: ["C++", "C#", "C", "v1.5.17", "v1.17.5", "書き直した文章", "retries connections"].map(text=>({text,tokens:tokenize(text)})) });
  console.log("diagnostics", JSON.stringify(Object.fromEntries(Object.entries(diagnostic).map(([name,rows])=>[name,summarize(rows)]))));

  const manifestPath = option("--manifest");
  if (manifestPath) {
    const manifest = JSON.parse(await readFile(manifestPath,"utf8"));
    const root = await realpath(manifest.root), files = [], repositories = [];
    for (const repo of manifest.repositories) {
      const directory = path.join(root,repo);
      const tracked = execFileSync("git", ["-C",directory,"ls-files","--cached","-z"], {maxBuffer:32*1024*1024,encoding:"utf8"}).split("\0").filter(Boolean);
      files.push(...tracked.map(f=>path.join(repo,f)).filter(f=>allowed(f) && !/\/(?:runs|samples)\//.test(f)));
      repositories.push({repo,head:execFileSync("git",["-C",directory,"rev-parse","HEAD"],{encoding:"utf8"}).trim()});
    }
    const start = performance.now(), cpuStart = process.cpuUsage();
    const index = await buildIndex(root,{ files:[...new Set(files)], onProgress: p=>{ if(p.processed%2000===0) console.log("indexed",p.processed,p.total); } });
    const buildMs = performance.now()-start, buildCpu = process.cpuUsage(cpuStart);
    const cache = path.join(out,"index.json.gz"), saving = performance.now();
    await saveIndex(cache,index);
    const saveMs = performance.now()-saving;
    const loadTimes=[];
    for(let i=0;i<3;i++){ const t=performance.now(); let loaded=await loadIndex(cache,root); assert.equal(loaded.docs.length,index.docs.length); loadTimes.push(performance.now()-t); loaded=null; global.gc?.(); }
    const rows={}, samples=Object.fromEntries(Object.keys(variants).map(k=>[k,[]]));
    for (const [name,run] of Object.entries(variants)) {
      rows[name]=manifest.cases.map(c=>{
        const ranked=run(index,c.query);
        if(name==="lean") assert.deepEqual(ranked,variants.baseline(index,c.query));
        return record(c,ranked,index);
      });
    }
    // Warm all variants, then rotate their order to reduce order/JIT bias.
    for(const run of Object.values(variants)) for(const c of manifest.cases) run(index,c.query);
    const names=Object.keys(variants);
    for(let round=0;round<7;round++) for(const c of manifest.cases) for(let n=0;n<names.length;n++) {
      const name=names[(n+round)%names.length], t=performance.now(); variants[name](index,c.query); samples[name].push(performance.now()-t);
    }
    const service=[];
    for(let round=0;round<3;round++) for(const c of manifest.cases){
      let snapshot; const t=performance.now();
      await searchLocalIndex(index,c.query,{signal:new AbortController().signal,onUpdate:s=>snapshot=s});
      service.push({query:c.query,wallMs:performance.now()-t,reportedMs:snapshot.elapsedMs});
      assert.deepEqual(snapshot.results.map(r=>r.relative),variants.baseline(index,c.query).map(r=>r.relative));
    }
    await write("real-corpus.json", { meta, repositories, manifestSha256:createHash("sha256").update(await readFile(manifestPath)).digest("hex"),
      corpusSha256:createHash("sha256").update(JSON.stringify(index.docs.map(d=>[d.relative,d.hash,d.size,d.mtimeMs]))).digest("hex"),
      indexStats:index.stats, buildMs:ms(buildMs), buildCpuMs:ms((buildCpu.user+buildCpu.system)/1000),saveMs:ms(saveMs),loadTiming:timing(loadTimes),gzipBytes:(await stat(cache)).size,
      memory:process.memoryUsage(), summary:Object.fromEntries(Object.entries(rows).map(([name,r])=>[name,{...summarize(r),timing:timing(samples[name])}])),rows,
      service:{wall:timing(service.map(s=>s.wallMs)),reported:timing(service.map(s=>s.reportedMs)),samples:service} });
    console.log("real",JSON.stringify({stats:index.stats,buildMs:ms(buildMs),summary:Object.fromEntries(Object.entries(rows).map(([name,r])=>[name,{...summarize(r),timing:timing(samples[name])}]))}));
  }
}

if (args.includes("--scale-only")) {
  const count = Number(option("--count","10000")), root=await realpath(await mkdtemp(path.join(os.tmpdir(),"jev-scale-")));
  try {
    const index=createIndex(root),t=performance.now();
    for(let i=0;i<count;i++) addDocument(index,`src/project-${i%31}/document-${i}.md`,
      `# Document ${i}\nsearch configuration keyboard music connection documentation common content\n` + `group${i%31} sample data text explanation `.repeat(4),{hash:`unique-${i}`});
    index.stats={scopeErrors:[]};
    const buildMs=performance.now()-t;
    const queries=["search configuration","keyboard music","group7","missingqzxv"];
    for(const q of queries) assert.deepEqual(queryExperimental(index,q),queryIndex(index,q,{limit:100}));
    const measurements=[];
    const methods={baseline:async q=>queryIndex(index,q,{limit:100}),lean:async q=>queryExperimental(index,q),
      localService:async q=>{let s;await searchLocalIndex(index,q,{signal:new AbortController().signal,onUpdate:value=>s=value});return s;}};
    for(const run of Object.values(methods)) for(const q of queries) await run(q);
    const names=Object.keys(methods),memoryBefore=process.memoryUsage();
    for(let round=0;round<30;round++) for(const q of queries) for(let n=0;n<names.length;n++) {
      const name=names[(n+round)%names.length],cpu=process.cpuUsage(),start=performance.now();
      const result=await methods[name](q),wall=performance.now()-start,used=process.cpuUsage(cpu);
      measurements.push({method:name,query:q,wallMs:wall,cpuMs:(used.user+used.system)/1000,reportedMs:result.elapsedMs});
    }
    const cache=path.join(root,"index.gz"),s=performance.now();await saveIndex(cache,index);const saveMs=performance.now()-s;
    const loadTimes=[];
    for(let i=0;i<3;i++){const t=performance.now();let loaded=await loadIndex(cache,root);loadTimes.push(performance.now()-t);assert.equal(loaded.docs.length,count);loaded=null;global.gc?.();}
    const result={meta,count,buildMs:ms(buildMs),saveMs:ms(saveMs),loadTiming:timing(loadTimes),gzipBytes:(await stat(cache)).size,
      memoryBefore,memoryAfter:process.memoryUsage(),maxRssBytes:process.resourceUsage().maxRSS*1024,
      summary:Object.fromEntries(names.map(name=>[name,Object.fromEntries(queries.map(q=>[q,timing(measurements.filter(m=>m.method===name&&m.query===q).map(m=>m.wallMs))]))])),measurements};
    await write(`scale-${count}.json`,result);console.log("scale",JSON.stringify({count,buildMs:result.buildMs,summary:result.summary}));
  }finally{await rm(root,{recursive:true,force:true});}
}
