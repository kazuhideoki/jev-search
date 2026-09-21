import test from "node:test";
import assert from "node:assert/strict";
import { createIndex, addDocument } from "./ranking.mjs";
import { createProgressiveSearch } from "./progressive-search.mjs";

function fixture(options = {}) {
  const index = createIndex("/fixture");
  for (let i = 0; i < 100; i++) addDocument(index, `group-${i % 9}/doc-${i}.md`, `# keyboard\nkeyboard manual ${i}`);
  return createProgressiveSearch(index, "keyboard", { excerptReader: async () => ({ content: "Keyboard guide" }), ...options });
}
const request = () => ({ key: "fixture", signal: new AbortController().signal });

test("local -> twenty -> eighty reuses evaluations and never sends on local or repeated final action", async () => {
  const sent = [];
  const session = fixture({ evaluator: async (_query, batch) => {
    sent.push(...batch.map(d => d.relative));
    return { scores: batch.map(() => .8), tokens: 12 };
  } });
  assert.equal(session.snapshot().stage, 0); assert.equal(sent.length, 0);
  assert.equal((await session.refine(request())).evaluated, 20);
  assert.equal(session.snapshot().stage, 20);
  assert.equal((await session.refine(request())).evaluated, 80);
  assert.equal(session.snapshot().stage, 80);
  assert.equal(sent.length, 80); assert.equal(new Set(sent).size, 80);
  await session.refine(request()); assert.equal(sent.length, 80);
});

test("failed expansion preserves displayed ranking and retries only missing batches", async () => {
  let calls = 0, fail = false;
  const sent = [];
  const session = fixture({ evaluator: async (_query, batch) => {
    calls++;
    if (fail && calls === 4) throw Error("API HTTP 429");
    sent.push(...batch.map(d => d.relative));
    return { scores: batch.map(() => .7), tokens: 1 };
  } });
  const first = await session.refine(request());
  fail = true;
  await assert.rejects(session.refine(request()), /429/);
  assert.equal(session.snapshot().stage, 20);
  assert.deepEqual(session.snapshot().results, first.results);
  fail = false;
  assert.equal((await session.refine(request())).stage, 80);
  assert.equal(sent.length, 80); assert.equal(new Set(sent).size, 80);
});

test("abort ignores late successful API replies; concurrent refine does not duplicate requests", async () => {
  const resolvers = [];
  const session = fixture({ evaluator: async (_query, batch) => new Promise(resolve => resolvers.push(() => resolve({ scores: batch.map(() => .9), tokens: 1 }))) });
  const controller = new AbortController();
  const pending = session.refine({ key: "fixture", signal: controller.signal });
  const rejected = assert.rejects(pending, /abort/i);
  while (resolvers.length < 2) await new Promise(resolve => setImmediate(resolve));
  assert.equal(await session.refine(request()), null);
  controller.abort(); resolvers.forEach(resolve => resolve());
  await rejected; assert.equal(session.snapshot().stage, 0);
  assert(session.snapshot().results.every(r => r.score === null));
});

test("missing credentials and invalid scores do not advance the stage", async () => {
  let calls = 0;
  const session = fixture({ evaluator: async (_q, batch) => { calls++; return { scores: batch.map(() => NaN), tokens: 1 }; } });
  await assert.rejects(session.refine({ key: "", signal: new AbortController().signal }), /APIキー/);
  assert.equal(calls, 0);
  await assert.rejects(session.refine(request()), /API応答/);
  assert.equal(session.snapshot().stage, 0);
});

test("cancellation releases hung excerpt reads and retains displayed results", async () => {
  let calls = 0;
  const session = fixture({ excerptReader: () => new Promise(() => {}), evaluator: () => { calls++; } });
  const controller = new AbortController();
  const before = session.snapshot().results;
  const pending = session.refine({ key: "fixture", signal: controller.signal });
  const rejected = assert.rejects(pending, /abort/i);
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  await rejected;
  assert.equal(calls, 0);
  assert.deepEqual(session.snapshot().results, before);
});

test("custom credential files are excluded and short result sets do not repeat calls", async () => {
  const index = createIndex("/fixture");
  addDocument(index, "settings.txt", "keyboard configuration");
  addDocument(index, "manual.md", "keyboard manual");
  const sent = [];
  const session = createProgressiveSearch(index, "keyboard", { excerptReader: async () => ({ content: "guide" }), evaluator: async (_q, batch) => {
    sent.push(...batch.map(d => d.relative)); return { scores: batch.map(() => .8), tokens: 1 };
  } });
  assert.equal((await session.refine({ ...request(), envFile: "/fixture/settings.txt" })).evaluated, 1);
  await session.refine({ ...request(), envFile: "/fixture/settings.txt" });
  assert.deepEqual(sent, ["manual.md"]);
});

test("an unreadable candidate does not block its healthy siblings or stage expansion", async () => {
  const sent = [];
  const session = fixture({
    excerptReader: async (_root, relative) => {
      if (relative.endsWith("doc-0.md")) throw Object.assign(Error("missing"), { code: "ENOENT" });
      return { content: "Keyboard guide" };
    },
    evaluator: async (_query, batch) => { sent.push(...batch.map(d => d.relative)); return { scores: batch.map(() => .8) }; },
  });
  const first = await session.refine(request());
  assert.equal(first.stage, 20); assert.equal(first.skipped, 1); assert.equal(first.evaluated, 19);
  const expanded = await session.refine(request());
  assert.equal(expanded.stage, 80); assert.equal(expanded.skipped, 1); assert.equal(expanded.evaluated, 79);
  assert.equal(sent.length, 79); assert(!sent.some(p => p.endsWith("doc-0.md")));
});
