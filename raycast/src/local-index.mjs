import { readFile, mkdir, rename, realpath, rm } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { createGzip, gunzip } from "node:zlib";
import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { createIndex, addDocument, INDEX_VERSION } from "./ranking.mjs";
import { allowed, readText, stream } from "./engine.mjs";
import { personalScope } from "./scope.mjs";

const decompress = promisify(gunzip);
export const MAX_BYTES = 64 * 1024;

export async function buildIndex(root, { personal = false, allowPartial = false, signal = new AbortController().signal, onProgress = (_progress) => {}, files, rgPath = "/opt/homebrew/bin/rg" } = {}) {
  root = await realpath(root);
  const started = performance.now();
  const index = createIndex(root);
  let scope;
  onProgress({ phase: "enumerate", processed: 0 });
  if (!files) {
    if (personal) {
      scope = await personalScope(root, signal, { rgPath });
      if (scope.incomplete) throw Error("対象一覧の作成を中断しました");
      if (scope.errors.length && !allowPartial) throw Error(`対象一覧を作成できませんでした: ${scope.errors.join(" / ")}`);
      files = [...scope.files];
    } else {
      files = [];
      await stream(rgPath, ["--no-config", "--files", "--null", "--no-hidden", "--no-follow", "--no-require-git"], root, signal, (p) => { if (allowed(p)) files.push(p); });
    }
  }
  files = [...files].filter(allowed).sort();
  index.stats = { discovered: files.length, indexed: 0, skipped: 0, truncated: 0, errors: {}, scopeErrors: scope?.errors || [], scopeGroups: scope?.groups || {}, maxBytes: MAX_BYTES };
  let offset = 0, processed = 0;
  // Bound file descriptors and memory. Cancellation never replaces the previous index.
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (offset < files.length) {
      signal.throwIfAborted();
      const relative = files[offset++];
      try {
        const data = await readText(root, relative, MAX_BYTES);
        signal.throwIfAborted();
        addDocument(index, relative, data.text, {
          size: data.size, mtimeMs: data.mtimeMs, truncated: data.truncated,
          // A shared prefix is not proof of a duplicate.
          hash: data.truncated ? null : createHash("sha256").update(data.text).digest("hex"),
        });
        index.stats.indexed++;
        if (data.truncated) index.stats.truncated++;
      } catch (error) {
        signal.throwIfAborted();
        index.stats.skipped++;
        const code = error.code || error.message;
        index.stats.errors[code] = (index.stats.errors[code] || 0) + 1;
      }
      processed++;
      if (processed % 500 === 0 || processed === files.length) onProgress({ phase: "index", processed, total: files.length });
    }
  }));
  signal.throwIfAborted();
  index.stats.buildMs = performance.now() - started;
  return index;
}

export async function saveIndex(filename, index, { signal } = {}) {
  signal?.throwIfAborted();
  await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    // Avoid a second, full-size JSON string alongside the in-memory index.
    function* chunks() {
      const { docs, postings, ...metadata } = index;
      yield JSON.stringify(metadata).slice(0, -1) + ',"docs":[';
      for (let i = 0; i < docs.length; i++) yield (i ? "," : "") + JSON.stringify(docs[i]);
      yield '],"postings":{';
      let first = true;
      for (const term of Object.keys(postings)) {
        yield (first ? "" : ",") + JSON.stringify(term) + ":" + JSON.stringify(postings[term]);
        first = false;
      }
      yield "}}";
    }
    await pipeline(Readable.from(chunks()), createGzip(), createWriteStream(temporary, { mode: 0o600 }), { signal });
    signal?.throwIfAborted();
    await rename(temporary, filename);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function loadIndex(filename, root) {
  const index = JSON.parse((await decompress(await readFile(filename))).toString("utf8"));
  if (index.root !== await realpath(root) || !Array.isArray(index.docs) || !index.postings) throw Error("索引の形式または対象が変わりました。--rebuild で更新してください");
  if (index.version !== INDEX_VERSION) throw Object.assign(Error("索引の形式が変わりました。--rebuild で更新してください"), { code: "INDEX_OUTDATED" });
  index.postings = Object.assign(Object.create(null), index.postings);
  return index;
}
