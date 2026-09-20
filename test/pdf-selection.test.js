import test from "node:test";
import assert from "node:assert/strict";
import { extractSelectedPages } from "../plugin-src/pdf-extractor.js";

function textNode(text, pageIndex, rect) {
  return {
    text,
    anchor: { textMap: JSON.stringify([[0, pageIndex, ...rect]]) },
  };
}

function mockSDT(pageCount = 5) {
  const requested = [];
  const pages = Array.from({ length: pageCount }, (_, pageIndex) => ({
    viewRect: [0, 0, 600, 800],
    contentRange: [[pageIndex], [pageIndex + 1]],
  }));
  const reader = {
    async getCatalog() { return { pages }; },
    async getPageBlocks(pageIndex) {
      requested.push(pageIndex);
      return [{
        type: "paragraph",
        anchor: { pageRects: [[pageIndex, 50, 680, 240, 712]] },
        content: [textNode(`UNIQUE_PAGE_${pageIndex + 1}`, pageIndex, [50, 680, 240, 712])],
      }];
    },
  };
  return {
    requested,
    async getReader(_itemID, { onProgress }) {
      onProgress?.(25);
      onProgress?.(100);
      return reader;
    },
  };
}

test("Zotero SDT 只读取选中页并报告真实逐页进度", async () => {
  const sdt = mockSDT();
  const progress = [];
  const preparation = [];
  const extracted = await extractSelectedPages(sdt, 42, [1, 3, 5], {
    onPage: (event) => progress.push(event.current),
    onPrepareProgress: (percent) => preparation.push(percent),
  });
  assert.deepEqual(sdt.requested, [0, 2, 4]);
  assert.deepEqual(progress, [1, 2, 3]);
  assert.deepEqual(preparation, [25, 100]);
  assert.deepEqual(extracted.pages.map((page) => page.page), [1, 3, 5]);
  assert.deepEqual(extracted.paragraphs[0].bbox, [50, 680, 190, 32]);
  const text = extracted.paragraphs.map((item) => item.original).join(" ");
  assert.match(text, /UNIQUE_PAGE_1/);
  assert.doesNotMatch(text, /UNIQUE_PAGE_2/);
  assert.equal(extracted.paragraphs.every((item) => /^[a-f0-9]{64}$/.test(item.paragraph_hash)), true);
});

test("跨页结构块只保留当前选中页的文字和坐标", async () => {
  const sdt = mockSDT(2);
  const reader = await sdt.getReader(1, {});
  reader.getPageBlocks = async () => [{
    type: "paragraph",
    anchor: { pageRects: [[0, 10, 20, 100, 40], [1, 10, 700, 120, 730]] },
    content: [
      textNode("FIRST PAGE", 0, [10, 20, 100, 40]),
      textNode("SECOND PAGE", 1, [10, 700, 120, 730]),
    ],
  }];
  sdt.getReader = async () => reader;
  const extracted = await extractSelectedPages(sdt, 1, [2]);
  assert.equal(extracted.paragraphs[0].original, "SECOND PAGE");
  assert.deepEqual(extracted.paragraphs[0].bbox, [10, 700, 110, 30]);
});

test("跳过表格和图像内容但保留图注与表注", async () => {
  const sdt = mockSDT(1);
  const reader = await sdt.getReader(1, {});
  const block = (type, text, rect) => ({
    type,
    anchor: { pageRects: [[0, ...rect]] },
    content: [textNode(text, 0, rect)],
  });
  reader.getPageBlocks = async () => [
    { type: "table", content: [block("paragraph", "TABLE_VALUE_123", [20, 300, 580, 650])] },
    { type: "image", content: [block("paragraph", "IMAGE_OCR_LABEL", [20, 80, 580, 290])] },
    block("caption", "Table 1. Comparison of methods.", [30, 660, 560, 690]),
    block("paragraph", "Normal body paragraph.", [40, 710, 550, 745]),
  ];
  sdt.getReader = async () => reader;
  const extracted = await extractSelectedPages(sdt, 1, [1]);
  assert.deepEqual(extracted.paragraphs.map((item) => item.original), [
    "Table 1. Comparison of methods.", "Normal body paragraph.",
  ]);
  assert.deepEqual(extracted.paragraphs.map((item) => item.block_type), ["caption", "paragraph"]);
});

test("缺少 Zotero SDT 接口时一次性给出明确兼容错误", async () => {
  await assert.rejects(
    () => extractSelectedPages({}, 1, [1]),
    /Zotero 10\.0\.2/,
  );
});

test("SDT 解析失败时保留根因，不再误报 getTextContent", async () => {
  const sdt = { getReader: async () => { throw new Error("worker failed"); } };
  await assert.rejects(
    () => extractSelectedPages(sdt, 1, [1]),
    /Zotero 无法提取 PDF 结构化文本：worker failed/,
  );
});
