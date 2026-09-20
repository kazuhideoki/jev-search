import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { prepareLocalIndex, searchLocalIndex } from "./local-service.mjs";
import { saveIndex, loadIndex } from "./local-index.mjs";

async function fixture(fn) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "jev-local-service-")));
  try {
    await mkdir(path.join(root, "src"));
    await mkdir(path.join(root, "Downloads"));
    await writeFile(path.join(root, "Downloads", "notes.md"), "# Antenna calibration\ncalibration procedure");
    await fn(root, path.join(root, "cache", "index.gz"));
  } finally { await rm(root, { recursive: true, force: true }); }
}

test("Raycast local service builds once, reuses cache and explicitly refreshes", () => fixture(async (root, cachePath) => {
  const args = { root, cachePath, signal: new AbortController().signal };
  const first = await prepareLocalIndex(args);
  assert.equal(first.docs.length, 1);
  await writeFile(path.join(root, "Downloads", "added.md"), "# Added\nantenna calibration");
  const cached = await prepareLocalIndex(args);
  assert.equal(cached.docs.length, 1);
  const refreshed = await prepareLocalIndex({ ...args, force: true });
  assert.equal(refreshed.docs.length, 2);
  assert.equal((await loadIndex(cachePath, root)).docs.length, 2);
}));

test("local service ignores cloud preferences, emits local results and suppresses cancelled results", () => fixture(async (root, cachePath) => {
  const index = await prepareLocalIndex({ root, cachePath, signal: new AbortController().signal });
  let last;
  // A missing envFile would throw if it were forwarded to the legacy engine.
  await searchLocalIndex(index, "antenna calibration", { signal: new AbortController().signal, key: "must-not-be-used", envFile: "/missing/secret.env", onUpdate: (snapshot) => last = snapshot });
  assert(last.localOnly);
  assert.equal(last.evaluated, 0);
  assert.equal(last.results[0].relative, "Downloads/notes.md");
  const controller = new AbortController(); controller.abort();
  await searchLocalIndex(index, "antenna", { signal: controller.signal, onUpdate: () => assert.fail("stale result") });
}));

test("cancelled rebuild and save preserve the previous index without temporary leftovers", () => fixture(async (root, cachePath) => {
  const index = await prepareLocalIndex({ root, cachePath, signal: new AbortController().signal });
  const original = await readFile(cachePath);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(prepareLocalIndex({ root, cachePath, force: true, signal: controller.signal }));
  await assert.rejects(saveIndex(cachePath, index, { signal: controller.signal }));
  assert.deepEqual(await readFile(cachePath), original);
  assert.deepEqual(await readdir(path.dirname(cachePath)), ["index.gz"]);
}));

test("a corrupt cache surfaces a recoverable error and force rebuild replaces it", () => fixture(async (root, cachePath) => {
  await mkdir(path.dirname(cachePath));
  await writeFile(cachePath, "invalid gzip");
  const args = { root, cachePath, signal: new AbortController().signal };
  await assert.rejects(prepareLocalIndex(args));
  assert.equal((await prepareLocalIndex({ ...args, force: true })).docs.length, 1);
}));
test("failed enumeration preserves the previous cache and missing optional roots are allowed", () => fixture(async (root, cachePath) => {
  await rm(path.join(root, "src"), { recursive: true });
  const args = { root, cachePath, signal: new AbortController().signal };
  const first = await prepareLocalIndex(args);
  assert.equal(first.docs.length, 1);
  const original = await readFile(cachePath);
  await assert.rejects(prepareLocalIndex({ ...args, force: true, rgPath: "/missing/rg" }), /対象一覧/);
  assert.deepEqual(await readFile(cachePath), original);
  assert.equal((await loadIndex(cachePath, root)).docs.length, 1);
}));
test("older tokenization indexes are rebuilt before querying", () => fixture(async (root, cachePath) => {
  const args = { root, cachePath, signal: new AbortController().signal };
  const first = await prepareLocalIndex(args);
  await saveIndex(cachePath, { ...first, version: 1 });
  await assert.rejects(loadIndex(cachePath, root), { code: "INDEX_OUTDATED" });
  await writeFile(path.join(root, "Downloads", "2025.md"), "# Travel expenses 2025");
  const upgraded = await prepareLocalIndex(args);
  assert.equal(upgraded.version, 2);
  let last;
  await searchLocalIndex(upgraded, "2025", { signal: new AbortController().signal, onUpdate: (s) => last = s });
  assert.equal(last.results[0].relative, "Downloads/2025.md");
}));
test("initial partial coverage is explicit and refresh rejects newly failing sources", () => fixture(async (root, cachePath) => {
  await mkdir(path.join(root, "Library"));
  await writeFile(path.join(root, "Library", "CloudStorage"), "not a readable directory");
  const args = { root, cachePath, signal: new AbortController().signal };
  const partial = await prepareLocalIndex(args);
  assert.equal(partial.docs.length, 1);
  assert.equal(partial.stats.scopeErrors.length, 1);
  await writeFile(path.join(root, "Downloads", "added.md"), "# Added\nantenna calibration");
  assert.equal((await prepareLocalIndex({ ...args, force: true })).docs.length, 2);
  const original = await readFile(cachePath);
  await writeFile(path.join(root, "Library", "Mobile Documents"), "newly inaccessible source");
  await assert.rejects(prepareLocalIndex({ ...args, force: true }), /以前の索引/);
  assert.deepEqual(await readFile(cachePath), original);
}));
