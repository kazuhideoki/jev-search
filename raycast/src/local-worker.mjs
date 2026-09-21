import { realpath } from "node:fs/promises";
import path from "node:path";
import { createProgressiveSearch } from "./progressive-search.mjs";
import { createInterface } from "node:readline";
import { prepareLocalIndex } from "./local-service.mjs";
import { loadIndex } from "./local-index.mjs";
import { excerpts, termsFor, readKey } from "./engine.mjs";
import { abortable } from "./abortable.mjs";

// Credentials travel only through private stdio; only explicit refine requests use them.
let credentials = {}, session, refining = null;
const [root, cachePath, rgPath] = process.argv.slice(2);
let index, rebuilding = false, stopped = false, latestQuery, buildController, queryController;
const jobs = new Set();
const send = (event) => { if (!stopped) process.stdout.write(JSON.stringify(event) + "\n"); };
const track = (job) => { jobs.add(job); job.finally(() => jobs.delete(job)).catch(() => {}); };
const ready = () => send({ event: "ready", metadata: { count: index.docs.length, builtAt: index.builtAt, stats: index.stats },
  runtime: { node: process.version, heapMB: Math.round(process.memoryUsage().heapUsed / 1048576) } });

async function rebuild(force = false) {
  if (rebuilding) return;
  rebuilding = true;
  // Rebuilding must not hold two full corpora in memory. The old cache stays on disk.
  if (force) { queryController?.abort(); session = undefined; index = undefined; }
  buildController = new AbortController();
  const controller = buildController;
  const timer = setTimeout(() => controller.abort(Error("索引の読み込み・再作成が60秒で完了しませんでした。Jev評価は⌘⇧Rです。")), 60000);
  try {
    index = await abortable(controller.signal, () => prepareLocalIndex({ root, cachePath, rgPath, force, signal: controller.signal,
      onProgress: (progress) => { if (!controller.signal.aborted) send({ event: "progress", progress }); } }));
    ready();
    if (latestQuery) track(runQuery(latestQuery));
  } catch (error) {
    if (!stopped) {
      if (force) {
        try { index = await abortable(AbortSignal.timeout(5000), () => loadIndex(cachePath, root)); } catch { /* no previous cache */ }
      }
      if (index) ready();
      send({ event: "error", operation: "index", message: error.message });
      if (index && latestQuery) track(runQuery(latestQuery));
    }
  } finally { clearTimeout(timer); rebuilding = false; }
}
async function runQuery(request) {
  queryController?.abort();
  queryController = new AbortController();
  session = undefined;
  if (!index) return;
  try {
    session = createProgressiveSearch(index, request.query);
    send({ event: "results", id: request.id, snapshot: session.snapshot() });
  } catch (error) {
    send({ event: "error", operation: "search", id: request.id, message: error.message });
  }
}
async function refine(request) {
  if (!session || rebuilding || refining === session || request.query !== latestQuery?.query) {
    send({ event: "error", operation: "refine", id: request.id, message: "検索の準備中です。ローカル結果の表示後に再試行してください。" });
    return;
  }
  const currentSession = session, controller = queryController;
  refining = currentSession;
  try {
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]);
    const envFile = credentials.envFile ? await abortable(signal, () => realpath(credentials.envFile)).catch(error => {
      if (credentials.apiKey && ["ENOENT", "ENOTDIR"].includes(error.code)) return path.resolve(credentials.envFile);
      throw error;
    }) : undefined;
    const key = credentials.apiKey || (envFile ? await abortable(signal, () => readKey(envFile)) : "");
    const result = await currentSession.refine({ key, envFile, signal,
      onProgress: progress => {
        if (!controller.signal.aborted && session === currentSession) send({ event: "refining", id: request.id, ...progress });
      } });
    if (result && !controller.signal.aborted && session === currentSession) send({ event: "results", id: request.id, snapshot: result });
  } catch (error) {
    if (!controller.signal.aborted && session === currentSession) send({ event: "error", operation: "refine", id: request.id, message: error.message });
  } finally { if (refining === currentSession) refining = null; }
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
  else if (request.type === "configure") { credentials = { apiKey: typeof request.apiKey === "string" ? request.apiKey : "", envFile: typeof request.envFile === "string" ? request.envFile : "" }; }
  else if (request.type === "refine") track(refine(request));
  else if (request.type === "cancel") { latestQuery = null; session = undefined; queryController?.abort(); }
  else if (request.type === "search" && typeof request.query === "string" && request.query.length <= 1000) {
    latestQuery = request; track(runQuery(request));
  } else if (request.type === "preview" && typeof request.relative === "string" && typeof request.query === "string") track(preview(request));
});
track(rebuild());
