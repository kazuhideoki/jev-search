import { createInterface } from "node:readline";
import { prepareLocalIndex, searchLocalIndex } from "./local-service.mjs";
import { loadIndex } from "./local-index.mjs";
import { excerpts, termsFor } from "./engine.mjs";

// NDJSON over private stdio, with no HTTP listener or cloud configuration.
globalThis.fetch = () => { throw Error("外部APIは使用できません"); };
const [root, cachePath, rgPath] = process.argv.slice(2);
let index, rebuilding = false, stopped = false, latestQuery, buildController, queryController;
const jobs = new Set();
const send = (event) => { if (!stopped) process.stdout.write(JSON.stringify(event) + "\n"); };
const track = (job) => { jobs.add(job); job.finally(() => jobs.delete(job)).catch(() => {}); };

async function rebuild(force = false) {
  if (rebuilding) return;
  rebuilding = true;
  // Rebuilding must not hold two full corpora in memory. The old cache stays on disk.
  if (force) { queryController?.abort(); index = undefined; }
  buildController = new AbortController();
  try {
    index = await prepareLocalIndex({ root, cachePath, rgPath, force, signal: buildController.signal,
      onProgress: (progress) => send({ event: "progress", progress }) });
    send({ event: "ready", metadata: { count: index.docs.length, builtAt: index.builtAt, stats: index.stats },
      runtime: { node: process.version, heapMB: Math.round(process.memoryUsage().heapUsed / 1048576) } });
    if (latestQuery) track(runQuery(latestQuery));
  } catch (error) {
    if (!buildController.signal.aborted) {
      if (force) {
        try { index = await loadIndex(cachePath, root); } catch { /* no previous cache */ }
      }
      send({ event: "error", operation: "index", message: error.message });
      if (index && latestQuery) track(runQuery(latestQuery));
    }
  } finally { rebuilding = false; }
}
async function runQuery(request) {
  queryController?.abort();
  const controller = new AbortController();
  queryController = controller;
  if (!index) return;
  try {
    await searchLocalIndex(index, request.query, { signal: controller.signal, onUpdate: (snapshot) => {
      if (controller.signal.aborted) return;
      send({ event: "results", id: request.id, snapshot: { elapsedMs: snapshot.elapsedMs, complete: snapshot.complete, errors: snapshot.errors,
        results: snapshot.results.map(({ path, relative, title, matched, truncated }) => ({ path, relative, title, matched, truncated })) } });
    } });
  } catch (error) {
    if (!controller.signal.aborted) send({ event: "error", operation: "search", id: request.id, message: error.message });
  }
}
async function preview(request) {
  if (!index || !index.docs.some((doc) => doc.relative === request.relative)) return;
  try {
    const value = await excerpts(index.root, request.relative, termsFor(request.query), 3000);
    send({ event: "preview", id: request.id, relative: request.relative, text: value.content });
  } catch {
    send({ event: "preview", id: request.id, relative: request.relative, text: "ファイルを読み込めません。移動・削除した場合は索引を更新してください。" });
  }
}
function stop() {
  if (stopped) return;
  stopped = true;
  buildController?.abort(); queryController?.abort();
  Promise.allSettled([...jobs]).then(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
process.stdout.on("error", stop);
const lines = createInterface({ input: process.stdin });
lines.on("close", stop);
lines.on("line", (line) => {
  if (stopped || line.length > 16000) return;
  let request;
  try { request = JSON.parse(line); } catch { return; }
  if (request.type === "stop") stop();
  else if (request.type === "rebuild") track(rebuild(true));
  else if (request.type === "cancel") { latestQuery = null; queryController?.abort(); }
  else if (request.type === "search" && typeof request.query === "string" && request.query.length <= 1000) {
    latestQuery = request; track(runQuery(request));
  } else if (request.type === "preview" && typeof request.relative === "string" && typeof request.query === "string") track(preview(request));
});
track(rebuild());
