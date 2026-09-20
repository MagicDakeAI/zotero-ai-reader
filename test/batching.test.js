import test from "node:test";
import assert from "node:assert/strict";
import { createBatches } from "../plugin-src/core.js";

test("批处理保持段落顺序且不丢失", () => {
  const paragraphs = Array.from({ length: 10 }, (_, index) => ({
    paragraph_id: `p${index}`, original: "x".repeat(400),
  }));
  const batches = createBatches(paragraphs, 1200);
  assert.ok(batches.length > 1);
  assert.deepEqual(batches.flat().map((item) => item.paragraph_id), paragraphs.map((item) => item.paragraph_id));
});

test("单个请求最多携带八段，降低模型输出错配风险", () => {
  const paragraphs = Array.from({ length: 13 }, (_, index) => ({
    paragraph_id: `p${index}`, original: "short",
  }));
  const batches = createBatches(paragraphs, 7000);
  assert.deepEqual(batches.map((batch) => batch.length), [8, 5]);
});
