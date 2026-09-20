import test from "node:test";
import assert from "node:assert/strict";
import { classifySkippedParagraphs } from "../plugin-src/core.js";
import { JobManager } from "../plugin-src/service.js";

async function waitFor(manager, id) {
  for (let count = 0; count < 100; count += 1) {
    const job = manager.getJob(id);
    if (!["queued", "running"].includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("测试任务超时");
}

class FakeCache {
  constructor() { this.data = null; }
  async load() { return this.data; }
  async save(sourceHash, itemKey, data) {
    this.data = {
      schema_version: 1, pdf_hash: sourceHash, zotero_item_key: itemKey,
      prompt_version: "zh-academic-v4-deepseek-flash", target_language: "zh-CN", ...data,
    };
    return this.data;
  }
  reusable(cache, paragraph) {
    return Object.values(cache?.paragraphs || {}).find((item) =>
      item.paragraph_hash === paragraph.paragraph_hash && item.processing_status === "completed",
    ) || null;
  }
}

const config = () => ({ model: "deepseek-flash", maxBatchChars: 1000, concurrency: 2 });
const baseParagraph = (index = 1) => ({
  paragraph_id: `p0001-00${index}`, page: 1, bbox: [10, 20, 30, 40],
  page_width: 100, page_height: 100, original: `Paragraph ${index} ${"x".repeat(800)}`,
  paragraph_hash: `hash-${index}`,
});
const request = { itemID: 1, itemKey: "KEY", sourceHash: "pdf-hash", pages: [1] };

function managerWith({ cache = new FakeCache(), paragraphs = [baseParagraph()], translator, extract } = {}) {
  let id = 0;
  return new JobManager({
    cache,
    translator: translator || { translate: async (batch) => batch.map((item) => ({
      ...item, translation: "译文", summary: "摘要", processing_status: "completed",
    })) },
    configProvider: config,
    extract: extract || (async (_itemID, _pages, { onPage }) => {
      onPage?.({ current: 1, total: 1, page: 1 });
      return { pages: [{ page: 1, width: 100, height: 100 }], paragraphs };
    }),
    uuid: () => `job-${++id}`,
  });
}

test("第二次处理相同段落时模型调用与 Token 均为 0", async () => {
  const cache = new FakeCache();
  let calls = 0;
  const manager = managerWith({
    cache,
    translator: { translate: async (batch) => {
      calls += 1;
      return batch.map((item) => ({ ...item, translation: "译文", summary: "摘要", processing_status: "completed" }));
    } },
  });
  const first = await waitFor(manager, manager.createJob(request).id);
  const second = await waitFor(manager, manager.createJob(request).id);
  assert.equal(first.status, "completed");
  assert.equal(second.status, "completed");
  assert.equal(second.modelCallCount, 0);
  assert.equal(second.tokenUsage.totalTokens, 0);
  assert.equal(second.paragraphCached, 1);
  assert.equal(calls, 1);
});

test("部分命中本地缓存时只请求未命中段落", async () => {
  const cache = new FakeCache();
  const first = baseParagraph(1);
  cache.data = {
    prompt_version: "zh-academic-v4-deepseek-flash",
    target_language: "zh-CN",
    paragraphs: {
      cached: { ...first, translation: "已有译文", summary: "已有摘要", processing_status: "completed" },
    },
  };
  const requested = [];
  const manager = managerWith({
    cache,
    paragraphs: [first, baseParagraph(2)],
    translator: { translate: async (batch) => {
      requested.push(...batch.map((item) => item.paragraph_id));
      return batch.map((item) => ({ ...item, translation: "新译文", summary: "新摘要", processing_status: "completed" }));
    } },
  });
  const job = await waitFor(manager, manager.createJob(request).id);
  assert.deepEqual(requested, [baseParagraph(2).paragraph_id]);
  assert.equal(job.localCacheHits, 1);
  assert.equal(job.paragraphTranslated, 1);
});

test("普通任务永久复用旧版本缓存，只有强制重译才再次调用模型", async () => {
  const cache = new FakeCache();
  const existing = baseParagraph(1);
  cache.data = {
    prompt_version: "historic-prompt",
    target_language: "zh-CN",
    paragraphs: {
      cached: { ...existing, translation: "旧译文", summary: "旧摘要", processing_status: "completed" },
    },
  };
  const requested = [];
  const manager = managerWith({
    cache,
    translator: { translate: async (batch) => {
      requested.push(...batch.map((item) => item.paragraph_id));
      return batch.map((item) => ({ ...item, translation: "新译文", summary: "新摘要", processing_status: "completed" }));
    } },
  });
  const normal = await waitFor(manager, manager.createJob(request).id);
  assert.equal(normal.modelCallCount, 0);
  assert.deepEqual(requested, []);

  const forced = await waitFor(manager, manager.createJob({ ...request, forceRetranslate: true }).id);
  assert.equal(forced.modelCallCount, 1);
  assert.deepEqual(requested, [existing.paragraph_id]);
});

test("聚合请求次数、Token 和逐页进度", async () => {
  const manager = managerWith({
    translator: { translate: async (batch, { onEvent }) => {
      onEvent({ type: "request.started" });
      onEvent({ type: "response.received", usage: {
        promptTokens: 100, completionTokens: 50, totalTokens: 150,
        cacheHitTokens: 64, cacheMissTokens: 36, reasoningTokens: 0,
      } });
      return batch.map((item) => ({ ...item, translation: "译文", summary: "摘要", processing_status: "completed" }));
    } },
  });
  const job = await waitFor(manager, manager.createJob(request).id);
  assert.equal(job.pageCurrent, 1);
  assert.equal(job.apiRequestCount, 1);
  assert.equal(job.paragraphTranslated, 1);
  assert.equal(job.tokenUsage.totalTokens, 150);
  assert.equal(job.tokenUsage.cacheHitTokens, 64);
});

test("任务状态分开统计重试 Token 且审计记录不含正文", async () => {
  const manager = managerWith({
    translator: { translate: async (batch, { onEvent, batchIndex }) => {
      const audit = {
        batchIndex, requestIndex: 1, paragraphIds: batch.map((item) => item.paragraph_id),
        paragraphCount: batch.length, sourceChars: 812, requestHash: "a".repeat(64),
        isRetry: true, retryReason: "http_429",
      };
      onEvent({ type: "request.started", audit });
      onEvent({ type: "response.received", audit, finishReason: "stop", usage: {
        promptTokens: 20, completionTokens: 10, totalTokens: 30,
        cacheHitTokens: 0, cacheMissTokens: 20, reasoningTokens: 0,
      } });
      return batch.map((item) => ({ ...item, translation: "译文", summary: "摘要", processing_status: "completed" }));
    } },
  });
  const job = await waitFor(manager, manager.createJob(request).id);
  assert.equal(job.retryTokenUsage.totalTokens, 30);
  assert.equal(job.requestAudits.length, 1);
  assert.equal(job.requestAudits[0].usage.totalTokens, 30);
  assert.doesNotMatch(JSON.stringify(job.requestAudits), /Paragraph 1/);
});

test("批次最多两路并发", async () => {
  let active = 0;
  let maxActive = 0;
  const manager = managerWith({
    paragraphs: [baseParagraph(1), baseParagraph(2), baseParagraph(3)],
    translator: { translate: async (batch) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
      return batch.map((item) => ({ ...item, translation: "译文", summary: "摘要", processing_status: "completed" }));
    } },
  });
  const job = await waitFor(manager, manager.createJob(request).id);
  assert.equal(job.batchTotal, 3);
  assert.equal(maxActive, 2);
});

test("失败批次计入已处理进度并进入部分成功", async () => {
  const manager = managerWith({
    paragraphs: [baseParagraph(1), baseParagraph(2)],
    translator: { translate: async () => { throw new Error("模型暂时不可用"); } },
  });
  const job = await waitFor(manager, manager.createJob(request).id);
  assert.equal(job.status, "partial");
  assert.equal(job.paragraphFailed, 2);
  assert.equal(job.paragraphCurrent, job.paragraphTotal);
});

test("提取阶段可以取消", async () => {
  const manager = managerWith({
    extract: async (_itemID, _pages, { signal }) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      if (signal.aborted) throw new Error("任务已取消");
      return { pages: [], paragraphs: [] };
    },
  });
  const created = manager.createJob(request);
  manager.cancelJob(created.id);
  const job = await waitFor(manager, created.id);
  assert.equal(job.status, "cancelled");
});

test("仅跳过边缘纯页码和至少三页重复页眉", () => {
  const paragraphs = [];
  for (let page = 1; page <= 3; page += 1) {
    paragraphs.push({ paragraph_id: `h-${page}`, page, original: "Conference Header", bbox: [10, 95, 80, 4], page_height: 100 });
    paragraphs.push({ paragraph_id: `b-${page}`, page, original: "Repeated body", bbox: [10, 40, 80, 10], page_height: 100 });
  }
  paragraphs.push({ paragraph_id: "page", page: 1, original: "12", bbox: [45, 2, 10, 4], page_height: 100 });
  paragraphs.push({ paragraph_id: "year", page: 1, original: "2024", bbox: [45, 45, 10, 4], page_height: 100 });
  const skipped = classifySkippedParagraphs(paragraphs);
  assert.equal(skipped.get("h-1"), "skipped_boilerplate");
  assert.equal(skipped.get("page"), "skipped_boilerplate");
  assert.equal(skipped.has("b-1"), false);
  assert.equal(skipped.has("year"), false);
});
