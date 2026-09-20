var AIReaderService = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // plugin-src/service.js
  var service_exports = {};
  __export(service_exports, {
    CacheStore: () => CacheStore,
    DeepSeekClient: () => DeepSeekClient,
    JobManager: () => JobManager,
    SecretStore: () => SecretStore,
    cancelJob: () => cancelJob,
    clearAPIKey: () => clearAPIKey,
    configureAPIKey: () => configureAPIKey,
    createAbortController: () => createAbortController,
    createJob: () => createJob,
    detectTranslationRange: () => detectTranslationRange,
    getAPIKeyStatus: () => getAPIKeyStatus,
    getJob: () => getJob,
    getSettings: () => getSettings,
    init: () => init,
    normalizeTranslationFontSize: () => normalizeTranslationFontSize,
    parseModelJson: () => parseModelJson,
    restore: () => restore,
    retryJob: () => retryJob,
    saveSettings: () => saveSettings,
    shutdown: () => shutdown,
    testAPIKey: () => testAPIKey
  });

  // plugin-src/core.js
  function parsePageRange(input, totalPages) {
    if (!Number.isInteger(totalPages) || totalPages < 1) throw new RangeError("PDF \u603B\u9875\u6570\u65E0\u6548");
    const text = String(input || "").trim();
    if (!text) throw new TypeError("\u8BF7\u8F93\u5165\u9875\u7801");
    const pages = /* @__PURE__ */ new Set();
    for (const rawPart of text.split(",")) {
      const part = rawPart.trim();
      if (!part) throw new TypeError("\u9875\u7801\u683C\u5F0F\u9519\u8BEF");
      const match = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(part);
      if (!match) throw new TypeError(`\u9875\u7801\u683C\u5F0F\u9519\u8BEF\uFF1A${part}`);
      const start = Number(match[1]);
      const end = Number(match[2] || match[1]);
      if (start < 1 || end < 1 || start > end) throw new RangeError(`\u9875\u7801\u8303\u56F4\u65E0\u6548\uFF1A${part}`);
      if (end > totalPages) throw new RangeError(`\u9875\u7801\u8D85\u51FA PDF \u8303\u56F4\uFF1A${part}`);
      for (let page = start; page <= end; page += 1) pages.add(page);
    }
    return [...pages].sort((a, b) => a - b);
  }
  function createBatches(paragraphs, maxChars = 7e3, maxItems = 8) {
    if (!Number.isFinite(maxChars) || maxChars < 1e3) throw new RangeError("maxChars \u592A\u5C0F");
    if (!Number.isInteger(maxItems) || maxItems < 1) throw new RangeError("maxItems \u65E0\u6548");
    const batches = [];
    let current = [];
    let size = 0;
    for (const paragraph of paragraphs) {
      const cost = paragraph.original.length + 160;
      if (current.length && (size + cost > maxChars || current.length >= maxItems)) {
        batches.push(current);
        current = [];
        size = 0;
      }
      current.push(paragraph);
      size += cost;
    }
    if (current.length) batches.push(current);
    return batches;
  }
  function buildTranslationPrompt(paragraphs) {
    const items = paragraphs.map((paragraph) => ({ id: paragraph.paragraph_id, text: paragraph.original }));
    return [
      "\u7FFB\u8BD1 JSON \u4E2D\u6BCF\u4E2A items \u5143\u7D20\u7684 text \u4E3A\u81EA\u7136\u3001\u5B8C\u6574\u7684\u4E2D\u6587\u5B66\u672F\u8BD1\u6587\u3002",
      "\u6570\u5B66\u516C\u5F0F\u3001\u53D8\u91CF\u53CA\u5176\u4E0A\u4E0B\u6807\u5FC5\u987B\u6309\u539F\u6587\u5B8C\u6574\u4FDD\u7559\u3002\u8F93\u51FA\u4E2D\u6BCF\u4E2A\u516C\u5F0F\u7528 [[math:...]] \u5305\u56F4\uFF0C\u5E76\u628A LaTeX \u547D\u4EE4\u7684\u53CD\u659C\u6760\u6539\u7528 \xA7 \u4EE3\u66FF\u3002",
      "\u7EAF\u6570\u5B57\u65B9\u62EC\u53F7\u6587\u732E\u5F15\u7528\u5FC5\u987B\u4F5C\u4E3A\u666E\u901A\u6587\u672C\u539F\u6837\u4FDD\u7559\uFF0C\u7981\u6B62\u7F6E\u5165 [[math:...]]\u3002\u4F8B\u5982 [40]\u3001[17, 24, 31]\u3001[17-24]\u3001[17\u201324, 31] \u90FD\u662F\u5F15\u6587\uFF0C\u4E0D\u662F\u6570\u5B66\u516C\u5F0F\u3002",
      "\u4F5C\u8005\u2014\u5E74\u4EFD\u5F15\u7528\u3001\u5B64\u7ACB\u6570\u5B57\u4E0A\u6807\u5F15\u7528\u3001\u56FE\u8868/\u7AE0\u8282/\u7B97\u6CD5/\u9644\u5F55/\u65B9\u7A0B\u7F16\u53F7\uFF0C\u4EE5\u53CA URL\u3001DOI\u3001\u90AE\u7BB1\u548C\u6587\u4EF6\u540D\u4E5F\u5FC5\u987B\u4F5C\u4E3A\u666E\u901A\u6587\u672C\u4FDD\u7559\uFF0C\u7981\u6B62\u7F6E\u5165 [[math:...]]\u3002\u4F8B\u5982 (Smith et al., 2024)\u3001Fig. 2\u3001Table S1\u3001Section 3.1\u3001Eq. (4)\u3001https://example.com \u548C 10.1000/example \u90FD\u4E0D\u662F\u516C\u5F0F\u3002",
      "\u4F8B\u5982\uFF1A[[math:x \xA7sim f(x)]]\u3001[[math:\xA7mathcal{D}=\xA7{(x_i,y_i)\xA7}_{i=1}^{N}]]\u3001[[math:\xA7tilde{x}_i=x_i+\xA7xi_i]]\u3002\u8FD9\u662F\u4E3A\u4E86\u907F\u514D JSON \u53CD\u659C\u6760\u8F6C\u4E49\u5931\u8D25\u3002",
      "\u8FD4\u56DE\u7684 t \u548C s \u4E2D\u7981\u6B62\u51FA\u73B0\u53CD\u659C\u6760\u5B57\u7B26\u3002\u4E0D\u5F97\u628A \xA7sim \u6539\u6210\u5192\u53F7\uFF0C\u4E0D\u5F97\u5220\u9664\u96C6\u5408\u62EC\u53F7\u3001\u4E0A\u4E0B\u6807\u3001\u5E0C\u814A\u5B57\u6BCD\u6216\u91CD\u97F3\u7B26\u53F7\uFF1B\u516C\u5F0F\u5916\u7684\u6587\u5B57\u624D\u7FFB\u8BD1\u4E3A\u4E2D\u6587\u3002",
      '\u8FD4\u56DE\u4EC5\u542B results \u7684 JSON\uFF1A{"results":[{"id":"\u8F93\u5165 id","t":"\u8BD1\u6587","s":"\u4E0D\u8D85\u8FC740\u4E2A\u6C49\u5B57\u7684\u6458\u8981"}]}\u3002',
      "id \u5FC5\u987B\u4E0E\u8F93\u5165\u4E00\u81F4\uFF1B\u4E0D\u5F97\u9057\u6F0F\u3001\u5408\u5E76\u6216\u62C6\u5206\u3002\u7EAF\u53C2\u8003\u6587\u732E\u7684 t\u3001s \u5747\u4E3A\u7A7A\u5B57\u7B26\u4E32\u3002",
      "\u7981\u6B62\u56DE\u4F20 text\u3001\u7981\u6B62 Markdown \u6216\u4EFB\u4F55\u989D\u5916\u5B57\u6BB5\u3002",
      JSON.stringify({ items })
    ].join("\n");
  }
  function getJsonShape(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return typeof value;
    return `\u5BF9\u8C61\u5B57\u6BB5\uFF1A${Object.keys(value).slice(0, 12).join(", ") || "\uFF08\u7A7A\uFF09"}`;
  }
  function classifySkippedParagraphs(paragraphs) {
    const skipped = /* @__PURE__ */ new Map();
    let referencesFromPage = null;
    for (const paragraph of paragraphs) {
      const text = paragraph.original.replace(/\s+/g, " ").trim();
      if (/^(references|bibliography|参考文献)$/i.test(text)) {
        referencesFromPage = paragraph.page;
        skipped.set(paragraph.paragraph_id, "skipped_reference");
      } else if (referencesFromPage !== null && paragraph.page >= referencesFromPage) {
        skipped.set(paragraph.paragraph_id, "skipped_reference");
      }
    }
    const edgeText = /* @__PURE__ */ new Map();
    for (const paragraph of paragraphs) {
      const text = paragraph.original.replace(/\s+/g, " ").trim();
      if (!text || text.length > 160) continue;
      const [, y, , height] = paragraph.bbox || [];
      const pageHeight = Number(paragraph.page_height);
      if (!Number.isFinite(y) || !Number.isFinite(height) || !pageHeight) continue;
      const atEdge = y <= pageHeight * 0.1 || y + height >= pageHeight * 0.9;
      if (!atEdge) continue;
      if (/^(?:page\s*)?\d+(?:\s*\/\s*\d+)?$/i.test(text)) {
        skipped.set(paragraph.paragraph_id, "skipped_boilerplate");
        continue;
      }
      const key = text.toLocaleLowerCase();
      const entries = edgeText.get(key) || [];
      entries.push(paragraph);
      edgeText.set(key, entries);
    }
    for (const entries of edgeText.values()) {
      if (new Set(entries.map((item) => item.page)).size < 3) continue;
      for (const paragraph of entries) {
        if (!skipped.has(paragraph.paragraph_id)) skipped.set(paragraph.paragraph_id, "skipped_boilerplate");
      }
    }
    return skipped;
  }
  function isReferenceHeading(value) {
    const text = String(value || "").replace(/\s+/g, " ").replace(/^\s*(?:\d+(?:\.\d+)*[.)]?|[ivxlcdm]+[.)])\s*/i, "").trim();
    return /^(?:references?|bibliography|works cited|literature cited)$/i.test(text);
  }
  function isMeaningfulBeforeReference(paragraph, skipped) {
    const text = String(paragraph.original || "").replace(/\s+/g, " ").trim();
    if (!text || /^(?:page\s*)?\d+(?:\s*\/\s*\d+)?$/i.test(text)) return false;
    if (skipped.get(paragraph.paragraph_id) === "skipped_boilerplate") return false;
    const [, y, , height] = paragraph.bbox || [];
    const pageHeight = Number(paragraph.page_height);
    const atEdge = Number.isFinite(y) && Number.isFinite(height) && pageHeight > 0 && (y <= pageHeight * 0.1 || y + height >= pageHeight * 0.9);
    return !(atEdge && text.length <= 160);
  }
  function detectMainTextRange(paragraphs, totalPages) {
    if (!Number.isInteger(totalPages) || totalPages < 1) throw new RangeError("PDF \u603B\u9875\u6570\u65E0\u6548");
    const ordered = [...paragraphs || []];
    const candidates = ordered.filter((paragraph) => isReferenceHeading(paragraph.original));
    if (!candidates.length) return { found: false, pageRange: `1-${totalPages}`, endPage: totalPages };
    const heading = candidates.at(-1);
    const headingIndex = ordered.indexOf(heading);
    const skipped = classifySkippedParagraphs(ordered);
    const hasBodyBefore = ordered.slice(0, headingIndex).some((paragraph) => paragraph.page === heading.page && isMeaningfulBeforeReference(paragraph, skipped));
    const endPage = Math.max(1, hasBodyBefore ? heading.page : heading.page - 1);
    return {
      found: true,
      pageRange: endPage === 1 ? "1" : `1-${endPage}`,
      endPage,
      referencePage: heading.page,
      referencesStartOnNewPage: !hasBodyBefore
    };
  }

  // plugin-src/pdf-extractor.js
  function cleanText(value) {
    return String(value || "").replace(/\u00ad/g, "").replace(/\s+/g, " ").replace(/\s+([,.;:!?])/g, "$1").trim();
  }
  function finiteRect(rect) {
    return Array.isArray(rect) && rect.length >= 5 && rect.slice(0, 5).every(Number.isFinite);
  }
  function collectPageRects(node, pageIndex, output = []) {
    const rects = node?.anchor?.pageRects;
    if (Array.isArray(rects)) {
      for (const rect of rects) {
        if (finiteRect(rect) && rect[0] === pageIndex) output.push(rect);
      }
    }
    if (Array.isArray(node?.content)) {
      for (const child of node.content) collectPageRects(child, pageIndex, output);
    }
    return output;
  }
  function textNodeBelongsToPage(node, pageIndex) {
    const encoded = node?.anchor?.textMap;
    if (typeof encoded !== "string") return true;
    try {
      const runs = JSON.parse(encoded);
      return !Array.isArray(runs) || !runs.length || runs.some((run) => Array.isArray(run) && run[1] === pageIndex);
    } catch {
      return true;
    }
  }
  function collectText(node, pageIndex, output = []) {
    if (!node || typeof node !== "object") return output;
    if (typeof node.text === "string") {
      if (textNodeBelongsToPage(node, pageIndex)) output.push(node.text);
      return output;
    }
    if (Array.isArray(node.content)) {
      for (const child of node.content) collectText(child, pageIndex, output);
    }
    return output;
  }
  function unionPageRects(rects, viewRect) {
    if (!rects.length) return null;
    const left = Math.min(...rects.map((rect) => rect[1]));
    const bottom = Math.min(...rects.map((rect) => rect[2]));
    const right = Math.max(...rects.map((rect) => rect[3]));
    const top = Math.max(...rects.map((rect) => rect[4]));
    const originX = Number(viewRect?.[0]) || 0;
    const originY = Number(viewRect?.[1]) || 0;
    return [left - originX, bottom - originY, right - left, top - bottom].map((number) => Math.round(number * 100) / 100);
  }
  function pageSize(page) {
    const rect = page?.viewRect;
    if (!Array.isArray(rect) || rect.length !== 4 || !rect.every(Number.isFinite)) {
      throw new Error("\u7ED3\u6784\u5316\u6587\u6863\u7F3A\u5C11\u6709\u6548\u7684\u9875\u9762\u5C3A\u5BF8");
    }
    const width = Math.abs(rect[2] - rect[0]);
    const height = Math.abs(rect[3] - rect[1]);
    if (!width || !height) throw new Error("\u7ED3\u6784\u5316\u6587\u6863\u7684\u9875\u9762\u5C3A\u5BF8\u65E0\u6548");
    return { width, height };
  }
  var TEXT_BLOCK_TYPES = /* @__PURE__ */ new Set([
    "paragraph",
    "heading",
    "caption",
    "note",
    "listitem",
    "preformatted",
    "math"
  ]);
  var VISUAL_BLOCK_TYPES = /* @__PURE__ */ new Set(["image", "table"]);
  function collectTextBlocks(nodes, pageIndex, output = []) {
    for (const node of nodes || []) {
      if (!node || typeof node !== "object") continue;
      if (VISUAL_BLOCK_TYPES.has(node.type)) continue;
      const text = cleanText(collectText(node, pageIndex).join(" "));
      const rects = collectPageRects(node, pageIndex);
      if (TEXT_BLOCK_TYPES.has(node.type) && text && rects.length) {
        output.push({ text, rects, type: node.type });
        continue;
      }
      if (Array.isArray(node.content)) collectTextBlocks(node.content, pageIndex, output);
    }
    return output;
  }
  async function hashText(text, cryptoImpl = globalThis.crypto) {
    if (!cryptoImpl?.subtle) throw new Error("\u5F53\u524D Zotero \u73AF\u5883\u4E0D\u652F\u6301 Web Crypto");
    const bytes = new TextEncoder().encode(text);
    const digest = await cryptoImpl.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  async function extractSelectedPages(sdt, itemID, selectedPages, {
    onPage,
    onPrepareProgress,
    signal,
    cryptoImpl
  } = {}) {
    if (typeof sdt?.getReader !== "function") {
      throw new Error("\u5F53\u524D Zotero \u7248\u672C\u7F3A\u5C11\u7ED3\u6784\u5316 PDF \u63D0\u53D6\u63A5\u53E3\uFF0C\u8BF7\u5347\u7EA7\u5230 Zotero 10.0.2 \u6216\u66F4\u9AD8\u7248\u672C");
    }
    if (signal?.aborted) throw new Error("\u4EFB\u52A1\u5DF2\u53D6\u6D88");
    let reader;
    try {
      reader = await sdt.getReader(itemID, {
        isPriority: true,
        onProgress: (percent) => {
          if (!signal?.aborted && Number.isFinite(percent)) onPrepareProgress?.(percent);
        }
      });
    } catch (error) {
      throw new Error(`Zotero \u65E0\u6CD5\u63D0\u53D6 PDF \u7ED3\u6784\u5316\u6587\u672C\uFF1A${error?.message || error}`);
    }
    if (signal?.aborted) throw new Error("\u4EFB\u52A1\u5DF2\u53D6\u6D88");
    if (!reader) throw new Error("Zotero \u65E0\u6CD5\u751F\u6210 PDF \u7ED3\u6784\u5316\u6587\u672C");
    const catalog = await reader.getCatalog();
    const catalogPages = Array.isArray(catalog?.pages) ? catalog.pages : [];
    const invalid = selectedPages.filter((page) => page < 1 || page > catalogPages.length);
    if (invalid.length) throw new RangeError(`\u9875\u7801\u8D85\u51FA PDF \u8303\u56F4\uFF1A${invalid.join(",")}`);
    const pages = [];
    const paragraphs = [];
    for (const pageNumber of selectedPages) {
      if (signal?.aborted) throw new Error("\u4EFB\u52A1\u5DF2\u53D6\u6D88");
      const pageIndex = pageNumber - 1;
      const page = catalogPages[pageIndex];
      const size = pageSize(page);
      const blocks = await reader.getPageBlocks(pageIndex);
      const textBlocks = collectTextBlocks(blocks, pageIndex);
      pages.push({ page: pageNumber, width: size.width, height: size.height });
      for (let index = 0; index < textBlocks.length; index += 1) {
        const block = textBlocks[index];
        const bbox = unionPageRects(block.rects, page.viewRect);
        if (!bbox || bbox[2] <= 0 || bbox[3] <= 0) continue;
        paragraphs.push({
          paragraph_id: `p${String(pageNumber).padStart(4, "0")}-${String(index + 1).padStart(3, "0")}`,
          page: pageNumber,
          bbox,
          page_width: size.width,
          page_height: size.height,
          block_type: block.type,
          original: block.text,
          paragraph_hash: await hashText(block.text, cryptoImpl)
        });
      }
      onPage?.({ current: pages.length, total: selectedPages.length, page: pageNumber });
    }
    return { totalPages: catalogPages.length, pages, paragraphs };
  }

  // plugin-src/service.js
  var PLUGIN_ID = "zotero-ai-reader@local";
  var SECRET_ORIGIN = "https://api.deepseek.com";
  var SECRET_REALM = "DeepSeek API Key";
  var PREF_PREFIX = "extensions.zotero-ai-reader.";
  function normalizeTranslationFontSize(value) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 12 && number <= 22 ? Math.round(number) : 16;
  }
  var PROMPT_VERSION = "zh-academic-v6-safe-math-protocol";
  var TARGET_LANGUAGE = "zh-CN";
  function finiteToken(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
  }
  function normalizeUsage(usage) {
    if (!usage || typeof usage !== "object") return null;
    return {
      promptTokens: finiteToken(usage.prompt_tokens),
      completionTokens: finiteToken(usage.completion_tokens),
      totalTokens: finiteToken(usage.total_tokens),
      cacheHitTokens: finiteToken(usage.prompt_cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens),
      cacheMissTokens: finiteToken(usage.prompt_cache_miss_tokens),
      reasoningTokens: finiteToken(usage.completion_tokens_details?.reasoning_tokens)
    };
  }
  function stripJsonFence(text) {
    return String(text || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  }
  function repairInvalidJsonEscapes(value) {
    return value.replace(/\\(?!["\\/bfnrtu])/g, "\\\\");
  }
  function parseModelJson(value) {
    const text = stripJsonFence(value);
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    const candidate = start >= 0 && end > start ? text.slice(start, end + 1) : text;
    try {
      return JSON.parse(candidate);
    } catch (originalError) {
      try {
        return JSON.parse(repairInvalidJsonEscapes(candidate));
      } catch {
        throw originalError;
      }
    }
  }
  function decodeMathProtocol(value) {
    return String(value || "").replace(
      /\[\[math:([\s\S]*?)\]\]/g,
      (_match, latex) => `\\(${latex.replace(/§/g, "\\")}\\)`
    );
  }
  function errorStatus(error) {
    return Number(error?.status || error?.xmlhttp?.status || error?.response?.status || 0);
  }
  function errorDetail(payload) {
    const message = payload?.error?.message || payload?.message;
    return typeof message === "string" ? message.slice(0, 1e3) : "\u8BF7\u6C42\u5931\u8D25";
  }
  function retryable(error) {
    return [408, 429, 500, 502, 503, 504].includes(errorStatus(error)) || error?.name === "TimeoutError";
  }
  async function sha256(value, cryptoImpl = globalThis.crypto) {
    if (!cryptoImpl?.subtle) throw new Error("\u5F53\u524D\u73AF\u5883\u4E0D\u652F\u6301 Web Crypto");
    const bytes = new TextEncoder().encode(String(value));
    const digest = await cryptoImpl.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  function inspectTranslationResults(source, results) {
    if (!Array.isArray(results)) return { valid: [], invalid: source };
    const occurrences = /* @__PURE__ */ new Map();
    for (const item of results) {
      if (!item || typeof item.id !== "string") continue;
      occurrences.set(item.id, [...occurrences.get(item.id) || [], item]);
    }
    const valid = [];
    const invalid = [];
    for (const paragraph of source) {
      const matches = occurrences.get(paragraph.paragraph_id) || [];
      const item = matches.length === 1 ? matches[0] : null;
      if (!item || typeof item.t !== "string" || typeof item.s !== "string") {
        invalid.push(paragraph);
        continue;
      }
      const translation = decodeMathProtocol(item.t.trim());
      const summary = decodeMathProtocol(item.s.trim());
      valid.push({
        ...paragraph,
        translation,
        summary,
        processing_status: translation || summary ? "completed" : "skipped_reference"
      });
    }
    return { valid, invalid };
  }
  function delay(ms, signal) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new Error("\u4EFB\u52A1\u5DF2\u53D6\u6D88"));
      }, { once: true });
    });
  }
  function createAbortController(Controller = globalThis.AbortController || globalThis.Zotero?.getMainWindow?.()?.AbortController) {
    if (typeof Controller === "function") return new Controller();
    const listeners = /* @__PURE__ */ new Set();
    const signal = {
      aborted: false,
      addEventListener(type, listener) {
        if (type !== "abort" || typeof listener !== "function") return;
        listeners.add(listener);
      },
      removeEventListener(type, listener) {
        if (type === "abort") listeners.delete(listener);
      }
    };
    return {
      signal,
      abort() {
        if (signal.aborted) return;
        signal.aborted = true;
        for (const listener of [...listeners]) listener.call(signal, { type: "abort", target: signal });
        listeners.clear();
      }
    };
  }
  var SecretStore = class {
    constructor({ logins, createLoginInfo: createLoginInfo2 }) {
      this.logins = logins;
      this.createLoginInfo = createLoginInfo2;
    }
    async find() {
      const matches = await this.logins.searchLoginsAsync({
        origin: SECRET_ORIGIN,
        httpRealm: SECRET_REALM
      });
      return matches.find((login) => login.username === PLUGIN_ID) || null;
    }
    async get() {
      return (await this.find())?.password || "";
    }
    async status() {
      const key = await this.get();
      return { configured: Boolean(key), masked: key ? `\u2022\u2022\u2022\u2022${key.slice(-4)}` : "" };
    }
    async set(key) {
      const value = String(key || "").trim();
      if (!value) throw new Error("\u8BF7\u8F93\u5165 DeepSeek API Key");
      const existing = await this.find();
      const replacement = this.createLoginInfo(SECRET_ORIGIN, null, SECRET_REALM, PLUGIN_ID, value, "", "");
      if (existing) await this.logins.modifyLoginAsync(existing, replacement);
      else await this.logins.addLoginAsync(replacement);
      return this.status();
    }
    async clear() {
      const existing = await this.find();
      if (existing) await this.logins.removeLoginAsync(existing);
      return { configured: false, masked: "" };
    }
  };
  var DeepSeekClient = class {
    constructor({ keyProvider, configProvider, httpRequest }) {
      this.keyProvider = keyProvider;
      this.configProvider = configProvider;
      this.httpRequest = httpRequest;
    }
    async testKey(key) {
      const config = this.configProvider();
      await this.call("GET", `${config.baseUrl}/models`, { key, timeout: 15e3 });
      return true;
    }
    async translate(paragraphs, { signal, onEvent, batchIndex = null } = {}) {
      const key = await this.keyProvider();
      if (!key) {
        const error = new Error("\u5C1A\u672A\u914D\u7F6E DeepSeek API Key\uFF0C\u8BF7\u5148\u5728\u63D2\u4EF6\u8BBE\u7F6E\u4E2D\u586B\u5199");
        error.code = "AUTH_REQUIRED";
        throw error;
      }
      const config = this.configProvider();
      const snapshot = Object.freeze(paragraphs.map((paragraph) => Object.freeze({ ...paragraph })));
      const completed = /* @__PURE__ */ new Map();
      let pending = snapshot;
      let transientAttempt = 0;
      let fullRepairCount = 0;
      let partialRepairCount = 0;
      let retryReason = null;
      let requestIndex = 0;
      for (; ; ) {
        const prompt = buildTranslationPrompt(pending);
        const audit = Object.freeze({
          batchIndex,
          requestIndex: ++requestIndex,
          paragraphIds: pending.map((item) => item.paragraph_id),
          paragraphCount: pending.length,
          sourceChars: pending.reduce((total, item) => total + item.original.length, 0),
          requestHash: await sha256(prompt),
          isRetry: Boolean(retryReason),
          retryReason
        });
        try {
          onEvent?.({ type: "request.started", audit });
          const response = await this.call("POST", `${config.baseUrl}/chat/completions`, {
            key,
            timeout: config.timeoutMs,
            signal,
            body: {
              model: config.model,
              messages: [
                { role: "system", content: "\u4F60\u662F\u4E25\u8C28\u7684\u5B66\u672F\u8BBA\u6587\u7FFB\u8BD1\u5668\u3002\u5FC5\u987B\u53EA\u8F93\u51FA\u6709\u6548 JSON\uFF0C\u4E0D\u8981\u8F93\u51FA Markdown\u3002" },
                { role: "user", content: prompt }
              ],
              thinking: { type: "disabled" },
              temperature: 0.2,
              max_tokens: 8192,
              stream: false,
              response_format: { type: "json_object" }
            }
          });
          const payload = response.payload;
          const choice = payload?.choices?.[0];
          onEvent?.({
            type: "response.received",
            usage: normalizeUsage(payload?.usage),
            finishReason: choice?.finish_reason || null,
            audit
          });
          const content = choice?.message?.content;
          if (typeof content !== "string" || !content.trim()) throw new Error("DeepSeek \u54CD\u5E94\u7F3A\u5C11 choices[0].message.content");
          let parsed;
          try {
            parsed = parseModelJson(content);
          } catch {
            if (fullRepairCount < 1) {
              fullRepairCount += 1;
              retryReason = "invalid_json";
              onEvent?.({ type: "request.retrying", attempt: fullRepairCount, reason: retryReason, audit });
              continue;
            }
            const error = new Error("DeepSeek \u8FD4\u56DE\u7684\u5185\u5BB9\u4E0D\u662F\u6709\u6548 JSON\uFF0C\u5B8C\u6574\u4FEE\u590D\u91CD\u8BD5\u4ECD\u5931\u8D25");
            error.code = "INVALID_MODEL_OUTPUT";
            throw error;
          }
          const inspected = inspectTranslationResults(pending, parsed?.results);
          for (const result of inspected.valid) completed.set(result.paragraph_id, result);
          if (inspected.invalid.length) {
            if (inspected.valid.length && partialRepairCount < 1) {
              partialRepairCount += 1;
              pending = Object.freeze(inspected.invalid);
              transientAttempt = 0;
              retryReason = "partial_output";
              onEvent?.({ type: "request.retrying", attempt: partialRepairCount, reason: retryReason, audit });
              continue;
            }
            if (!inspected.valid.length && fullRepairCount < 1) {
              fullRepairCount += 1;
              retryReason = "invalid_output";
              onEvent?.({ type: "request.retrying", attempt: fullRepairCount, reason: retryReason, audit });
              continue;
            }
            const outputError = new Error(`DeepSeek \u8FD4\u56DE\u7684 JSON \u7ED3\u6784\u4E0D\u7B26\u5408\u9884\u671F\uFF08${getJsonShape(parsed)}\uFF09\uFF1B\u5E94\u5305\u542B results \u6570\u7EC4`);
            outputError.code = "INVALID_MODEL_OUTPUT";
            throw outputError;
          }
          return snapshot.map((paragraph) => completed.get(paragraph.paragraph_id));
        } catch (error) {
          if (signal?.aborted) throw new Error("\u4EFB\u52A1\u5DF2\u53D6\u6D88");
          if (errorStatus(error) === 401 || errorStatus(error) === 403) {
            const authError = new Error("DeepSeek API Key \u65E0\u6548\u6216\u65E0\u6743\u9650\uFF0C\u8BF7\u5728\u63D2\u4EF6\u8BBE\u7F6E\u4E2D\u91CD\u65B0\u914D\u7F6E");
            authError.code = "AUTH_INVALID";
            throw authError;
          }
          if (!retryable(error) || transientAttempt >= config.retryCount) throw error;
          retryReason = errorStatus(error) ? `http_${errorStatus(error)}` : "network_or_timeout";
          transientAttempt += 1;
          onEvent?.({ type: "request.retrying", attempt: transientAttempt, reason: retryReason, audit });
          await delay(500 * 2 ** (transientAttempt - 1), signal);
        }
      }
    }
    async call(method, url, { key, body, timeout, signal } = {}) {
      let requestHandle = null;
      const onAbort = () => requestHandle?.abort?.();
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        const response = await this.httpRequest(method, url, {
          headers: {
            Authorization: `Bearer ${key}`,
            ...body ? { "Content-Type": "application/json" } : {}
          },
          body: body ? JSON.stringify(body) : void 0,
          responseType: "json",
          timeout,
          requestObserver: (request) => {
            requestHandle = request;
            if (signal?.aborted) request.abort?.();
          }
        });
        const status = Number(response?.status || 200);
        const payload = response?.response ?? response?.payload ?? (response?.responseText ? JSON.parse(response.responseText) : {});
        if (status < 200 || status >= 300) {
          const error = new Error(`DeepSeek HTTP ${status}: ${errorDetail(payload)}`);
          error.status = status;
          throw error;
        }
        return { status, payload };
      } catch (error) {
        if (signal?.aborted) throw new Error("\u4EFB\u52A1\u5DF2\u53D6\u6D88");
        throw error;
      } finally {
        signal?.removeEventListener("abort", onAbort);
      }
    }
  };
  function safeName(value) {
    return String(value || "unknown").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
  }
  function notFound(error) {
    return error?.name === "NotFoundError" || /not found|could not be found/i.test(error?.message || "");
  }
  function cacheError(message, cause) {
    const error = new Error(message, cause ? { cause } : void 0);
    error.code = "CACHE_CORRUPT";
    return error;
  }
  function emptyCacheDocument(sourceHash, now = (/* @__PURE__ */ new Date()).toISOString()) {
    return {
      schema_version: 2,
      pdf_hash: sourceHash,
      created_at: now,
      updated_at: now,
      attachment_refs: [],
      migration_sources: [],
      pages: {},
      entries: {}
    };
  }
  function activeRevision(entry, language = TARGET_LANGUAGE) {
    const translation = entry?.translations?.[language];
    if (!translation || !Array.isArray(translation.revisions)) return null;
    return translation.revisions.find((revision) => revision.id === translation.active_revision_id) || translation.revisions.at(-1) || null;
  }
  function materializeCache(document, language = TARGET_LANGUAGE) {
    const paragraphs = {};
    const selectedPages = Object.keys(document?.pages || {}).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
    const pages = selectedPages.map((pageNumber) => {
      const page = document.pages[String(pageNumber)] || {};
      for (const occurrence of page.occurrences || []) {
        const entry = document.entries?.[occurrence.paragraph_hash];
        const revision = activeRevision(entry, language);
        if (!revision || revision.processing_status !== "completed") continue;
        const paragraph = {
          paragraph_id: occurrence.paragraph_id,
          paragraph_hash: occurrence.paragraph_hash,
          page: pageNumber,
          bbox: occurrence.bbox,
          page_width: page.width,
          page_height: page.height,
          block_type: occurrence.block_type,
          original: entry?.original || "",
          translation: revision.translation,
          summary: revision.summary,
          processing_status: revision.processing_status,
          cache_revision_id: revision.id,
          translation_meta: {
            prompt_version: revision.prompt_version,
            model: revision.model,
            created_at: revision.created_at
          }
        };
        paragraphs[`${pageNumber}:${occurrence.paragraph_id}:${occurrence.paragraph_hash}`] = paragraph;
      }
      return { page: pageNumber, width: page.width, height: page.height };
    });
    const translatedPages = [...new Set(Object.values(paragraphs).map((paragraph) => paragraph.page))];
    return {
      schema_version: 2,
      pdf_hash: document.pdf_hash,
      target_language: language,
      updated_at: document.updated_at,
      selected_pages: selectedPages,
      pages,
      paragraphs,
      stats: {
        translatedPages: translatedPages.length,
        translatedParagraphs: Object.keys(paragraphs).length,
        migratedFrom: [...document.migration_sources || []]
      }
    };
  }
  function legacyDocumentsToV2(sourceHash, legacyDocuments, now = (/* @__PURE__ */ new Date()).toISOString()) {
    const document = emptyCacheDocument(sourceHash, now);
    let revisionIndex = 0;
    const orderedDocuments = [...legacyDocuments].sort(
      (a, b) => String(a.data?.updated_at || "").localeCompare(String(b.data?.updated_at || ""))
    );
    for (const { source, data, itemKey } of orderedDocuments) {
      if (!data || typeof data !== "object" || !data.paragraphs || typeof data.paragraphs !== "object") {
        throw cacheError(`\u65E7\u7F13\u5B58\u65E0\u6CD5\u8BC6\u522B\uFF1A${source}`);
      }
      if (!document.migration_sources.includes(source)) document.migration_sources.push(source);
      const reference = String(itemKey || data.zotero_item_key || "");
      if (reference && !document.attachment_refs.some((item) => item.item_key === reference)) {
        document.attachment_refs.push({ item_key: reference });
      }
      const pageMetadata = new Map((data.pages || []).map((page) => [Number(page.page), page]));
      const byPage = /* @__PURE__ */ new Map();
      for (const paragraph of Object.values(data.paragraphs)) {
        const pageNumber = Number(paragraph?.page);
        if (!Number.isInteger(pageNumber) || !paragraph?.paragraph_hash || !paragraph?.paragraph_id) continue;
        if (!pageMetadata.has(pageNumber)) {
          pageMetadata.set(pageNumber, {
            page: pageNumber,
            width: paragraph.page_width,
            height: paragraph.page_height
          });
        }
        const occurrences = byPage.get(pageNumber) || [];
        if (!occurrences.some((item) => item.paragraph_id === paragraph.paragraph_id && item.paragraph_hash === paragraph.paragraph_hash)) {
          occurrences.push({
            paragraph_id: paragraph.paragraph_id,
            paragraph_hash: paragraph.paragraph_hash,
            bbox: paragraph.bbox,
            block_type: paragraph.block_type
          });
        }
        byPage.set(pageNumber, occurrences);
        const existing = document.entries[paragraph.paragraph_hash] || {
          paragraph_hash: paragraph.paragraph_hash,
          original: paragraph.original || "",
          translations: {}
        };
        document.entries[paragraph.paragraph_hash] = existing;
        if (paragraph.processing_status !== "completed" || typeof paragraph.translation !== "string") continue;
        const target = existing.translations[data.target_language || TARGET_LANGUAGE] || {
          active_revision_id: null,
          revisions: []
        };
        const duplicate = target.revisions.find(
          (revision) => revision.translation === paragraph.translation && revision.summary === (paragraph.summary || "") && revision.prompt_version === (data.prompt_version || "legacy-unknown") && revision.model === (data.model || "unknown")
        );
        if (duplicate) {
          target.active_revision_id = duplicate.id;
        } else {
          const revision = {
            id: `legacy-${++revisionIndex}`,
            translation: paragraph.translation,
            summary: paragraph.summary || "",
            processing_status: "completed",
            prompt_version: data.prompt_version || "legacy-unknown",
            model: data.model || "unknown",
            created_at: data.updated_at || now
          };
          target.revisions.push(revision);
          target.active_revision_id = revision.id;
        }
        existing.translations[data.target_language || TARGET_LANGUAGE] = target;
      }
      for (const pageNumber of /* @__PURE__ */ new Set([...(data.selected_pages || []).map(Number), ...byPage.keys()])) {
        if (!Number.isInteger(pageNumber)) continue;
        const page = pageMetadata.get(pageNumber) || {};
        const oldPage = document.pages[String(pageNumber)] || { occurrences: [] };
        const combined = [...oldPage.occurrences];
        for (const occurrence of byPage.get(pageNumber) || []) {
          if (!combined.some((item) => item.paragraph_id === occurrence.paragraph_id && item.paragraph_hash === occurrence.paragraph_hash)) {
            combined.push(occurrence);
          }
        }
        document.pages[String(pageNumber)] = {
          page: pageNumber,
          width: page.width || oldPage.width,
          height: page.height || oldPage.height,
          occurrences: combined
        };
      }
    }
    document.updated_at = now;
    return document;
  }
  var CacheStore = class {
    constructor({ cacheDir, io, path, now = () => (/* @__PURE__ */ new Date()).toISOString() }) {
      this.cacheDir = cacheDir;
      this.v2Dir = path.join(cacheDir, "v2");
      this.io = io;
      this.path = path;
      this.now = now;
      this.writeQueues = /* @__PURE__ */ new Map();
      this.revisionCounter = 0;
    }
    filePath(sourceHash) {
      return this.path.join(this.v2Dir, `${safeName(sourceHash)}.json`);
    }
    legacyFilePath(sourceHash, itemKey) {
      return this.path.join(this.cacheDir, `${safeName(sourceHash)}-${safeName(itemKey)}.json`);
    }
    async loadDocument(sourceHash) {
      try {
        const document = JSON.parse(await this.io.readUTF8(this.filePath(sourceHash)));
        if (document?.schema_version !== 2 || document?.pdf_hash !== sourceHash || !document.pages || !document.entries) {
          throw cacheError(`\u7F13\u5B58\u683C\u5F0F\u65E0\u6CD5\u8BC6\u522B\uFF1A${this.filePath(sourceHash)}`);
        }
        return document;
      } catch (error) {
        if (notFound(error)) return null;
        if (error?.code === "CACHE_CORRUPT") throw error;
        throw cacheError(`\u7F13\u5B58\u8BFB\u53D6\u5931\u8D25\uFF0C\u5DF2\u4FDD\u7559\u539F\u6587\u4EF6\uFF1A${this.filePath(sourceHash)}`, error);
      }
    }
    async load(sourceHash) {
      const document = await this.loadDocument(sourceHash);
      return document ? materializeCache(document) : null;
    }
    async atomicWrite(sourceHash, document) {
      await this.io.makeDirectory(this.v2Dir, { ignoreExisting: true, createAncestors: true });
      const filePath = this.filePath(sourceHash);
      const tempPath = `${filePath}.${Date.now()}.tmp`;
      await this.io.writeUTF8(tempPath, JSON.stringify(document, null, 2));
      await this.io.move(tempPath, filePath, { noOverwrite: false });
    }
    queueWrite(sourceHash, worker) {
      const previous = this.writeQueues.get(sourceHash) || Promise.resolve();
      const current = previous.catch(() => {
      }).then(worker);
      this.writeQueues.set(sourceHash, current);
      return current.finally(() => {
        if (this.writeQueues.get(sourceHash) === current) this.writeQueues.delete(sourceHash);
      });
    }
    async migrate(sourceHash, legacyDocuments) {
      return this.queueWrite(sourceHash, async () => {
        const existing = await this.loadDocument(sourceHash);
        if (existing) return materializeCache(existing);
        const document = legacyDocumentsToV2(sourceHash, legacyDocuments, this.now());
        await this.atomicWrite(sourceHash, document);
        return materializeCache(document);
      });
    }
    async save(sourceHash, itemKey, documentData) {
      return this.queueWrite(sourceHash, async () => {
        const timestamp = this.now();
        const document = await this.loadDocument(sourceHash) || emptyCacheDocument(sourceHash, timestamp);
        if (itemKey && !document.attachment_refs.some((item) => item.item_key === itemKey)) {
          document.attachment_refs.push({ item_key: itemKey });
        }
        const updatedPages = new Set((documentData.updated_pages || documentData.selected_pages || []).map(Number));
        const pageMetadata = new Map((documentData.pages || []).map((page) => [Number(page.page), page]));
        const layoutByPage = /* @__PURE__ */ new Map();
        for (const paragraph of documentData.layout_paragraphs || Object.values(documentData.paragraphs || {})) {
          if (!updatedPages.has(Number(paragraph.page))) continue;
          const values = layoutByPage.get(Number(paragraph.page)) || [];
          values.push({
            paragraph_id: paragraph.paragraph_id,
            paragraph_hash: paragraph.paragraph_hash,
            bbox: paragraph.bbox,
            block_type: paragraph.block_type
          });
          layoutByPage.set(Number(paragraph.page), values);
          const entry = document.entries[paragraph.paragraph_hash] || {
            paragraph_hash: paragraph.paragraph_hash,
            original: paragraph.original || "",
            translations: {}
          };
          if (!entry.original && paragraph.original) entry.original = paragraph.original;
          document.entries[paragraph.paragraph_hash] = entry;
        }
        for (const pageNumber of updatedPages) {
          if (!Number.isInteger(pageNumber)) continue;
          const page = pageMetadata.get(pageNumber) || document.pages[String(pageNumber)] || {};
          document.pages[String(pageNumber)] = {
            page: pageNumber,
            width: page.width,
            height: page.height,
            occurrences: layoutByPage.get(pageNumber) || []
          };
        }
        for (const paragraph of Object.values(documentData.paragraphs || {})) {
          if (paragraph.processing_status !== "completed" || typeof paragraph.translation !== "string") continue;
          const entry = document.entries[paragraph.paragraph_hash] || {
            paragraph_hash: paragraph.paragraph_hash,
            original: paragraph.original || "",
            translations: {}
          };
          const target = entry.translations[TARGET_LANGUAGE] || { active_revision_id: null, revisions: [] };
          if (paragraph.cache_revision_id && target.revisions.some((revision) => revision.id === paragraph.cache_revision_id)) {
            target.active_revision_id = paragraph.cache_revision_id;
          } else {
            const current = activeRevision(entry, TARGET_LANGUAGE);
            const sameOperation = documentData.force_retranslate && documentData.operation_id ? target.revisions.find(
              (revision) => revision.operation_id === documentData.operation_id && revision.translation === paragraph.translation && revision.summary === (paragraph.summary || "")
            ) : null;
            const sameResult = current && current.translation === paragraph.translation && current.summary === (paragraph.summary || "");
            const unchanged = sameOperation || sameResult && (!documentData.force_retranslate || current.operation_id === documentData.operation_id);
            if (sameOperation) {
              target.active_revision_id = sameOperation.id;
            } else if (!unchanged) {
              const revision = {
                id: `rev-${Date.now()}-${++this.revisionCounter}`,
                translation: paragraph.translation,
                summary: paragraph.summary || "",
                processing_status: "completed",
                prompt_version: PROMPT_VERSION,
                model: documentData.model || "unknown",
                created_at: timestamp,
                operation_id: documentData.operation_id || null
              };
              target.revisions.push(revision);
              target.active_revision_id = revision.id;
            }
          }
          entry.translations[TARGET_LANGUAGE] = target;
          document.entries[paragraph.paragraph_hash] = entry;
        }
        document.updated_at = timestamp;
        await this.atomicWrite(sourceHash, document);
        return materializeCache(document);
      });
    }
    reusable(cache, paragraph) {
      const candidates = Object.values(cache?.paragraphs || {}).filter(
        (saved2) => saved2.paragraph_hash === paragraph.paragraph_hash
      );
      const saved = candidates.find((item) => item.paragraph_id === paragraph.paragraph_id) || candidates[0];
      return cache?.target_language === TARGET_LANGUAGE && typeof saved?.translation === "string" && typeof saved?.summary === "string" && saved?.processing_status === "completed" ? { ...paragraph, translation: saved.translation, summary: saved.summary, processing_status: "completed", cache_revision_id: saved.cache_revision_id, translation_meta: saved.translation_meta } : null;
    }
  };
  function emptyTokenUsage() {
    return {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      cacheHitTokens: 0,
      cacheMissTokens: 0,
      reasoningTokens: 0
    };
  }
  function addTokenUsage(total, usage) {
    for (const key of Object.keys(total)) {
      const value = Number(usage[key]);
      if (Number.isFinite(value) && value > 0) total[key] += Math.floor(value);
    }
  }
  function touch(job) {
    job.updatedAt = Date.now();
  }
  async function runBatches(batches, concurrency, worker) {
    let next = 0;
    const count = Math.min(batches.length, Math.max(1, Number(concurrency) || 1));
    await Promise.all(Array.from({ length: count }, async () => {
      while (next < batches.length) {
        const batchIndex = next;
        const batch = batches[batchIndex];
        next += 1;
        await worker(batch, batchIndex);
      }
    }));
  }
  var JobManager = class {
    constructor({ cache, translator, configProvider, extract = extractSelectedPages, uuid = () => crypto.randomUUID() }) {
      this.cache = cache;
      this.translator = translator;
      this.configProvider = configProvider;
      this.extract = extract;
      this.uuid = uuid;
      this.jobs = /* @__PURE__ */ new Map();
    }
    publicJob(job) {
      const { controller, request, ...fields } = job;
      return fields;
    }
    getJob(id) {
      const job = this.jobs.get(id);
      return job ? this.publicJob(job) : null;
    }
    createJob(request) {
      const now = Date.now();
      const job = {
        id: this.uuid(),
        request,
        status: "queued",
        phase: "queued",
        pageCurrent: 0,
        pageTotal: request.pages.length,
        prepareProgress: 0,
        paragraphCurrent: 0,
        paragraphTotal: 0,
        batchCurrent: 0,
        batchTotal: 0,
        batchActive: 0,
        paragraphTranslated: 0,
        paragraphCached: 0,
        paragraphSkipped: 0,
        paragraphFailed: 0,
        localCacheHits: 0,
        provider: "deepseek",
        model: this.configProvider().model,
        modelCallCount: 0,
        apiRequestCount: 0,
        failed: [],
        result: null,
        tokenUsage: emptyTokenUsage(),
        retryTokenUsage: emptyTokenUsage(),
        requestAudits: [],
        controller: createAbortController(),
        createdAt: now,
        startedAt: null,
        updatedAt: now
      };
      this.jobs.set(job.id, job);
      this.run(job).catch((error) => {
        job.status = job.controller.signal.aborted ? "cancelled" : "failed";
        job.phase = "done";
        job.error = error.message;
        job.errorCode = error.code || null;
        touch(job);
      });
      return this.publicJob(job);
    }
    retryJob(id) {
      const old = this.jobs.get(id);
      if (!old) return null;
      const request = { ...old.request };
      if (request.forceRetranslate) {
        request.forceParagraphIds = old.failed.map((item) => item.paragraph_id);
      }
      return this.createJob(request);
    }
    cancelJob(id) {
      const job = this.jobs.get(id);
      if (!job) return null;
      job.controller.abort();
      touch(job);
      return this.publicJob(job);
    }
    async run(job) {
      const { itemID, itemKey, sourceHash, pages, forceRetranslate = false, forceParagraphIds = null } = job.request;
      const config = this.configProvider();
      job.status = "running";
      job.startedAt = Date.now();
      job.phase = "hashing";
      touch(job);
      const oldCache = await this.cache.load(sourceHash, itemKey);
      if (job.controller.signal.aborted) throw new Error("\u4EFB\u52A1\u5DF2\u53D6\u6D88");
      job.phase = "extracting";
      touch(job);
      const extracted = await this.extract(itemID, pages, {
        signal: job.controller.signal,
        onPage: ({ current }) => {
          job.pageCurrent = current;
          touch(job);
        },
        onPrepareProgress: (percent) => {
          job.prepareProgress = Math.max(0, Math.min(100, Math.round(percent)));
          touch(job);
        }
      });
      job.pageCurrent = pages.length;
      job.paragraphTotal = extracted.paragraphs.length;
      const completed = [];
      const pending = [];
      const skipped = classifySkippedParagraphs(extracted.paragraphs);
      for (const paragraph of extracted.paragraphs) {
        const skippedStatus = skipped.get(paragraph.paragraph_id);
        if (skippedStatus) {
          completed.push({ ...paragraph, translation: "", summary: "", processing_status: skippedStatus });
          job.paragraphSkipped += 1;
          continue;
        }
        const forceThisParagraph = forceRetranslate && (!Array.isArray(forceParagraphIds) || forceParagraphIds.includes(paragraph.paragraph_id));
        const cached = forceThisParagraph ? null : this.cache.reusable(oldCache, paragraph);
        if (cached) {
          completed.push(cached);
          if (cached.processing_status === "completed") {
            job.paragraphCached += 1;
            job.localCacheHits += 1;
          } else job.paragraphSkipped += 1;
        } else {
          pending.push(paragraph);
        }
      }
      job.paragraphCurrent = completed.length;
      job.phase = pending.length ? "translating" : "cache-hit";
      touch(job);
      let persistQueue = Promise.resolve();
      const persist = () => {
        const paragraphMap = Object.fromEntries(completed.map((paragraph) => [
          `${paragraph.page}:${paragraph.paragraph_id}:${paragraph.paragraph_hash}`,
          paragraph
        ]));
        const snapshot = {
          updated_pages: pages,
          pages: extracted.pages,
          layout_paragraphs: extracted.paragraphs,
          paragraphs: paragraphMap,
          force_retranslate: forceRetranslate,
          model: config.model,
          operation_id: job.id
        };
        persistQueue = persistQueue.then(async () => {
          const saved = await this.cache.save(sourceHash, itemKey, snapshot);
          job.result = saved;
          return saved;
        });
        return persistQueue;
      };
      const batches = createBatches(pending, config.maxBatchChars);
      job.batchTotal = batches.length;
      await runBatches(batches, config.concurrency, async (batch, batchIndex) => {
        if (job.controller.signal.aborted) throw new Error("\u4EFB\u52A1\u5DF2\u53D6\u6D88");
        job.batchActive += 1;
        job.modelCallCount += 1;
        job.phase = "connecting";
        touch(job);
        try {
          const translated = await this.translator.translate(batch, {
            signal: job.controller.signal,
            batchIndex: batchIndex + 1,
            onEvent: (event) => {
              const type = String(event?.type || "").toLowerCase();
              job.lastEventAt = Date.now();
              job.lastEvent = event?.type || "event";
              if (type === "request.started") {
                job.apiRequestCount += 1;
                job.requestAudits.push({ ...event.audit, usage: null, finishReason: null });
              }
              if (event?.usage) {
                addTokenUsage(job.tokenUsage, event.usage);
                if (event.audit?.isRetry) addTokenUsage(job.retryTokenUsage, event.usage);
                const audit = job.requestAudits.find(
                  (item) => item.batchIndex === event.audit?.batchIndex && item.requestIndex === event.audit?.requestIndex
                );
                if (audit) {
                  audit.usage = { ...event.usage };
                  audit.finishReason = event.finishReason || null;
                }
              }
              job.phase = /request\.started|response|message|delta/.test(type) ? "generating" : "connecting";
              touch(job);
            }
          });
          completed.push(...translated);
          job.paragraphTranslated += translated.length;
          job.paragraphCurrent += translated.length;
          await persist();
        } catch (error) {
          if (job.controller.signal.aborted || error.code === "AUTH_INVALID" || error.code === "AUTH_REQUIRED") throw error;
          if (batch.length > 1 && error.code === "INVALID_MODEL_OUTPUT") {
            for (const paragraph of batch) {
              if (job.controller.signal.aborted) throw new Error("\u4EFB\u52A1\u5DF2\u53D6\u6D88");
              job.modelCallCount += 1;
              try {
                const [translated] = await this.translator.translate([paragraph], {
                  signal: job.controller.signal,
                  batchIndex: batchIndex + 1,
                  onEvent: (event) => {
                    const type = String(event?.type || "").toLowerCase();
                    if (type === "request.started") job.apiRequestCount += 1;
                    if (event?.usage) {
                      addTokenUsage(job.tokenUsage, event.usage);
                      if (event.audit?.isRetry) addTokenUsage(job.retryTokenUsage, event.usage);
                    }
                    job.lastEventAt = Date.now();
                    job.lastEvent = event?.type || "event";
                    touch(job);
                  }
                });
                completed.push(translated);
                job.paragraphTranslated += 1;
              } catch (singleError) {
                job.failed.push({ paragraph_id: paragraph.paragraph_id, page: paragraph.page, error: singleError.message });
                job.paragraphFailed += 1;
              }
              job.paragraphCurrent += 1;
              await persist();
            }
          } else {
            job.failed.push(...batch.map((paragraph) => ({
              paragraph_id: paragraph.paragraph_id,
              page: paragraph.page,
              error: error.message
            })));
            job.paragraphFailed += batch.length;
            job.paragraphCurrent += batch.length;
          }
        } finally {
          job.batchActive -= 1;
          job.batchCurrent += 1;
          touch(job);
        }
      });
      job.phase = "saving";
      touch(job);
      job.result = await persist();
      job.status = job.failed.length ? "partial" : "completed";
      job.phase = "done";
      touch(job);
    }
  };
  var runtime = null;
  function createLoginInfo(...args) {
    const LoginInfo = new Components.Constructor("@mozilla.org/login-manager/loginInfo;1", Ci.nsILoginInfo, "init");
    return new LoginInfo(...args);
  }
  function configFromPrefs() {
    const get = (name, fallback) => {
      try {
        const value = Zotero.Prefs.get(`${PREF_PREFIX}${name}`, true);
        return value === void 0 || value === null || value === "" ? fallback : value;
      } catch {
        return fallback;
      }
    };
    return {
      baseUrl: "https://api.deepseek.com",
      model: String(get("model", "deepseek-flash")),
      timeoutMs: Math.max(1e4, Number(get("timeoutMs", 9e4))),
      retryCount: Math.max(0, Number(get("retryCount", 2))),
      maxBatchChars: Math.max(1e3, Number(get("maxBatchChars", 7e3))),
      concurrency: Math.max(1, Math.min(4, Number(get("concurrency", 2)))),
      translationFontSize: normalizeTranslationFontSize(get("translationFontSize", 16))
    };
  }
  function requireRuntime() {
    if (!runtime) throw new Error("AI Reader Service \u5C1A\u672A\u521D\u59CB\u5316");
    return runtime;
  }
  async function init() {
    if (runtime) return;
    const cacheDir = PathUtils.join(Zotero.DataDirectory.dir, "ai-reader-cache");
    const secrets = new SecretStore({ logins: Services.logins, createLoginInfo });
    const cache = new CacheStore({ cacheDir, io: IOUtils, path: PathUtils });
    const translator = new DeepSeekClient({
      keyProvider: () => secrets.get(),
      configProvider: configFromPrefs,
      httpRequest: (...args) => Zotero.HTTP.request(...args)
    });
    const windowCrypto = Zotero.getMainWindow()?.crypto || globalThis.crypto;
    const jobs = new JobManager({
      cache,
      translator,
      configProvider: configFromPrefs,
      extract: (itemID, pages, options) => extractSelectedPages(Zotero.SDT, itemID, pages, { ...options, cryptoImpl: windowCrypto }),
      uuid: () => Services.uuid.generateUUID().toString().replace(/[{}]/g, "")
    });
    runtime = { secrets, cache, translator, jobs };
  }
  function shutdown() {
    if (runtime) {
      for (const job of runtime.jobs.jobs.values()) job.controller.abort();
    }
    runtime = null;
  }
  async function attachmentIdentity(itemID) {
    const item = Zotero.Items.get(itemID);
    if (!item?.isAttachment?.()) throw new Error("\u5F53\u524D Reader \u672A\u5173\u8054 PDF \u9644\u4EF6");
    const sourceHash = await item.attachmentHash;
    if (!sourceHash) throw new Error("\u65E0\u6CD5\u8BFB\u53D6 PDF \u9644\u4EF6\u54C8\u5E0C");
    return { item, itemKey: item.key, sourceHash };
  }
  async function createJob({ itemID, pageRange, totalPages, forceRetranslate = false }) {
    const { item, itemKey, sourceHash } = await attachmentIdentity(itemID);
    await ensureDocumentCache(item, sourceHash, itemKey);
    const pages = parsePageRange(pageRange, totalPages);
    return requireRuntime().jobs.createJob({ itemID, itemKey, sourceHash, pages, pageRange, totalPages, forceRetranslate });
  }
  async function detectTranslationRange({ itemID, totalPages }) {
    await attachmentIdentity(itemID);
    if (!Number.isInteger(totalPages) || totalPages < 1) throw new RangeError("PDF \u603B\u9875\u6570\u65E0\u6548");
    const pages = Array.from({ length: totalPages }, (_, index) => index + 1);
    const extracted = await requireRuntime().jobs.extract(itemID, pages);
    return detectMainTextRange(extracted.paragraphs, totalPages);
  }
  function getJob(id) {
    return requireRuntime().jobs.getJob(id);
  }
  function cancelJob(id) {
    return requireRuntime().jobs.cancelJob(id);
  }
  function retryJob(id) {
    return requireRuntime().jobs.retryJob(id);
  }
  async function restore({ itemID }) {
    const { item, itemKey, sourceHash } = await attachmentIdentity(itemID);
    const saved = await ensureDocumentCache(item, sourceHash, itemKey);
    return saved?.stats?.translatedParagraphs > 0 ? { hit: true, cache: saved, stats: saved.stats } : { hit: false, pdf_hash: sourceHash, stats: { translatedPages: 0, translatedParagraphs: 0, migratedFrom: [] } };
  }
  async function getChildren(directory) {
    try {
      return typeof IOUtils.getChildren === "function" ? await IOUtils.getChildren(directory) : [];
    } catch (error) {
      if (notFound(error)) return [];
      throw error;
    }
  }
  function leafName(filePath) {
    return String(filePath || "").split(/[\\/]/).pop() || "cache.json";
  }
  async function collectLegacyDocuments(directory, prefix, sourceLabel) {
    const children = await getChildren(directory);
    const paths = children.filter((filePath) => {
      const name = leafName(filePath);
      return name.startsWith(`${safeName(prefix)}-`) && name.endsWith(".json");
    });
    const documents = [];
    for (const filePath of paths) {
      try {
        documents.push({
          source: `${sourceLabel}:${leafName(filePath)}`,
          data: JSON.parse(await IOUtils.readUTF8(filePath))
        });
      } catch (error) {
        throw cacheError(`\u65E7\u7F13\u5B58\u8BFB\u53D6\u5931\u8D25\uFF0C\u5DF2\u4FDD\u7559\u539F\u6587\u4EF6\uFF1A${filePath}`, error);
      }
    }
    return documents;
  }
  async function ensureDocumentCache(item, sourceHash, itemKey) {
    const { cache } = requireRuntime();
    const current = await cache.load(sourceHash);
    if (current) return current;
    const legacyDocuments = await collectLegacyDocuments(cache.cacheDir, sourceHash, "v1");
    const oldHomeDocuments = await findHomeLegacyDocuments(item);
    legacyDocuments.push(...oldHomeDocuments);
    if (!legacyDocuments.length) return null;
    for (const legacy of legacyDocuments) legacy.itemKey ||= itemKey;
    return cache.migrate(sourceHash, legacyDocuments);
  }
  async function findHomeLegacyDocuments(item) {
    const home = Services.dirsvc.get("Home", Ci.nsIFile).path;
    const legacyDir = PathUtils.join(home, ".zotero-ai-reader", "cache");
    const children = await getChildren(legacyDir);
    if (!children.some((filePath) => leafName(filePath).endsWith(".json"))) return [];
    const path = await item.getFilePathAsync();
    if (!path) return [];
    const bytes = await IOUtils.read(path);
    const windowCrypto = Zotero.getMainWindow()?.crypto || globalThis.crypto;
    const digest = await windowCrypto.subtle.digest("SHA-256", bytes);
    const legacyHash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    return collectLegacyDocuments(legacyDir, legacyHash, "legacy-home");
  }
  function getAPIKeyStatus() {
    return requireRuntime().secrets.status();
  }
  async function configureAPIKey(key) {
    await requireRuntime().translator.testKey(String(key || "").trim());
    return requireRuntime().secrets.set(key);
  }
  async function testAPIKey() {
    const key = await requireRuntime().secrets.get();
    if (!key) throw new Error("\u5C1A\u672A\u914D\u7F6E DeepSeek API Key");
    await requireRuntime().translator.testKey(key);
    return true;
  }
  function clearAPIKey() {
    return requireRuntime().secrets.clear();
  }
  function getSettings() {
    const config = configFromPrefs();
    return {
      model: config.model,
      timeoutMs: config.timeoutMs,
      retryCount: config.retryCount,
      maxBatchChars: config.maxBatchChars,
      concurrency: config.concurrency,
      translationFontSize: config.translationFontSize
    };
  }
  function saveSettings(settings) {
    const values = {
      model: String(settings.model || "deepseek-flash"),
      timeoutMs: Math.max(1e4, Number(settings.timeoutMs || 9e4)),
      retryCount: Math.max(0, Number(settings.retryCount || 2)),
      maxBatchChars: Math.max(1e3, Number(settings.maxBatchChars || 7e3)),
      concurrency: Math.max(1, Math.min(4, Number(settings.concurrency || 2))),
      translationFontSize: normalizeTranslationFontSize(settings.translationFontSize)
    };
    for (const [name, value] of Object.entries(values)) Zotero.Prefs.set(`${PREF_PREFIX}${name}`, value, true);
    return values;
  }
  return __toCommonJS(service_exports);
})();
