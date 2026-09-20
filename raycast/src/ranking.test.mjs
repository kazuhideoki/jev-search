import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, symlink, rm, realpath } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { tokenize, termsFor, createIndex, addDocument, queryIndex, selectCandidates } from "./ranking.mjs";
import { buildIndex, saveIndex, loadIndex, MAX_BYTES } from "./local-index.mjs";
import { search, excerpts } from "./engine.mjs";

async function fixture(fn) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "jev-ranking-")));
  try { await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
}
test("English boundaries and identifiers preserve AI but reject wait and domains; 表 survives", () => {
  assert(!tokenize("wait domains containers").includes("ai"));
  assert(tokenize("AIClient ai_client AI").includes("ai"));
  assert(termsFor("キーボードで表をいじるやつ").includes("表"));
  assert(!termsFor("どう使うんだっけ").includes("っけ"));
});
test("multiple body and heading concepts outrank a single filename match", () => {
  const index = createIndex("/fixture");
  addDocument(index, "cache/search.d.ts", "search interface");
  addDocument(index, "notes/measurement.md", "# Search latency comparison\nWe compare search latency using repeatable measurements.");
  for (let i = 0; i < 20; i++) addDocument(index, `other/${i}.txt`, "unrelated background");
  assert.equal(queryIndex(index, "search latency comparison")[0].relative, "notes/measurement.md");
  assert.equal(queryIndex(index, "不存在qzxv").length, 0);
});
test("Japanese and English queries retain year, number and identifier evidence", () => {
  const index = createIndex("/fixture");
  for (const year of [2024, 2025]) addDocument(index, `Downloads/${year}.md`, `# 出張精算 Travel expenses ${year}\n${year}年の出張精算 Travel expenses from ${year}`);
  for (const year of [2024, 2025]) for (const query of [`${year}年の出張精算`, `travel expenses from ${year}`, String(year)]) {
    assert.equal(queryIndex(index, query)[0].relative, `Downloads/${year}.md`);
  }
  assert.deepEqual(tokenize("Issue 2261 EC25 v1.5.17 第1版"), ["issue", "2261", "ec25", "v1", "5", "17", "第", "1", "版"]);
});
test("repetition saturates and duplicate content occupies one result", () => {
  const index = createIndex("/fixture");
  addDocument(index, "a.md", "# antenna calibration\nantenna calibration procedure", { hash: "same" });
  addDocument(index, "copy/a.md", "# antenna calibration\nantenna calibration procedure", { hash: "same" });
  addDocument(index, "noise.txt", "antenna ".repeat(2000));
  const results = queryIndex(index, "antenna calibration");
  assert.equal(results.filter((x) => x.hash === "same").length, 1);
  assert.equal(results[0].hash, "same");
});
test("evaluation admission preserves top forty and still explores other packages", () => {
  const rows = Array.from({ length: 300 }, (_, i) => ({ relative: `${i}.md`, group: i < 200 ? "sdk" : `other-${i}`, hash: `hash-${i}` }));
  const selected = selectCandidates(rows, 80);
  assert.equal(selected.length, 80);
  assert(rows.slice(0, 40).every((row) => selected.includes(row)));
  assert(selected.filter((row) => row.group !== "sdk").length >= 20);
  assert.equal(new Set(selected.map((row) => row.relative)).size, 80);
});
test("index building respects scope, excludes symlinks/binary and records truncation", () => fixture(async (root) => {
  await writeFile(path.join(root, "a.md"), "# calibration\nantenna procedure");
  await writeFile(path.join(root, "outside.md"), "calibration");
  await writeFile(path.join(root, "binary.txt"), Buffer.from([0, 1, 2]));
  await writeFile(path.join(root, "large.txt"), "a".repeat(MAX_BYTES + 20));
  await symlink(path.join(root, "a.md"), path.join(root, "link.md"));
  const index = await buildIndex(root, { files: ["a.md", "binary.txt", "large.txt", "link.md", ".env"] });
  assert.equal(index.docs.length, 2);
  assert.equal(index.stats.skipped, 2);
  assert.equal(index.docs.find((x) => x.relative === "large.txt").hash, null);
  const filename = path.join(root, "cache/index.gz");
  await saveIndex(filename, index);
  const copy = await loadIndex(filename, root);
  assert.equal(queryIndex(copy, "calibration")[0].relative, "a.md");
  assert.doesNotThrow(() => queryIndex(copy, "constructor prototype"));
  await assert.rejects(loadIndex(filename, path.dirname(root)), /索引/);
}));
test("indexed engine uses shared ranking, excludes credentials and sends only the admitted budget", () => fixture(async (root) => {
  const files = [];
  for (let i = 0; i < 12; i++) { const f = `${i}.md`; files.push(f); await writeFile(path.join(root, f), `# antenna calibration\nprocedure ${i}`); }
  await writeFile(path.join(root, "settings.txt"), "TYPESAFE_API_KEY=fixture-only\nantenna");
  files.push("settings.txt");
  const index = await buildIndex(root, { files });
  let last; const sent = [];
  await search({ root, index, query: "antenna calibration", envFile: path.join(root, "settings.txt"), signal: new AbortController().signal, limits: { evaluate: 6, deepen: 0 }, onUpdate: (s) => last = s,
    evaluator: async (_q, batch) => { sent.push(...batch.map((x) => x.relative)); return { scores: batch.map(() => 0.8), tokens: 0, model: "stub" }; } });
  assert.equal(sent.length, 6);
  assert(!sent.includes("settings.txt"));
  assert.equal(last.total, 12);
  assert.equal(last.evaluated, 6);
  await assert.rejects(search({ root: path.dirname(root), index, query: "antenna", signal: new AbortController().signal, onUpdate: () => {} }), /異なります/);
}));
test("indexed engine applies an additional scope before evaluation", () => fixture(async (root) => {
  await writeFile(path.join(root, "keep.md"), "antenna");
  await writeFile(path.join(root, "drop.md"), "antenna calibration");
  const index = await buildIndex(root, { files: ["keep.md", "drop.md"] });
  let last;
  await search({ root, index, query: "antenna", scope: { files: new Set(["keep.md"]), roots: [root] }, signal: new AbortController().signal, onUpdate: (s) => last = s, evaluator: () => assert.fail("network") });
  assert.deepEqual(last.results.map((x) => x.relative), ["keep.md"]);
}));
test("indexed local results preserve the partial-body flag", () => fixture(async (root) => {
  await writeFile(path.join(root, "large.txt"), "antenna calibration\n" + "background ".repeat(MAX_BYTES / 5));
  const index = await buildIndex(root, { files: ["large.txt"] });
  assert.equal(index.docs[0].truncated, true);
  let last;
  await search({ root, index, query: "antenna calibration", signal: new AbortController().signal, onUpdate: (snapshot) => last = snapshot });
  assert.equal(last.results[0].truncated, true);
}));
test("excerpt prioritizes a late section with multiple concepts over early one-word matches", () => fixture(async (root) => {
  await writeFile(path.join(root, "notes.md"), "# Manual\n" + "antenna background\n".repeat(200) + "\n## Calibration procedure\nantenna calibration measurement\nuse the reference load");
  const result = await excerpts(root, "notes.md", ["antenna", "calibration", "measurement"], 1800);
  assert.match(result.content, /reference load/);
  const lineNumbers = [...result.content.matchAll(/^L(\d+):/gm)].map((m) => Number(m[1]));
  assert.deepEqual(lineNumbers, [...lineNumbers].sort((a, b) => a - b));
}));
