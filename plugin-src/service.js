import {
  buildTranslationPrompt,
  classifySkippedParagraphs,
  createBatches,
  detectMainTextRange,
  getJsonShape,
  parsePageRange,
} from "./core.js";
import { extractSelectedPages } from "./pdf-extractor.js";

const PLUGIN_ID = "zotero-ai-reader@local";
// 使用真实 HTTPS Origin，兼容 Zotero 10/Firefox 的新密码存储后端。
const SECRET_ORIGIN = "https://api.deepseek.com";
const SECRET_REALM = "DeepSeek API Key";
const PREF_PREFIX = "extensions.zotero-ai-reader.";

export function normalizeTranslationFontSize(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 12 && number <= 22 ? Math.round(number) : 16;
}
const PROMPT_VERSION = "zh-academic-v6-safe-math-protocol";
const TARGET_LANGUAGE = "zh-CN";

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
    reasoningTokens: finiteToken(usage.completion_tokens_details?.reasoning_tokens),
  };
}

function stripJsonFence(text) {
  return String(text || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
}

// DeepSeek 偶尔会在 JSON 字符串中直接输出 LaTeX 反斜杠。
// 只修复 JSON 规范不允许的转义；不改动结构、引号和标准转义。
function repairInvalidJsonEscapes(value) {
  return value.replace(/\\(?!["\\/bfnrtu])/g, "\\\\");
}

export function parseModelJson(value) {
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
  return String(value || "").replace(/\[\[math:([\s\S]*?)\]\]/g, (_match, latex) =>
    `\\(${latex.replace(/§/g, "\\")}\\)`,
  );
}

function errorStatus(error) {
  return Number(error?.status || error?.xmlhttp?.status || error?.response?.status || 0);
}

function errorDetail(payload) {
  const message = payload?.error?.message || payload?.message;
  return typeof message === "string" ? message.slice(0, 1000) : "请求失败";
}

function retryable(error) {
  return [408, 429, 500, 502, 503, 504].includes(errorStatus(error)) ||
    error?.name === "TimeoutError";
}

async function sha256(value, cryptoImpl = globalThis.crypto) {
  if (!cryptoImpl?.subtle) throw new Error("当前环境不支持 Web Crypto");
  const bytes = new TextEncoder().encode(String(value));
  const digest = await cryptoImpl.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function inspectTranslationResults(source, results) {
  if (!Array.isArray(results)) return { valid: [], invalid: source };
  const occurrences = new Map();
  for (const item of results) {
    if (!item || typeof item.id !== "string") continue;
    occurrences.set(item.id, [...(occurrences.get(item.id) || []), item]);
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
      processing_status: translation || summary ? "completed" : "skipped_reference",
    });
  }
  return { valid, invalid };
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new Error("任务已取消"));
    }, { once: true });
  });
}

// Zotero 的插件沙箱并不保证暴露 Web 的 AbortController。
// 保留相同的 signal 接口，让提取、重试等待和 HTTP 请求都能响应“取消任务”。
export function createAbortController(Controller = globalThis.AbortController || globalThis.Zotero?.getMainWindow?.()?.AbortController) {
  if (typeof Controller === "function") return new Controller();

  const listeners = new Set();
  const signal = {
    aborted: false,
    addEventListener(type, listener) {
      if (type !== "abort" || typeof listener !== "function") return;
      listeners.add(listener);
    },
    removeEventListener(type, listener) {
      if (type === "abort") listeners.delete(listener);
    },
  };
  return {
    signal,
    abort() {
      if (signal.aborted) return;
      signal.aborted = true;
      for (const listener of [...listeners]) listener.call(signal, { type: "abort", target: signal });
      listeners.clear();
    },
  };
}

export class SecretStore {
  constructor({ logins, createLoginInfo }) {
    this.logins = logins;
    this.createLoginInfo = createLoginInfo;
  }

  async find() {
    const matches = await this.logins.searchLoginsAsync({
      origin: SECRET_ORIGIN,
      httpRealm: SECRET_REALM,
    });
    return matches.find((login) => login.username === PLUGIN_ID) || null;
  }

  async get() {
    return (await this.find())?.password || "";
  }

  async status() {
    const key = await this.get();
    return { configured: Boolean(key), masked: key ? `••••${key.slice(-4)}` : "" };
  }

  async set(key) {
    const value = String(key || "").trim();
    if (!value) throw new Error("请输入 DeepSeek API Key");
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
}

export class DeepSeekClient {
  constructor({ keyProvider, configProvider, httpRequest }) {
    this.keyProvider = keyProvider;
    this.configProvider = configProvider;
    this.httpRequest = httpRequest;
  }

  async testKey(key) {
    const config = this.configProvider();
    await this.call("GET", `${config.baseUrl}/models`, { key, timeout: 15_000 });
    return true;
  }

  async translate(paragraphs, { signal, onEvent, batchIndex = null } = {}) {
    const key = await this.keyProvider();
    if (!key) {
      const error = new Error("尚未配置 DeepSeek API Key，请先在插件设置中填写");
      error.code = "AUTH_REQUIRED";
      throw error;
    }
    const config = this.configProvider();
    // 只保留请求所需字段，防止并发任务或缓存写入改变已准备的批次。
    const snapshot = Object.freeze(paragraphs.map((paragraph) => Object.freeze({ ...paragraph })));
    const completed = new Map();
    let pending = snapshot;
    let transientAttempt = 0;
    let fullRepairCount = 0;
    let partialRepairCount = 0;
    let retryReason = null;
    let requestIndex = 0;
    for (;;) {
      const prompt = buildTranslationPrompt(pending);
      const audit = Object.freeze({
        batchIndex,
        requestIndex: ++requestIndex,
        paragraphIds: pending.map((item) => item.paragraph_id),
        paragraphCount: pending.length,
        sourceChars: pending.reduce((total, item) => total + item.original.length, 0),
        requestHash: await sha256(prompt),
        isRetry: Boolean(retryReason),
        retryReason,
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
              { role: "system", content: "你是严谨的学术论文翻译器。必须只输出有效 JSON，不要输出 Markdown。" },
              { role: "user", content: prompt },
            ],
            thinking: { type: "disabled" },
            temperature: 0.2,
            max_tokens: 8192,
            stream: false,
            response_format: { type: "json_object" },
          },
        });
        const payload = response.payload;
        const choice = payload?.choices?.[0];
        onEvent?.({
          type: "response.received",
          usage: normalizeUsage(payload?.usage),
          finishReason: choice?.finish_reason || null,
          audit,
        });
        const content = choice?.message?.content;
        if (typeof content !== "string" || !content.trim()) throw new Error("DeepSeek 响应缺少 choices[0].message.content");
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
          const error = new Error("DeepSeek 返回的内容不是有效 JSON，完整修复重试仍失败");
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
          const outputError = new Error(`DeepSeek 返回的 JSON 结构不符合预期（${getJsonShape(parsed)}）；应包含 results 数组`);
          outputError.code = "INVALID_MODEL_OUTPUT";
          throw outputError;
        }
        return snapshot.map((paragraph) => completed.get(paragraph.paragraph_id));
      } catch (error) {
        if (signal?.aborted) throw new Error("任务已取消");
        if (errorStatus(error) === 401 || errorStatus(error) === 403) {
          const authError = new Error("DeepSeek API Key 无效或无权限，请在插件设置中重新配置");
          authError.code = "AUTH_INVALID";
          throw authError;
        }
        if (!retryable(error) || transientAttempt >= config.retryCount) throw error;
        retryReason = errorStatus(error) ? `http_${errorStatus(error)}` : "network_or_timeout";
        transientAttempt += 1;
        onEvent?.({ type: "request.retrying", attempt: transientAttempt, reason: retryReason, audit });
        await delay(500 * (2 ** (transientAttempt - 1)), signal);
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
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        responseType: "json",
        timeout,
        requestObserver: (request) => {
          requestHandle = request;
          if (signal?.aborted) request.abort?.();
        },
      });
      const status = Number(response?.status || 200);
      const payload = response?.response ?? response?.payload ?? (
        response?.responseText ? JSON.parse(response.responseText) : {}
      );
      if (status < 200 || status >= 300) {
        const error = new Error(`DeepSeek HTTP ${status}: ${errorDetail(payload)}`);
        error.status = status;
        throw error;
      }
      return { status, payload };
    } catch (error) {
      if (signal?.aborted) throw new Error("任务已取消");
      throw error;
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }
}

function safeName(value) {
  return String(value || "unknown").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
}

function notFound(error) {
  return error?.name === "NotFoundError" || /not found|could not be found/i.test(error?.message || "");
}

function cacheError(message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = "CACHE_CORRUPT";
  return error;
}

function emptyCacheDocument(sourceHash, now = new Date().toISOString()) {
  return {
    schema_version: 2,
    pdf_hash: sourceHash,
    created_at: now,
    updated_at: now,
    attachment_refs: [],
    migration_sources: [],
    pages: {},
    entries: {},
  };
}

function activeRevision(entry, language = TARGET_LANGUAGE) {
  const translation = entry?.translations?.[language];
  if (!translation || !Array.isArray(translation.revisions)) return null;
  return translation.revisions.find((revision) => revision.id === translation.active_revision_id)
    || translation.revisions.at(-1)
    || null;
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
          created_at: revision.created_at,
        },
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
      migratedFrom: [...(document.migration_sources || [])],
    },
  };
}

function legacyDocumentsToV2(sourceHash, legacyDocuments, now = new Date().toISOString()) {
  const document = emptyCacheDocument(sourceHash, now);
  let revisionIndex = 0;
  const orderedDocuments = [...legacyDocuments].sort((a, b) =>
    String(a.data?.updated_at || "").localeCompare(String(b.data?.updated_at || "")),
  );
  for (const { source, data, itemKey } of orderedDocuments) {
    if (!data || typeof data !== "object" || !data.paragraphs || typeof data.paragraphs !== "object") {
      throw cacheError(`旧缓存无法识别：${source}`);
    }
    if (!document.migration_sources.includes(source)) document.migration_sources.push(source);
    const reference = String(itemKey || data.zotero_item_key || "");
    if (reference && !document.attachment_refs.some((item) => item.item_key === reference)) {
      document.attachment_refs.push({ item_key: reference });
    }
    const pageMetadata = new Map((data.pages || []).map((page) => [Number(page.page), page]));
    const byPage = new Map();
    for (const paragraph of Object.values(data.paragraphs)) {
      const pageNumber = Number(paragraph?.page);
      if (!Number.isInteger(pageNumber) || !paragraph?.paragraph_hash || !paragraph?.paragraph_id) continue;
      if (!pageMetadata.has(pageNumber)) {
        pageMetadata.set(pageNumber, {
          page: pageNumber,
          width: paragraph.page_width,
          height: paragraph.page_height,
        });
      }
      const occurrences = byPage.get(pageNumber) || [];
      if (!occurrences.some((item) => item.paragraph_id === paragraph.paragraph_id && item.paragraph_hash === paragraph.paragraph_hash)) {
        occurrences.push({
          paragraph_id: paragraph.paragraph_id,
          paragraph_hash: paragraph.paragraph_hash,
          bbox: paragraph.bbox,
          block_type: paragraph.block_type,
        });
      }
      byPage.set(pageNumber, occurrences);
      const existing = document.entries[paragraph.paragraph_hash] || {
        paragraph_hash: paragraph.paragraph_hash,
        original: paragraph.original || "",
        translations: {},
      };
      document.entries[paragraph.paragraph_hash] = existing;
      if (paragraph.processing_status !== "completed" || typeof paragraph.translation !== "string") continue;
      const target = existing.translations[data.target_language || TARGET_LANGUAGE] || {
        active_revision_id: null,
        revisions: [],
      };
      const duplicate = target.revisions.find((revision) =>
        revision.translation === paragraph.translation
        && revision.summary === (paragraph.summary || "")
        && revision.prompt_version === (data.prompt_version || "legacy-unknown")
        && revision.model === (data.model || "unknown"),
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
          created_at: data.updated_at || now,
        };
        target.revisions.push(revision);
        target.active_revision_id = revision.id;
      }
      existing.translations[data.target_language || TARGET_LANGUAGE] = target;
    }
    for (const pageNumber of new Set([...(data.selected_pages || []).map(Number), ...byPage.keys()])) {
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
        occurrences: combined,
      };
    }
  }
  document.updated_at = now;
  return document;
}

export class CacheStore {
  constructor({ cacheDir, io, path, now = () => new Date().toISOString() }) {
    this.cacheDir = cacheDir;
    this.v2Dir = path.join(cacheDir, "v2");
    this.io = io;
    this.path = path;
    this.now = now;
    this.writeQueues = new Map();
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
        throw cacheError(`缓存格式无法识别：${this.filePath(sourceHash)}`);
      }
      return document;
    } catch (error) {
      if (notFound(error)) return null;
      if (error?.code === "CACHE_CORRUPT") throw error;
      throw cacheError(`缓存读取失败，已保留原文件：${this.filePath(sourceHash)}`, error);
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
    const current = previous.catch(() => {}).then(worker);
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
      const layoutByPage = new Map();
      for (const paragraph of documentData.layout_paragraphs || Object.values(documentData.paragraphs || {})) {
        if (!updatedPages.has(Number(paragraph.page))) continue;
        const values = layoutByPage.get(Number(paragraph.page)) || [];
        values.push({
          paragraph_id: paragraph.paragraph_id,
          paragraph_hash: paragraph.paragraph_hash,
          bbox: paragraph.bbox,
          block_type: paragraph.block_type,
        });
        layoutByPage.set(Number(paragraph.page), values);
        const entry = document.entries[paragraph.paragraph_hash] || {
          paragraph_hash: paragraph.paragraph_hash,
          original: paragraph.original || "",
          translations: {},
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
          occurrences: layoutByPage.get(pageNumber) || [],
        };
      }
      for (const paragraph of Object.values(documentData.paragraphs || {})) {
        if (paragraph.processing_status !== "completed" || typeof paragraph.translation !== "string") continue;
        const entry = document.entries[paragraph.paragraph_hash] || {
          paragraph_hash: paragraph.paragraph_hash,
          original: paragraph.original || "",
          translations: {},
        };
        const target = entry.translations[TARGET_LANGUAGE] || { active_revision_id: null, revisions: [] };
        if (paragraph.cache_revision_id && target.revisions.some((revision) => revision.id === paragraph.cache_revision_id)) {
          target.active_revision_id = paragraph.cache_revision_id;
        } else {
          const current = activeRevision(entry, TARGET_LANGUAGE);
          const sameOperation = documentData.force_retranslate && documentData.operation_id
            ? target.revisions.find((revision) =>
              revision.operation_id === documentData.operation_id
              && revision.translation === paragraph.translation
              && revision.summary === (paragraph.summary || ""),
            )
            : null;
          const sameResult = current
            && current.translation === paragraph.translation && current.summary === (paragraph.summary || "");
          const unchanged = sameOperation || sameResult && (
            !documentData.force_retranslate || current.operation_id === documentData.operation_id
          );
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
              operation_id: documentData.operation_id || null,
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
    const candidates = Object.values(cache?.paragraphs || {}).filter((saved) =>
      saved.paragraph_hash === paragraph.paragraph_hash,
    );
    const saved = candidates.find((item) => item.paragraph_id === paragraph.paragraph_id) || candidates[0];
    return cache?.target_language === TARGET_LANGUAGE &&
      typeof saved?.translation === "string" &&
      typeof saved?.summary === "string" &&
      saved?.processing_status === "completed"
      ? { ...paragraph, translation: saved.translation, summary: saved.summary, processing_status: "completed", cache_revision_id: saved.cache_revision_id, translation_meta: saved.translation_meta }
      : null;
  }
}

function emptyTokenUsage() {
  return {
    promptTokens: 0, completionTokens: 0, totalTokens: 0,
    cacheHitTokens: 0, cacheMissTokens: 0, reasoningTokens: 0,
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

export class JobManager {
  constructor({ cache, translator, configProvider, extract = extractSelectedPages, uuid = () => crypto.randomUUID() }) {
    this.cache = cache;
    this.translator = translator;
    this.configProvider = configProvider;
    this.extract = extract;
    this.uuid = uuid;
    this.jobs = new Map();
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
      id: this.uuid(), request, status: "queued", phase: "queued",
      pageCurrent: 0, pageTotal: request.pages.length,
      prepareProgress: 0,
      paragraphCurrent: 0, paragraphTotal: 0, batchCurrent: 0, batchTotal: 0, batchActive: 0,
      paragraphTranslated: 0, paragraphCached: 0, paragraphSkipped: 0, paragraphFailed: 0,
      localCacheHits: 0,
      provider: "deepseek", model: this.configProvider().model,
      modelCallCount: 0, apiRequestCount: 0, failed: [], result: null,
      tokenUsage: emptyTokenUsage(), retryTokenUsage: emptyTokenUsage(), requestAudits: [],
      controller: createAbortController(),
      createdAt: now, startedAt: null, updatedAt: now,
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
    if (job.controller.signal.aborted) throw new Error("任务已取消");

    job.phase = "extracting";
    touch(job);
    const extracted = await this.extract(itemID, pages, {
      signal: job.controller.signal,
      onPage: ({ current }) => { job.pageCurrent = current; touch(job); },
      onPrepareProgress: (percent) => {
        job.prepareProgress = Math.max(0, Math.min(100, Math.round(percent)));
        touch(job);
      },
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
      const forceThisParagraph = forceRetranslate && (
        !Array.isArray(forceParagraphIds) || forceParagraphIds.includes(paragraph.paragraph_id)
      );
      const cached = forceThisParagraph ? null : this.cache.reusable(oldCache, paragraph);
      if (cached) {
        completed.push(cached);
        if (cached.processing_status === "completed") {
          job.paragraphCached += 1;
          job.localCacheHits += 1;
        }
        else job.paragraphSkipped += 1;
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
        paragraph,
      ]));
      const snapshot = {
        updated_pages: pages,
        pages: extracted.pages,
        layout_paragraphs: extracted.paragraphs,
        paragraphs: paragraphMap,
        force_retranslate: forceRetranslate,
        model: config.model,
        operation_id: job.id,
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
      if (job.controller.signal.aborted) throw new Error("任务已取消");
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
              const audit = job.requestAudits.find((item) =>
                item.batchIndex === event.audit?.batchIndex && item.requestIndex === event.audit?.requestIndex,
              );
              if (audit) {
                audit.usage = { ...event.usage };
                audit.finishReason = event.finishReason || null;
              }
            }
            job.phase = /request\.started|response|message|delta/.test(type) ? "generating" : "connecting";
            touch(job);
          },
        });
        completed.push(...translated);
        job.paragraphTranslated += translated.length;
        job.paragraphCurrent += translated.length;
        await persist();
      } catch (error) {
        if (job.controller.signal.aborted || error.code === "AUTH_INVALID" || error.code === "AUTH_REQUIRED") throw error;
        // 一个长批次的 JSON 损坏不应让整批段落一起失败。
        // 降级为单段请求，成功项立即持久化，只记录真正失败的段落。
        if (batch.length > 1 && error.code === "INVALID_MODEL_OUTPUT") {
          for (const paragraph of batch) {
            if (job.controller.signal.aborted) throw new Error("任务已取消");
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
                },
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
            paragraph_id: paragraph.paragraph_id, page: paragraph.page, error: error.message,
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
}

let runtime = null;

function createLoginInfo(...args) {
  const LoginInfo = new Components.Constructor("@mozilla.org/login-manager/loginInfo;1", Ci.nsILoginInfo, "init");
  return new LoginInfo(...args);
}

function configFromPrefs() {
  const get = (name, fallback) => {
    try {
      const value = Zotero.Prefs.get(`${PREF_PREFIX}${name}`, true);
      return value === undefined || value === null || value === "" ? fallback : value;
    } catch {
      return fallback;
    }
  };
  return {
    baseUrl: "https://api.deepseek.com",
    model: String(get("model", "deepseek-flash")),
    timeoutMs: Math.max(10_000, Number(get("timeoutMs", 90_000))),
    retryCount: Math.max(0, Number(get("retryCount", 2))),
    maxBatchChars: Math.max(1000, Number(get("maxBatchChars", 7000))),
    concurrency: Math.max(1, Math.min(4, Number(get("concurrency", 2)))),
    translationFontSize: normalizeTranslationFontSize(get("translationFontSize", 16)),
  };
}

function requireRuntime() {
  if (!runtime) throw new Error("AI Reader Service 尚未初始化");
  return runtime;
}

export async function init() {
  if (runtime) return;
  const cacheDir = PathUtils.join(Zotero.DataDirectory.dir, "ai-reader-cache");
  const secrets = new SecretStore({ logins: Services.logins, createLoginInfo });
  const cache = new CacheStore({ cacheDir, io: IOUtils, path: PathUtils });
  const translator = new DeepSeekClient({
    keyProvider: () => secrets.get(),
    configProvider: configFromPrefs,
    httpRequest: (...args) => Zotero.HTTP.request(...args),
  });
  const windowCrypto = Zotero.getMainWindow()?.crypto || globalThis.crypto;
  const jobs = new JobManager({
    cache,
    translator,
    configProvider: configFromPrefs,
    extract: (itemID, pages, options) => extractSelectedPages(Zotero.SDT, itemID, pages, { ...options, cryptoImpl: windowCrypto }),
    uuid: () => Services.uuid.generateUUID().toString().replace(/[{}]/g, ""),
  });
  runtime = { secrets, cache, translator, jobs };
}

export function shutdown() {
  if (runtime) {
    for (const job of runtime.jobs.jobs.values()) job.controller.abort();
  }
  runtime = null;
}

async function attachmentIdentity(itemID) {
  const item = Zotero.Items.get(itemID);
  if (!item?.isAttachment?.()) throw new Error("当前 Reader 未关联 PDF 附件");
  const sourceHash = await item.attachmentHash;
  if (!sourceHash) throw new Error("无法读取 PDF 附件哈希");
  return { item, itemKey: item.key, sourceHash };
}

export async function createJob({ itemID, pageRange, totalPages, forceRetranslate = false }) {
  const { item, itemKey, sourceHash } = await attachmentIdentity(itemID);
  await ensureDocumentCache(item, sourceHash, itemKey);
  const pages = parsePageRange(pageRange, totalPages);
  return requireRuntime().jobs.createJob({ itemID, itemKey, sourceHash, pages, pageRange, totalPages, forceRetranslate });
}

export async function detectTranslationRange({ itemID, totalPages }) {
  await attachmentIdentity(itemID);
  if (!Number.isInteger(totalPages) || totalPages < 1) throw new RangeError("PDF 总页数无效");
  const pages = Array.from({ length: totalPages }, (_, index) => index + 1);
  const extracted = await requireRuntime().jobs.extract(itemID, pages);
  return detectMainTextRange(extracted.paragraphs, totalPages);
}

export function getJob(id) {
  return requireRuntime().jobs.getJob(id);
}

export function cancelJob(id) {
  return requireRuntime().jobs.cancelJob(id);
}

export function retryJob(id) {
  return requireRuntime().jobs.retryJob(id);
}

export async function restore({ itemID }) {
  const { item, itemKey, sourceHash } = await attachmentIdentity(itemID);
  const saved = await ensureDocumentCache(item, sourceHash, itemKey);
  return saved?.stats?.translatedParagraphs > 0
    ? { hit: true, cache: saved, stats: saved.stats }
    : { hit: false, pdf_hash: sourceHash, stats: { translatedPages: 0, translatedParagraphs: 0, migratedFrom: [] } };
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
        data: JSON.parse(await IOUtils.readUTF8(filePath)),
      });
    } catch (error) {
      throw cacheError(`旧缓存读取失败，已保留原文件：${filePath}`, error);
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

export function getAPIKeyStatus() {
  return requireRuntime().secrets.status();
}

export async function configureAPIKey(key) {
  await requireRuntime().translator.testKey(String(key || "").trim());
  return requireRuntime().secrets.set(key);
}

export async function testAPIKey() {
  const key = await requireRuntime().secrets.get();
  if (!key) throw new Error("尚未配置 DeepSeek API Key");
  await requireRuntime().translator.testKey(key);
  return true;
}

export function clearAPIKey() {
  return requireRuntime().secrets.clear();
}

export function getSettings() {
  const config = configFromPrefs();
  return {
    model: config.model,
    timeoutMs: config.timeoutMs,
    retryCount: config.retryCount,
    maxBatchChars: config.maxBatchChars,
    concurrency: config.concurrency,
    translationFontSize: config.translationFontSize,
  };
}

export function saveSettings(settings) {
  const values = {
    model: String(settings.model || "deepseek-flash"),
    timeoutMs: Math.max(10_000, Number(settings.timeoutMs || 90_000)),
    retryCount: Math.max(0, Number(settings.retryCount || 2)),
    maxBatchChars: Math.max(1000, Number(settings.maxBatchChars || 7000)),
    concurrency: Math.max(1, Math.min(4, Number(settings.concurrency || 2))),
    translationFontSize: normalizeTranslationFontSize(settings.translationFontSize),
  };
  for (const [name, value] of Object.entries(values)) Zotero.Prefs.set(`${PREF_PREFIX}${name}`, value, true);
  return values;
}
