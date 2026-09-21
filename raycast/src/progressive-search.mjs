import path from "node:path";
import { queryIndex, selectCandidates, termsFor } from "./ranking.mjs";
import { evaluate, excerpts } from "./engine.mjs";
import { abortable } from "./abortable.mjs";
import { currentCloudScope } from "./cloud-scope.mjs";

/** One query, one index generation. Only refine() can contact an external API. */
export function createProgressiveSearch(index, query, { evaluator = evaluate, excerptReader = excerpts } = {}) {
  const started = performance.now();
  const ranked = queryIndex(index, query, { limit: index.docs.length });
  let stage = 0, busy = false, elapsedMs = performance.now() - started;
  let committed = new Map();
  const cached = new Map();
  let tokens = 0, skipped = 0;
  const snapshot = () => ({
    stage, elapsedMs, complete: true, errors: [], tokens, skipped, evaluated: committed.size,
    results: [...ranked].sort((a, b) => (committed.get(b.relative) ?? -1) - (committed.get(a.relative) ?? -1) || b.priority - a.priority || a.relative.localeCompare(b.relative))
      .slice(0, 100).map(doc => ({ path: path.join(index.root, doc.relative), relative: doc.relative,
        title: doc.title, matched: doc.matched, truncated: doc.truncated, score: committed.get(doc.relative) ?? null })),
  });
  async function refine({ key, envFile, signal, onProgress = (_value) => {} }) {
    if (busy) return null;
    if (stage === 80) return snapshot();
    if (!key) throw Error("Jev APIキー、またはキーを含む.envファイルをコマンド設定で指定してください。");
    signal.throwIfAborted();
    busy = true;
    const start = performance.now(), target = stage === 0 ? 20 : 80;
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(15000)]);
    try {
      const eligible = ranked.filter(doc => !envFile || path.resolve(index.root, doc.relative) !== envFile);
      // Nested budgets: retain the first twenty and fill the expanded plan to eighty.
      const first = selectCandidates(eligible, 20), seen = new Set(first.map(doc => doc.relative));
      const plan = [...first, ...selectCandidates(eligible, 80).filter(doc => !seen.has(doc.relative))].slice(0, target);
      const inScope = currentCloudScope(index.root, requestSignal);
      const available = new Set();
      const pending = plan;
      let offset = 0, done = 0;
      let failure;
      onProgress({ target, evaluated: done, total: plan.length });
      await Promise.all(Array.from({ length: 2 }, async () => {
        while (offset < pending.length && !requestSignal.aborted && !failure) {
          const batch = pending.slice(offset, offset += 10);
          try {
            const ready = [];
            for (const doc of batch) {
              requestSignal.throwIfAborted();
              try {
                if (!await abortable(requestSignal, () => inScope(doc.relative))) { done++; continue; }
                // Re-read even cached candidates to detect deletions. Successful
                // scores still avoid repeat API charges within this query.
                const value = await abortable(requestSignal, () => excerptReader(index.root, doc.relative, termsFor(query), 1800));
                available.add(doc.relative);
                if (cached.has(doc.relative)) done++;
                else ready.push({ ...doc, excerpt: value.content });
              } catch { requestSignal.throwIfAborted(); done++; }
            }
            if (ready.length) {
              const response = await abortable(requestSignal, () => evaluator(query, ready, key, requestSignal));
              requestSignal.throwIfAborted();
              if (response.scores.length !== ready.length || response.scores.some(score => !Number.isFinite(score) || score < 0 || score > 1)) throw Error("API応答が不正です");
              ready.forEach((doc, i) => cached.set(doc.relative, response.scores[i]));
              tokens += response.tokens ?? 0;
            }
            done += ready.length;
            onProgress({ target, evaluated: done, total: plan.length });
          } catch (error) { failure ??= error; }
        }
      }));
      signal.throwIfAborted();
      if (requestSignal.aborted) throw Error("Jev評価がタイムアウトしました。⌘⇧Rで再試行できます。");
      if (failure) throw failure;
      committed = new Map(plan.filter(doc => available.has(doc.relative) && cached.has(doc.relative)).map(doc => [doc.relative, cached.get(doc.relative)]));
      skipped = plan.length - committed.size;
      stage = target;
      elapsedMs = performance.now() - start;
      return snapshot();
    } finally { busy = false; }
  }
  return { snapshot, refine };
}
