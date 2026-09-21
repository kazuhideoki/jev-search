#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { stdin, stdout, stderr } from "node:process";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { realpath, lstat } from "node:fs/promises";
import path from "node:path";
import { buildIndex, loadIndex, saveIndex } from "./src/local-index.mjs";
import { queryIndex, termsFor, selectCandidates } from "./src/ranking.mjs";
import { excerpts } from "./src/engine.mjs";

// This entrypoint is deliberately local-only, including when TYPESAFE_API_KEY is set.
globalThis.fetch = () => { throw Error("このCLIは外部APIを使用しません"); };
const clean = (s) => String(s).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
const args = process.argv.slice(2);
const options = { root: homedir(), personal: true, rebuild: false, json: false, limit: 8, buildOnly: false };
const queryParts = [];
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--help" || arg === "-h") {
    console.log(`使い方: ./search-local [検索文] [--root DIR] [--rebuild] [--json] [--limit N]\n引数なし: 対話検索。既定範囲: srcのGit追跡ファイル / Downloads / マイドライブ / iCloud\n--root DIR: そのディレクトリだけを検索\n--rebuild: 索引を現在のファイルから作り直す\n--build-only: 索引を準備して終了\n--json: パス・一致語・候補80件への採用をJSONで出力\n外部APIは使いません。索引はこの作業ディレクトリの .jev-cache に保存します。`);
    process.exit(0);
  } else if (arg === "--root") { options.root = args[++i]; options.personal = false; if (!options.root) throw Error("--root のパスが必要です"); }
  else if (arg === "--rebuild") options.rebuild = true;
  else if (arg === "--json") options.json = true;
  else if (arg === "--build-only") options.buildOnly = true;
  else if (arg === "--limit") { options.limit = Number(args[++i]); if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100) throw Error("--limit は1〜100です"); }
  else if (arg.startsWith("--")) throw Error(`不明なオプション: ${arg}`);
  else queryParts.push(arg);
}
const controller = new AbortController();
process.once("SIGINT", () => controller.abort());
const started = performance.now();
const root = await realpath(options.root);
const cacheId = createHash("sha256").update(root + ":" + options.personal).digest("hex").slice(0, 16);
const cache = fileURLToPath(new URL(`../.jev-cache/${cacheId}.json.gz`, import.meta.url));
let index;
try {
  if (!options.rebuild) {
    try { index = await loadIndex(cache, root); }
    catch (error) { if (!["ENOENT", "INDEX_OUTDATED"].includes(error.code)) throw error; }
  }
  if (!index) {
    stderr.write("ローカル索引を準備しています…\n");
    let last = 0;
    index = await buildIndex(root, { personal: options.personal, signal: controller.signal, onProgress: (p) => {
      if (p.phase === "index" && (performance.now() - last > 1000 || p.processed === p.total)) {
        stderr.write(`  ${p.processed.toLocaleString()} / ${p.total.toLocaleString()}件\n`); last = performance.now();
      }
    } });
    await saveIndex(cache, index, { signal: controller.signal });
  }
  stderr.write(`${index.docs.length.toLocaleString()}件の索引 · ${new Date(index.builtAt).toLocaleString("ja-JP")}作成 · 準備 ${Math.round(performance.now() - started)}ms\n`);
  if (index.stats.skipped || index.stats.scopeErrors.length) stderr.write(`読込除外 ${index.stats.skipped}件 / 列挙エラー ${index.stats.scopeErrors.length}件。PDF・Office抽出は未対応です。\n`);
  if (options.buildOnly) process.exit(0);

  let lastResults = [], lastQuery = "";
  async function execute(query) {
    const start = performance.now();
    const ranked = queryIndex(index, query);
    const admitted = new Set(selectCandidates(ranked, 80).map((x) => x.relative));
    const rankMs = performance.now() - start;
    const results = [];
    for (const item of ranked) {
      if (results.length >= options.limit) break;
      // Reject deleted/symlinked entries; flag edited files until explicit rebuild.
      try {
        const full = path.join(root, item.relative);
        if (await realpath(full) !== full || !(await lstat(full)).isFile()) continue;
        const stat = await lstat(full);
        results.push({ ...item, path: full, stale: stat.size !== item.size || stat.mtimeMs !== item.mtimeMs, admitted: admitted.has(item.relative) });
      } catch { /* stale deleted entry */ }
    }
    lastResults = results; lastQuery = query;
    if (options.json) {
      console.log(JSON.stringify({ query, root, builtAt: index.builtAt, localOnly: true, indexed: index.docs.length, rankMs, results }, null, 2));
      return;
    }
    console.log(`\n「${clean(query)}」\n順位計算 ${rankMs.toFixed(1)}ms · ${results.length}件表示`);
    for (const [i, item] of results.entries()) {
      console.log(`\n${i + 1}. ${clean(item.title)}${item.stale ? " [更新あり: --rebuild推奨]" : ""}\n   ${clean(item.relative)}\n   一致: ${clean(item.matched.join("・"))}`);
    }
    if (!results.length) console.log("一致する文書がありません。別の言葉を加えるか --rebuild で索引を更新してください。");
    else if (!queryParts.length) console.log("\np 1: 本文を確認 / o 1: 開く / f 1: Finderで表示");
  }
  if (queryParts.length) await execute(queryParts.join(" "));
  else {
    if (!stdin.isTTY) throw Error("検索文を引数に指定してください。対話検索はターミナルから起動できます。");
    console.log("\nJev Search — ローカル自然言語検索\n文章を入力してEnter。:qで終了。\n索引更新: 終了後 ./search-local --rebuild\n");
    const rl = createInterface({ input: stdin, output: stdout });
    try {
      while (!controller.signal.aborted) {
        const input = (await rl.question("\n検索 > ", { signal: controller.signal })).trim();
        if (input === ":q" || input === "exit") break;
        if (!input) continue;
        const action = input.match(/^([pof])\s+(\d+)$/);
        try {
          if (action) {
            const item = lastResults[Number(action[2]) - 1];
            if (!item) { console.log("表示された番号を指定してください。"); continue; }
            if (await realpath(item.path) !== item.path) throw Error("ファイルの場所が変わりました");
            if (action[1] === "p") console.log("\n" + clean((await excerpts(root, item.relative, termsFor(lastQuery), 2400)).content));
            else await new Promise((resolve, reject) => {
              const child = spawn("/usr/bin/open", action[1] === "f" ? ["-R", item.path] : [item.path], { stdio: "ignore" });
              child.on("error", reject); child.on("close", (code) => code ? reject(Error("ファイルを開けませんでした")) : resolve());
            });
          } else await execute(input);
        } catch (error) { console.log(clean(error.message)); }
      }
    } finally { rl.close(); }
  }
} catch (error) {
  stderr.write(controller.signal.aborted ? "中断しました。\n" : clean(error.message) + "\n");
  process.exitCode = controller.signal.aborted ? 130 : 1;
}
