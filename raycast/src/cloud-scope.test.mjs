import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { createIndex, addDocument } from "./ranking.mjs";
import { createProgressiveSearch } from "./progressive-search.mjs";
const exec = promisify(execFile);

test("removing a src file from Git prevents new contents reaching the evaluator", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "jev-cloud-scope-")));
  const repo = path.join(root, "src", "repo");
  try {
    await mkdir(repo, { recursive: true });
    await exec("git", ["init", "-q", repo]);
    await writeFile(path.join(repo, "manual.txt"), "keyboard manual");
    await exec("git", ["-C", repo, "add", "manual.txt"]);
    const index = createIndex(root);
    addDocument(index, "src/repo/manual.txt", "keyboard manual");
    let calls = 0;
    const session = createProgressiveSearch(index, "keyboard", { evaluator: async (_query, batch) => {
      calls++; assert(!batch.some(d => d.excerpt.includes("PRIVATE_UPDATED")));
      return { scores: batch.map(() => .8) };
    } });
    const request = () => ({ key: "fixture", signal: new AbortController().signal });
    assert.equal((await session.refine(request())).evaluated, 1);
    await exec("git", ["-C", repo, "rm", "--cached", "-q", "manual.txt"]);
    await writeFile(path.join(repo, "manual.txt"), "keyboard PRIVATE_UPDATED");
    const expanded = await session.refine(request());
    assert.equal(expanded.evaluated, 0); assert.equal(expanded.skipped, 1); assert.equal(calls, 1);
    const fresh = createProgressiveSearch(index, "keyboard", { evaluator: () => assert.fail("must not transmit") });
    assert.equal((await fresh.refine(request())).evaluated, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});
