import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, symlink, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  termsFor,
  allowed,
  literal,
  excerpts,
  search,
  evaluate,
} from "./engine.mjs";
async function fixture(fn) {
  const root = await mkdtemp(path.join(os.tmpdir(), "jev-test-"));
  try {
    await fn(await (await import("node:fs/promises")).realpath(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
test("Japanese expansion, stopwords, literal escaping and credential exclusion", () => {
  assert(termsFor("通信が切れたときにデータを再送する処理").includes("retry"));
  assert(!termsFor("探しているファイル").includes("ファイル"));
  for (const value of [
    "../a.md",
    ".env",
    "x/credentials.json",
    "a/id_rsa",
    "secret.yaml",
    "a.pem",
    ".ssh/a.txt",
    "node_modules/a.js",
  ])
    assert.equal(allowed(value), false, value);
  assert(allowed("docs/retry.md"));
  assert.equal(literal('a*"?'), '"a\\*\\"\\?"');
});
test("bounded excerpts find a late match and reject symlinks and binary", () =>
  fixture(async (root) => {
    await writeFile(
      path.join(root, "notes.md"),
      "preamble\n".repeat(600) + "retry backoff\nimportant evidence",
    );
    const result = await excerpts(root, "notes.md", ["retry"], 1800);
    assert.match(result.content, /retry backoff/);
    assert(result.content.length <= 1850);
    assert(result.truncated);
    await symlink(path.join(root, "notes.md"), path.join(root, "link.md"));
    await assert.rejects(excerpts(root, "link.md", [], 1800));
    await writeFile(path.join(root, "binary.txt"), Buffer.from([0, 1, 2]));
    await assert.rejects(excerpts(root, "binary.txt", [], 1800));
  }));
test("streaming search respects ignores, separates display/evaluation and emits provisional results", () =>
  fixture(async (root) => {
    await writeFile(path.join(root, ".gitignore"), "ignored.md\n");
    await writeFile(path.join(root, "ignored.md"), "retry");
    await writeFile(path.join(root, ".env"), "SECRET=do-not-send");
    await mkdir(path.join(root, "docs"));
    for (let i = 0; i < 12; i++)
      await writeFile(
        path.join(root, `docs/retry-${i}.md`),
        "retry with backoff",
      );
    const snapshots = [],
      sent = [];
    await search({
      query: "再送",
      root,
      key: "test",
      signal: new AbortController().signal,
      spotlight: false,
      limits: { display: 2, evaluate: 6, deepen: 0, batch: 2 },
      onUpdate: (s) => snapshots.push(s),
      evaluator: async (_q, batch) => {
        sent.push(...batch.map((x) => x.relative));
        await new Promise((r) => setTimeout(r, 140));
        return { scores: batch.map(() => 0.8), tokens: 10, model: "mock" };
      },
    });
    const last = snapshots.at(-1);
    assert.equal(last.total, 12);
    assert.equal(last.evaluated, 6);
    assert.equal(last.results.length, 2);
    assert(last.budgetReached);
    assert(snapshots.some((s) => s.results.length && s.evaluated === 0));
    assert(sent.every((p) => p.startsWith("docs/")));
  }));
test("cancellation suppresses stale results even when evaluator ignores abort", () =>
  fixture(async (root) => {
    await writeFile(path.join(root, "retry.md"), "retry");
    const controller = new AbortController();
    let called = 0,
      stale = 0;
    await search({
      query: "retry",
      root,
      key: "test",
      signal: controller.signal,
      spotlight: false,
      onUpdate: () => {
        if (controller.signal.aborted) stale++;
      },
      evaluator: async () => {
        called++;
        controller.abort();
        return { scores: [0.9], tokens: 1, model: "mock" };
      },
    });
    assert.equal(called, 1);
    assert.equal(stale, 0);
  }));
test("401 stops unsent evaluations and leaves other candidates unscored", () =>
  fixture(async (root) => {
    for (let i = 0; i < 10; i++)
      await writeFile(path.join(root, `${i}.md`), "retry");
    let last,
      calls = 0;
    await search({
      query: "retry",
      root,
      key: "test",
      signal: new AbortController().signal,
      spotlight: false,
      limits: { concurrency: 1, batch: 2 },
      onUpdate: (s) => (last = s),
      evaluator: async () => {
        calls++;
        throw new Error("API HTTP 401");
      },
    });
    assert.equal(calls, 1);
    assert.equal(last.evaluated, 0);
    assert(last.results.every((x) => x.score === null));
    assert(last.errors.includes("API HTTP 401"));
  }));
test("local-only searches never invoke evaluator", () =>
  fixture(async (root) => {
    await writeFile(path.join(root, "hello.md"), "hello");
    let last;
    await search({
      query: "hello",
      root,
      signal: new AbortController().signal,
      spotlight: false,
      onUpdate: (s) => (last = s),
      evaluator: () => assert.fail("cloud called"),
    });
    assert(last.localOnly);
    assert.equal(last.results.length, 1);
  }));
test("API independently validates every Noul and does not reveal response bodies", async () => {
  const signal = new AbortController().signal;
  const batch = [{ relative: "a.md", excerpt: "data" }];
  await assert.rejects(
    evaluate(
      "q",
      batch,
      "test",
      signal,
      async () =>
        new Response(
          JSON.stringify({ answers: { c0: { type: "noul", noul: 1.5 } } }),
        ),
    ),
    /不正/,
  );
  await assert.rejects(
    evaluate(
      "q",
      batch,
      "test",
      signal,
      async () => new Response("SENSITIVE", { status: 403 }),
    ),
    /API HTTP 403/,
  );
});
test("a late name match survives the display limit and bounded candidate retention", () =>
  fixture(async (root) => {
    for (let i = 0; i < 230; i++)
      await writeFile(
        path.join(root, `${String(i).padStart(3, "0")}.md`),
        "unrelated",
      );
    await writeFile(path.join(root, "zzz-retry.md"), "retry");
    let last;
    await search({
      query: "retry",
      root,
      signal: new AbortController().signal,
      spotlight: false,
      limits: { display: 1, candidates: 20 },
      onUpdate: (s) => (last = s),
    });
    assert.equal(last.total, 231);
    assert(last.retained <= 20);
    assert(last.retainedDropped > 0);
    assert.equal(last.results[0].relative, "zzz-retry.md");
  }));
test("additional evidence replaces the score instead of taking a maximum", () =>
  fixture(async (root) => {
    await writeFile(
      path.join(root, "retry.md"),
      "retry context\n".repeat(1200),
    );
    let calls = 0,
      last;
    await search({
      query: "retry",
      root,
      key: "test",
      signal: new AbortController().signal,
      spotlight: false,
      onUpdate: (s) => (last = s),
      evaluator: async () => ({
        scores: [++calls === 1 ? 0.9 : 0.4],
        tokens: 2,
        model: "mock",
      }),
    });
    assert.equal(calls, 2);
    assert.equal(last.results[0].score, 0.4);
    assert.equal(last.results[0].status, "deepened");
  }));
test("deadline preserves unscored status and reports partial coverage", () =>
  fixture(async (root) => {
    await writeFile(path.join(root, "retry.md"), "retry");
    let last;
    await search({
      query: "retry",
      root,
      key: "test",
      signal: new AbortController().signal,
      spotlight: false,
      limits: { durationMs: 180 },
      onUpdate: (s) => (last = s),
      evaluator: async (_q, _b, _k, signal) => {
        await new Promise((resolve) =>
          signal.addEventListener("abort", resolve, { once: true }),
        );
        throw new Error("cancelled");
      },
    });
    assert(last.timedOut);
    assert(last.complete);
    assert.equal(last.results[0].score, null);
    assert.equal(last.results[0].status, "unevaluated");
  }));
test("a custom-named API key file is never a candidate or cloud input", () =>
  fixture(async (root) => {
    const envFile = path.join(root, "settings.txt");
    await writeFile(envFile, "TYPESAFE_API_KEY=fixture-only");
    await writeFile(path.join(root, "retry.md"), "retry");
    let last;
    await search({
      query: "retry",
      root,
      envFile,
      signal: new AbortController().signal,
      spotlight: false,
      onUpdate: (s) => (last = s),
      evaluator: async (_q, batch) => {
        assert(batch.every((x) => x.relative !== "settings.txt"));
        return { scores: batch.map(() => 0.8), tokens: 1, model: "mock" };
      },
    });
    assert.equal(last.total, 1);
    assert.equal(last.results[0].relative, "retry.md");
  }));
test("scope excludes every unlisted file including content matches", () =>
  fixture(async (root) => {
    await writeFile(path.join(root, "keep.md"), "retry");
    await writeFile(path.join(root, "outside.md"), "retry");
    let last;
    await search({
      query: "retry",
      root,
      scope: { files: new Set(["keep.md"]), roots: [root] },
      signal: new AbortController().signal,
      spotlight: false,
      onUpdate: (s) => (last = s),
    });
    assert.equal(last.total, 1);
    assert.equal(last.results[0].relative, "keep.md");
  }));
test("personal scope includes tracked source and document roots but not untracked source or Library cache", () =>
  fixture(async (root) => {
    const { execFileSync } = await import("node:child_process");
    const { personalScope } = await import("./scope.mjs");
    const repo = path.join(root, "src", "example");
    await mkdir(repo, { recursive: true });
    execFileSync("/usr/bin/git", ["init", "-q"], { cwd: repo });
    await writeFile(path.join(repo, "tracked.md"), "tracked");
    await writeFile(path.join(repo, "untracked.md"), "untracked");
    await symlink("/etc/hosts", path.join(repo, "link.txt"));
    execFileSync("/usr/bin/git", ["add", "tracked.md", "link.txt"], {
      cwd: repo,
    });
    for (const relative of [
      "Downloads/a.md",
      "マイドライブ/b.md",
      "Library/Mobile Documents/com~apple~CloudDocs/c.md",
      "Library/Mobile Documents/iCloud~example/Documents/d.md",
      "Library/Caches/e.md",
    ]) {
      const file = path.join(root, relative);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, "document");
    }
    const scope = await personalScope(root, new AbortController().signal);
    assert(scope.files.has("src/example/tracked.md"));
    assert(!scope.files.has("src/example/untracked.md"));
    assert(!scope.files.has("src/example/link.txt"));
    assert(!scope.files.has("Library/Caches/e.md"));
    assert.equal(scope.files.size, 5);
    assert.equal(scope.repositories, 1);
  }));
test("a document-root alias cannot include untracked files under src", () => fixture(async (root) => {
  const { execFileSync } = await import("node:child_process");
  const { personalScope } = await import("./scope.mjs");
  const repo = path.join(root, "src", "example");
  await mkdir(repo, { recursive: true });
  execFileSync("/usr/bin/git", ["init", "-q"], { cwd: repo });
  await writeFile(path.join(repo, "tracked.md"), "tracked");
  await writeFile(path.join(repo, "untracked.md"), "untracked");
  execFileSync("/usr/bin/git", ["add", "tracked.md"], { cwd: repo });
  await symlink(repo, path.join(root, "Downloads"));
  const scope = await personalScope(root, new AbortController().signal);
  assert.deepEqual([...scope.files], ["src/example/tracked.md"]);
  await rm(path.join(root, "Downloads"));
  await symlink(root, path.join(root, "Downloads"));
  assert.deepEqual([...(await personalScope(root, new AbortController().signal)).files], ["src/example/tracked.md"]);
}));
