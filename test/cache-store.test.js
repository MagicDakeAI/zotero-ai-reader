import test from "node:test";
import assert from "node:assert/strict";
import { CacheStore } from "../plugin-src/service.js";

function memoryIO() {
  const files = new Map();
  return {
    files,
    async makeDirectory() {},
    async writeUTF8(path, value) { files.set(path, value); },
    async readUTF8(path) {
      if (!files.has(path)) {
        const error = new Error("not found");
        error.name = "NotFoundError";
        throw error;
      }
      return files.get(path);
    },
    async move(from, to) { files.set(to, files.get(from)); files.delete(from); },
  };
}

const path = { join: (...parts) => parts.join("/") };
const page = (number = 1) => ({ page: number, width: 100, height: 200 });
const paragraph = (number = 1, translation = "译文") => ({
  paragraph_id: `p${number}`, page: number, paragraph_hash: `hash-${number}`,
  bbox: [10, 20, 30, 40], page_width: 100, page_height: 200,
  block_type: "paragraph", original: `text ${number}`,
  translation, summary: `摘要 ${number}`, processing_status: "completed",
});

function snapshot(items, options = {}) {
  const pages = [...new Set(items.map((item) => item.page))];
  return {
    updated_pages: pages,
    pages: pages.map(page),
    layout_paragraphs: items,
    paragraphs: Object.fromEntries(items.map((item) => [item.paragraph_id, item])),
    model: "deepseek-flash",
    ...options,
  };
}

test("v2 缓存按 PDF 哈希原子保存，并用当前提取坐标复用旧译文", async () => {
  const io = memoryIO();
  const store = new CacheStore({ cacheDir: "/cache", io, path });
  await store.save("pdf-hash", "KEY-A", snapshot([paragraph()]));
  const loaded = await store.load("pdf-hash");
  const current = { ...paragraph(), bbox: [1, 2, 3, 4] };
  const reused = store.reusable(loaded, current);
  assert.equal(reused.translation, "译文");
  assert.deepEqual(reused.bbox, [1, 2, 3, 4]);
  assert.equal(loaded.stats.translatedParagraphs, 1);
  assert.ok(io.files.has("/cache/v2/pdf-hash.json"));
  assert.equal([...io.files.keys()].some((file) => file.endsWith(".tmp")), false);
});

test("缓存文件名不依赖 item key，并发保存不同页面不会互相覆盖", async () => {
  const io = memoryIO();
  const store = new CacheStore({ cacheDir: "/cache", io, path });
  await Promise.all([
    store.save("same-pdf", "KEY-A", snapshot([paragraph(1)])),
    store.save("same-pdf", "KEY-B", snapshot([paragraph(2)])),
  ]);
  const loaded = await store.load("same-pdf");
  const document = await store.loadDocument("same-pdf");
  assert.deepEqual(loaded.selected_pages, [1, 2]);
  assert.equal(loaded.stats.translatedParagraphs, 2);
  assert.deepEqual(document.attachment_refs.map((item) => item.item_key), ["KEY-A", "KEY-B"]);
  assert.deepEqual([...io.files.keys()], ["/cache/v2/same-pdf.json"]);
});

test("v4 与 v6 旧缓存无损迁移，提示词版本不再影响复用", async () => {
  const io = memoryIO();
  const store = new CacheStore({ cacheDir: "/cache", io, path });
  const v4Paragraph = paragraph(1, "v4 译文");
  const v6Paragraph = paragraph(2, "v6 译文");
  const migrated = await store.migrate("pdf-hash", [
    {
      source: "v1:v4.json", itemKey: "OLD-A",
      data: { schema_version: 1, prompt_version: "zh-academic-v4-deepseek-flash", target_language: "zh-CN", selected_pages: [1], pages: [page(1)], paragraphs: { p1: v4Paragraph } },
    },
    {
      source: "v1:v6.json", itemKey: "OLD-B",
      data: { schema_version: 1, prompt_version: "zh-academic-v6-safe-math-protocol", target_language: "zh-CN", selected_pages: [2], pages: [page(2)], paragraphs: { p2: v6Paragraph } },
    },
  ]);
  assert.equal(store.reusable(migrated, v4Paragraph).translation, "v4 译文");
  assert.equal(store.reusable(migrated, v6Paragraph).translation, "v6 译文");
  assert.deepEqual(migrated.stats.migratedFrom, ["v1:v4.json", "v1:v6.json"]);
  const document = await store.loadDocument("pdf-hash");
  assert.equal(document.entries["hash-1"].translations["zh-CN"].revisions[0].prompt_version, "zh-academic-v4-deepseek-flash");
});

test("强制重译追加修订，失败保存不会删除上一个有效版本", async () => {
  const io = memoryIO();
  const store = new CacheStore({ cacheDir: "/cache", io, path });
  await store.save("pdf-hash", "KEY", snapshot([paragraph(1, "旧译文")]));
  await store.save("pdf-hash", "KEY", snapshot([paragraph(1, "新译文")], { force_retranslate: true, operation_id: "force-job" }));
  await store.save("pdf-hash", "KEY", snapshot([paragraph(1, "新译文")], { force_retranslate: true, operation_id: "force-job" }));
  let document = await store.loadDocument("pdf-hash");
  let target = document.entries["hash-1"].translations["zh-CN"];
  assert.equal(target.revisions.length, 2);
  assert.equal(target.revisions.find((item) => item.id === target.active_revision_id).translation, "新译文");

  await store.save("pdf-hash", "KEY", {
    ...snapshot([paragraph(1)]), paragraphs: {}, force_retranslate: true, operation_id: "force-job",
  });
  document = await store.loadDocument("pdf-hash");
  target = document.entries["hash-1"].translations["zh-CN"];
  assert.equal(target.revisions.length, 2);
  assert.equal(target.revisions.find((item) => item.id === target.active_revision_id).translation, "新译文");
});

test("损坏的 v2 缓存会阻止读取和覆盖，并保留原文件", async () => {
  const io = memoryIO();
  const store = new CacheStore({ cacheDir: "/cache", io, path });
  io.files.set("/cache/v2/broken.json", "{invalid-json");
  await assert.rejects(() => store.load("broken"), (error) => error.code === "CACHE_CORRUPT");
  await assert.rejects(() => store.save("broken", "KEY", snapshot([paragraph()])), (error) => error.code === "CACHE_CORRUPT");
  assert.equal(io.files.get("/cache/v2/broken.json"), "{invalid-json");
});

test("不存在的缓存返回 null", async () => {
  const store = new CacheStore({ cacheDir: "/cache", io: memoryIO(), path });
  assert.equal(await store.load("missing"), null);
});
