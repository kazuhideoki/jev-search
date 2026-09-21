import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { assertUnusedRun, reserveRun } from "./api-run-state.mjs";

test("API run reservation is exclusive and rejects a run interrupted before its first result", async () => {
  const out = await mkdtemp(path.join(os.tmpdir(), "jev-run-"));
  try {
    const attempts = await Promise.allSettled([reserveRun(out), reserveRun(out)]);
    assert.equal(attempts.filter(x => x.status === "fulfilled").length, 1);
    await assert.rejects(assertUnusedRun(out), /already started/);
    await assert.rejects(reserveRun(out), /already started/);
  } finally { await rm(out, { recursive: true, force: true }); }
});

test("legacy partial request ledgers also prevent resending", async () => {
  const out = await mkdtemp(path.join(os.tmpdir(), "jev-run-"));
  try {
    await writeFile(path.join(out, "requests.jsonl"), "{}\n");
    await assert.rejects(reserveRun(out), /already started/);
  } finally { await rm(out, { recursive: true, force: true }); }
});
