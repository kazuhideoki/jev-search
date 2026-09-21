import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, realpath, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { startLocalWorker, resolveNode } from "./worker-client.mjs";

test("worker builds, queues a search, returns bounded results and previews, refreshes and exits", { timeout: 20000 }, async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "jev-worker-test-")));
  let client;
  const events = [], pending = [];
  function waitFor(predicate) {
    const existing = events.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(Error("worker response timeout")), 5000);
      pending.push({ predicate, resolve: (event) => { clearTimeout(timeout); resolve(event); } });
    });
  }
  try {
    await mkdir(path.join(root, "src"));
    await mkdir(path.join(root, "Downloads"));
    await writeFile(path.join(root, "Downloads", "manual.md"), "# Antenna calibration\nUse the reference load.\n" + "background ".repeat(7000));
    client = await startLocalWorker({ script: fileURLToPath(new URL("./local-worker.mjs", import.meta.url)), root,
      cachePath: path.join(root, "cache", "index.gz"), rgPath: "/opt/homebrew/bin/rg", nodePath: process.execPath,
      onEvent: (event) => { events.push(event); for (const p of pending) if (p.predicate(event)) p.resolve(event); },
    });
    client.send({ type: "search", id: 1, query: "antenna calibration" });
    const ready = await waitFor((e) => e.event === "ready");
    assert.equal(ready.metadata.count, 1);
    assert(!("docs" in ready.metadata)); assert(!("postings" in ready.metadata));
    const result = await waitFor((e) => e.event === "results" && e.id === 1);
    assert.equal(result.snapshot.results[0].relative, "Downloads/manual.md");
    assert.equal(result.snapshot.results[0].truncated, true);
    assert(JSON.stringify(result).length < 10000);
    client.send({ type: "preview", id: 2, relative: "Downloads/manual.md", query: "calibration" });
    assert.match((await waitFor((e) => e.event === "preview" && e.id === 2)).text, /reference load/);
    client.send({ type: "search", id: 3, query: "zzzxqnotfound" });
    assert.equal((await waitFor((e) => e.event === "results" && e.id === 3)).snapshot.results.length, 0);
    client.send({ type: "refine", id: 4, query: "different-query" });
    assert.equal((await waitFor(e => e.event === "error" && e.id === 4)).operation, "refine");
    // No matches means no API request. A stale file must not block a direct key.
    client.send({ type: "configure", apiKey: "fixture", envFile: path.join(root, "missing.env") });
    client.send({ type: "refine", id: 5, query: "zzzxqnotfound" });
    const refined = await waitFor(e => e.event === "results" && e.id === 5);
    assert.equal(refined.snapshot.stage, 20);
    assert.equal(refined.snapshot.evaluated, 0);
    await writeFile(path.join(root, "Downloads", "new.md"), "# New instrument\ncalibration instrument");
    client.send({ type: "rebuild" });
    assert.equal((await waitFor((e) => e.event === "ready" && e.metadata.count === 2)).metadata.count, 2);
    assert(!events.some((e) => e.event === "error" && e.id !== 4));
  } finally {
    client?.dispose();
    if (client) await client.exited;
    if (client) assert.equal(client.send({ type: "rebuild" }), false);
    await rm(root, { recursive: true, force: true });
  }
});

test("missing or relative custom runtimes produce an actionable error", async () => {
  await assert.rejects(resolveNode("relative/node"), /Node.js/);
  await assert.rejects(resolveNode("/missing/jev-node"), /Node.js/);
});
