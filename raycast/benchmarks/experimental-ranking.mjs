// Experiments only. Production ranking is deliberately unchanged.
import { analyze } from "../src/ranking.mjs";

export function queryExperimental(index, query, { limit = 100, expansion = true, intentBoost = 1.15, inferDocumentIntent = false, implementationBoost = 1 } = {}) {
  if (!query.trim() || query.length > 1000) throw Error("invalid query");
  const analysis = analyze(query);
  const { primary, report } = analysis;
  const usage = analysis.usage || (inferDocumentIntent && /ツール|アプリ|コマンド|やつ|ソフト/.test(query));
  const weights = [...analysis.weights].filter(([, weight]) => expansion || weight === 1);
  const average = index.totalLength / Math.max(1, index.docs.length);
  const scores = new Map();
  for (const [term, weight] of weights) {
    const posting = index.postings[term];
    if (!posting) continue;
    const df = posting.length / 4;
    const idf = Math.log(1 + (index.docs.length - df + 0.5) / (df + 0.5));
    for (let i = 0; i < posting.length; i += 4) {
      const id = posting[i], tf = posting[i + 1], heading = posting[i + 2], name = posting[i + 3];
      const norm = 1.2 * (0.25 + 0.75 * index.docs[id].length / Math.max(1, average));
      const value = idf * weight * (tf * 2.2 / (tf + norm) + 2.5 * heading / (heading + 1) + 1.5 * name / (name + 1));
      let row = scores.get(id);
      if (!row) scores.set(id, row = { id, priority: 0, matched: [], primaryHits: 0 });
      row.priority += value;
      row.matched.push(term);
      if (weight === 1) row.primaryHits++;
    }
  }
  const compare = (a, b) => b.priority - a.priority || index.docs[a.id].relative.localeCompare(index.docs[b.id].relative);
  // Deduplicate before top-k; choosing the best representative matches sort/filter.
  const unique = new Map();
  for (const row of scores.values()) {
    row.priority *= 1 + row.primaryHits / Math.max(1, primary.length);
    const doc = index.docs[row.id], label = doc.relative + " " + doc.title;
    if (usage && /readme|guide|usage|cli\.md|使い方|手順/i.test(label)) row.priority *= intentBoost;
    if (report && /report|investigation|調査|比較|報告/i.test(label)) row.priority *= intentBoost;
    if (/実装|関数|コード|implementation|function/i.test(query) && /\.(?:[cm]?js|[jt]sx?|py|rs|swift|go|sh|c|cpp|h)$/.test(doc.relative) && !/(?:test|spec)[./_-]/i.test(doc.relative)) row.priority *= implementationBoost;
    const key = doc.hash ? `hash:${doc.hash}` : row.id;
    const previous = unique.get(key);
    if (!previous || compare(row, previous) < 0) unique.set(key, row);
  }
  // Worst-first heap, bounded by display limit; materialize document metadata last.
  const heap = [];
  for (const row of unique.values()) {
    if (heap.length < limit) {
      heap.push(row);
      let i = heap.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (compare(heap[i], heap[p]) <= 0) break;
        [heap[i], heap[p]] = [heap[p], heap[i]]; i = p;
      }
    } else if (compare(row, heap[0]) < 0) {
      heap[0] = row;
      let i = 0;
      while (2 * i + 1 < heap.length) {
        let child = 2 * i + 1;
        if (child + 1 < heap.length && compare(heap[child + 1], heap[child]) > 0) child++;
        if (compare(heap[child], heap[i]) <= 0) break;
        [heap[i], heap[child]] = [heap[child], heap[i]]; i = child;
      }
    }
  }
  return heap.sort(compare).map(({ id, ...row }) => ({ ...index.docs[id], ...row }));
}

export const VARIANTS = {
  lean: {},
  noExpansion: { expansion: false },
  strongerIntent: { intentBoost: 2 },
  inferredIntent: { intentBoost: 2, inferDocumentIntent: true },
  typedIntent: { intentBoost: 2, inferDocumentIntent: true, implementationBoost: 2 },
};
