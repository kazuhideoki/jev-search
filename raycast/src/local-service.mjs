import { realpath } from "node:fs/promises";
import { buildIndex, loadIndex, saveIndex } from "./local-index.mjs";
import { search } from "./engine.mjs";

/** Local command boundary: API preferences are never accepted or forwarded. */
export function searchLocalIndex(index, query, { signal, onUpdate }) {
  return search({ root: index.root, index, query, signal, onUpdate, spotlight: false });
}

/** Load a persistent index or rebuild it without replacing a good cache on cancellation. */
export async function prepareLocalIndex({ root, cachePath, force = false, signal, rgPath, onProgress = (_progress) => {} }) {
  root = await realpath(root);
  signal.throwIfAborted();
  let previousErrors;
  try {
    let cached = await loadIndex(cachePath, root);
    signal.throwIfAborted();
    if (!force) return cached;
    previousErrors = cached.stats.scopeErrors;
    cached = undefined;
  } catch (error) {
    signal.throwIfAborted();
    if (!force && !["ENOENT", "INDEX_OUTDATED"].includes(error.code)) throw error;
  }
  const index = await buildIndex(root, { personal: true, allowPartial: true, signal, rgPath, onProgress });
  const failures = index.stats.scopeErrors;
  // An initial partial index is useful when macOS denies a cloud folder. Once an
  // index exists, newly failing sources must not replace previously searchable data.
  if (failures.length && (!index.docs.length || (previousErrors && failures.some((error) => !previousErrors.includes(error))))) {
    throw Error(`対象一覧を作成できませんでした。以前の索引を維持します: ${failures.join(" / ")}`);
  }
  await saveIndex(cachePath, index, { signal });
  signal.throwIfAborted();
  return index;
}
