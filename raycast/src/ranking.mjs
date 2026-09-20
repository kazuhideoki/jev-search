import path from "node:path";

const segmenter = new Intl.Segmenter("ja", { granularity: "word" });
const STOP = new Set(`の が を に は で と から まで する して いる ある した とき ファイル 探す 探して 処理 実装 について
the a an of in to for file find and or is it this that with as on at by be are
前 この その あの これ それ あれ 中 何 どこ どう って っけ やつ もの こと あと ほど だけ かも たい たら ながら
もう一度 思う 思っ だけど けど なく じゃ られる すく わっ てく どれ くらい みたい 名前 忘れ 作っ 見 見る 見たい`.split(/\s+/));

/** Shared document/query analysis. Latin identifiers are split, never substring-matched. */
export function tokenize(value) {
  const text = value.normalize("NFKC")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1 $2").toLowerCase();
  const words = [];
  for (const run of text.matchAll(/[a-z][a-z0-9]*|[0-9]+|[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー]+/gu)) {
    if (/^[a-z0-9]/.test(run[0])) words.push(run[0]);
    else for (const part of segmenter.segment(run[0])) {
      if (part.isWordLike && (part.segment.length > 1 || /\p{Script=Han}/u.test(part.segment))) words.push(part.segment);
    }
  }
  return words.filter((word) => !STOP.has(word));
}

// Small, explicit bilingual vocabulary; no file/project names or benchmark target paths.
const CONCEPTS = [
  [/再送|再試行|リトライ|retry/i, "retry backoff 再試行 再送"],
  [/通信|接続|切断|reconnect/i, "connection reconnect 通信 接続"],
  [/認証|ログイン|authentication/i, "auth login 認証"],
  [/会議|議事録|meeting/i, "meeting 会議 議事録"],
  [/録音|録って|文字に|文字起こし|しゃべ|音声|transcri|dictation/i, "録音 音声 文字起こし transcription transcribe dictation"],
  [/キーボード|キーを|keyboard/i, "keyboard キーボード"],
  [/音楽|music/i, "music 音楽"],
  [/ターミナル|terminal/i, "terminal cli ターミナル"],
  [/書き直|変わっ|変更|差分|changes|diff/i, "変更 差分 編集 changes diff"],
];
export function analyze(query) {
  const primary = [...new Set(tokenize(query))].slice(0, 40);
  const weights = new Map(primary.map((term) => [term, 1]));
  for (const [pattern, additions] of CONCEPTS) if (pattern.test(query)) {
    for (const term of tokenize(additions)) if (!weights.has(term)) weights.set(term, 0.35);
  }
  return { primary, weights, usage: /使い方|使う|起動|どう.*(?:や|開)|セットアップ|設定方法/.test(query), report: /調査|比較|報告|何が.*速/.test(query) };
}
export function termsFor(query) { return [...analyze(query).weights.keys()]; }
export function matches(text, term) { return tokenize(text).includes(term); }

function frequencies(words) {
  const counts = new Map();
  for (const word of words) counts.set(word, Math.min(30, (counts.get(word) || 0) + 1));
  return counts;
}

export function packageFor(relative) {
  const parts = relative.split(path.sep);
  if (parts[0] === "src" && parts.length > 4) return parts.slice(0, 4).join("/");
  if (parts[0] === "Downloads" && parts.length > 2) return parts.slice(0, 2).join("/");
  return path.dirname(relative);
}

/** Compact inverted index: term -> flat [document, bodyTf, headingTf, pathTf, ...]. */
export const INDEX_VERSION = 2;
export function createIndex(root) {
  return { version: INDEX_VERSION, root, builtAt: new Date().toISOString(), docs: [], postings: Object.create(null), totalLength: 0 };
}
export function addDocument(index, relative, text, metadata = {}) {
  const body = tokenize(text);
  const headingText = text.split("\n").filter((line) => /^#{1,6}\s/.test(line)).join("\n");
  const heading = frequencies(tokenize(headingText));
  const filename = frequencies(tokenize(relative));
  const frequency = frequencies(body);
  const terms = new Set([...frequency.keys(), ...heading.keys(), ...filename.keys()]);
  const id = index.docs.length;
  const title = text.match(/^#\s+(.+)$/m)?.[1]?.slice(0, 180) || path.basename(relative);
  index.docs.push({ relative, title, length: body.length, group: packageFor(relative), ...metadata });
  index.totalLength += body.length;
  for (const term of terms) {
    (index.postings[term] ??= []).push(id, frequency.get(term) || 0, heading.get(term) || 0, filename.get(term) || 0);
  }
}

/** Preserve the best half; reserve one quarter for other packages. */
export function selectCandidates(ranked, limit = 80) {
  const selected = [], ids = new Set(), hashes = new Set(), counts = new Map();
  const add = (item) => {
    if (ids.has(item.relative) || (item.hash && hashes.has(item.hash))) return false;
    selected.push(item); ids.add(item.relative);
    if (item.hash) hashes.add(item.hash);
    counts.set(item.group, (counts.get(item.group) || 0) + 1);
    return true;
  };
  const head = Math.ceil(limit * 0.5);
  for (const item of ranked) {
    if (selected.length >= head) break;
    add(item);
  }
  for (const item of ranked) {
    if (selected.length >= Math.ceil(limit * 0.75)) break;
    if (!counts.has(item.group)) add(item);
  }
  for (const item of ranked) {
    if (selected.length >= limit) break;
    if ((counts.get(item.group) || 0) < Math.max(2, Math.ceil(limit / 8))) add(item);
  }
  for (const item of ranked) { if (selected.length >= limit) break; add(item); }
  return selected;
}

export function queryIndex(index, query, { limit = 5000 } = {}) {
  if (!query.trim() || query.length > 1000) throw Error("検索文は1〜1000文字で入力してください");
  const { weights, primary, usage, report } = analyze(query);
  const n = index.docs.length, average = index.totalLength / Math.max(1, n);
  const scores = new Map();
  for (const [term, weight] of weights) {
    const posting = index.postings[term];
    if (!posting) continue;
    const df = posting.length / 4;
    const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
    for (let i = 0; i < posting.length; i += 4) {
      const [id, tf, heading, name] = posting.slice(i, i + 4);
      const doc = index.docs[id];
      const norm = 1.2 * (0.25 + 0.75 * doc.length / Math.max(1, average));
      // Field scores saturate, so long repeated text/path segments do not dominate.
      const value = idf * weight * (tf * 2.2 / (tf + norm) + 2.5 * heading / (heading + 1) + 1.5 * name / (name + 1));
      let item = scores.get(id);
      if (!item) scores.set(id, item = { ...doc, priority: 0, matched: [], primaryHits: 0 });
      item.priority += value;
      item.matched.push(term);
      if (weight === 1) item.primaryHits++;
    }
  }
  const ranked = [...scores.values()];
  for (const item of ranked) {
    item.priority *= 1 + item.primaryHits / Math.max(1, primary.length);
    // Query intent is a small prior; lexical evidence must still support the document.
    if (usage && /readme|guide|usage|cli\.md|使い方|手順/i.test(item.relative + " " + item.title)) item.priority *= 1.15;
    if (report && /report|investigation|調査|比較|報告/i.test(item.relative + " " + item.title)) item.priority *= 1.15;
  }
  ranked.sort((a, b) => b.priority - a.priority || a.relative.localeCompare(b.relative));
  const hashes = new Set();
  return ranked.filter((item) => {
    if (!item.hash) return true;
    if (hashes.has(item.hash)) return false;
    hashes.add(item.hash); return true;
  }).slice(0, limit);
}
