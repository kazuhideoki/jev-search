import test from "node:test";
import assert from "node:assert/strict";
import { createIndex, addDocument, queryIndex } from "../src/ranking.mjs";
import { queryExperimental } from "./experimental-ranking.mjs";

test("bounded selection preserves production scores, order, ties and duplicate representatives", () => {
  let seed = 711;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  const words = ["search", "retry", "auth", "keyboard", "AI", "表", "会議", "音声", "2024", "変更"];
  for (let trial = 0; trial < 20; trial++) {
    const index = createIndex("/fixture");
    for (let id = 0; id < 150; id++) {
      const body = Array.from({ length: 1 + Math.floor(random() * 60) }, () => words[Math.floor(random()*words.length)]).join(" ");
      addDocument(index, `${id % 3}/document-${id}.md`, `# ${words[id%words.length]}\n${body}`, {hash:id%4===0 ? `duplicate-${id%7}` : null});
    }
    for (const query of ["search retry", "音声 表", "AI", "2024", "変更", "不存在qzxv", "会議の使い方", "keyboard 調査"])
      for (const limit of [1, 5, 80, 100, 5000])
        assert.deepEqual(queryExperimental(index, query, { limit }), queryIndex(index, query, { limit }));
  }
});
