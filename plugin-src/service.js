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
const PROFILE_SECRET_ORIGIN = "https://zotero-ai-reader.local";
const PROFILE_SECRET_REALM = "Zotero AI Reader API Key";
const PREF_PREFIX = "extensions.zotero-ai-reader.";

export const DEFAULT_QUESTION_PROMPT_TEMPLATE =
  "请用通俗中文解释以下论文段落，并说明关键术语、核心逻辑以及它在全文中的作用：\n\n{content}";
export const QUESTION_CONTENT_SOURCES = Object.freeze(["original", "translation", "bilingual"]);
const QUESTION_TEMPLATE_VARIABLES = Object.freeze(["content", "original", "translation", "summary", "page"]);
const CLIPBOARD_TEMP_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const GENERIC_PDF_NAMES = /^(?:full[\s_-]*text|document|paper|attachment|download|file|pdf)(?:[\s_-]*\d+)?$/i;
const UUID_FILE_NAME = /^[{(]?[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}[)}]?$/i;

export const PROVIDER_PRESETS = Object.freeze([
  Object.freeze({ id: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com", model: "deepseek-flash", requiresApiKey: true, builtin: true }),
  Object.freeze({ id: "openai", name: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "", requiresApiKey: true, builtin: true }),
  Object.freeze({ id: "openrouter", name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", model: "", requiresApiKey: true, builtin: true }),
  Object.freeze({ id: "siliconflow", name: "硅基流动", baseUrl: "https://api.siliconflow.cn/v1", model: "", requiresApiKey: true, builtin: true }),
  Object.freeze({ id: "ollama", name: "Ollama", baseUrl: "http://localhost:11434/v1", model: "", requiresApiKey: false, builtin: true }),
]);

function isPrivateHttpHost(hostname) {
  const host = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".local") || host === "::1") return true;
  if (/^127\./.test(host) || /^169\.254\./.test(host)) return true;
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const parts = ipv4.slice(1).map(Number);
    if (parts.some((part) => part > 255)) return false;
    return parts[0] === 10 || parts[0] === 127 ||
      (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
      (parts[0] === 192 && parts[1] === 168) ||
      (parts[0] === 169 && parts[1] === 254);
  }
  return /^f[cd][0-9a-f]{2}:/i.test(host) || /^fe[89ab][0-9a-f]:/i.test(host);
}

export function normalizeBaseUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) throw new Error("请填写 API Base URL");
  let parsed;
  try { parsed = new URL(raw); } catch { throw new Error("API Base URL 格式无效"); }
  if (!['https:', 'http:'].includes(parsed.protocol)) throw new Error("API Base URL 仅支持 HTTP 或 HTTPS");
  if (parsed.username || parsed.password) throw new Error("API Base URL 不能包含用户名或密码");
  if (parsed.search || parsed.hash) throw new Error("API Base URL 不能包含查询参数或片段");
  if (parsed.protocol === "http:" && !isPrivateHttpHost(parsed.hostname)) {
    throw new Error("公网 API 必须使用 HTTPS；HTTP 仅允许本机或局域网地址");
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "";
  return parsed.toString().replace(/\/$/, "");
}

function endpoint(baseUrl, path) {
  return `${normalizeBaseUrl(baseUrl)}/${String(path).replace(/^\/+/, "")}`;
}

export function normalizeTranslationFontSize(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 12 && number <= 22 ? Math.round(number) : 16;
}

export function normalizeQuestionContentSource(value) {
  return QUESTION_CONTENT_SOURCES.includes(value) ? value : "original";
}

export function inspectQuestionPromptTemplate(value) {
  const template = String(value ?? "");
  if (!template.trim()) throw new Error("提问模板不能为空");
  const variables = [...template.matchAll(/\{([a-zA-Z][\w-]*)\}/g)].map((match) => match[1]);
  const unknownVariables = [...new Set(variables.filter((name) => !QUESTION_TEMPLATE_VARIABLES.includes(name)))];
  const hasParagraphVariable = variables.some((name) => QUESTION_TEMPLATE_VARIABLES.includes(name));
  const warnings = [];
  if (!hasParagraphVariable) warnings.push("模板不包含段落变量，复制时不会带入当前论文内容。");
  if (unknownVariables.length) warnings.push(`未知变量将保持原样：${unknownVariables.map((name) => `{${name}}`).join("、")}`);
  return { template, variables, unknownVariables, hasParagraphVariable, warnings };
}

export function buildQuestionPrompt(paragraph, options = {}) {
  const original = String(paragraph?.original || "").trim();
  const translation = String(paragraph?.translation || "").trim();
  const summary = String(paragraph?.summary || "").trim();
  const page = paragraph?.page === undefined || paragraph?.page === null ? "" : String(paragraph.page);
  const source = normalizeQuestionContentSource(options.questionContentSource);
  let content;
  if (source === "translation") content = translation || original;
  else if (source === "bilingual") {
    content = [original && `英文原文：\n${original}`, translation && `中文译文：\n${translation}`]
      .filter(Boolean).join("\n\n");
  } else content = original || translation;
  const template = inspectQuestionPromptTemplate(
    options.questionPromptTemplate ?? DEFAULT_QUESTION_PROMPT_TEMPLATE,
  ).template;
  const replacements = { content, original, translation, summary, page };
  return template.replace(/\{(content|original|translation|summary|page)\}/g, (_match, name) => replacements[name]);
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

  async find(profileId = "deepseek") {
    const matches = await this.logins.searchLoginsAsync({
      origin: PROFILE_SECRET_ORIGIN,
      httpRealm: PROFILE_SECRET_REALM,
    });
    return matches.find((login) => login.username === `${PLUGIN_ID}:${profileId}`) || null;
  }

  async findLegacy() {
    const matches = await this.logins.searchLoginsAsync({
      origin: SECRET_ORIGIN,
      httpRealm: SECRET_REALM,
    });
    return matches.find((login) => login.username === PLUGIN_ID) || null;
  }

  async get(profileId = "deepseek") {
    return (await this.find(profileId))?.password || "";
  }

  async status(profileId = "deepseek") {
    const key = await this.get(profileId);
    return { configured: Boolean(key), masked: key ? `••••${key.slice(-4)}` : "" };
  }

  async set(key, profileId = "deepseek") {
    const value = String(key || "").trim();
    if (!value) throw new Error("请输入 API Key");
    const existing = await this.find(profileId);
    const replacement = this.createLoginInfo(
      PROFILE_SECRET_ORIGIN, null, PROFILE_SECRET_REALM, `${PLUGIN_ID}:${profileId}`, value, "", "",
    );
    if (existing) await this.logins.modifyLoginAsync(existing, replacement);
    else await this.logins.addLoginAsync(replacement);
    return this.status(profileId);
  }

  async clear(profileId = "deepseek") {
    const existing = await this.find(profileId);
    if (existing) await this.logins.removeLoginAsync(existing);
    return { configured: false, masked: "" };
  }

  async migrateLegacyDeepSeek() {
    if (await this.find("deepseek")) return false;
    const legacy = await this.findLegacy();
    if (!legacy?.password) return false;
    await this.set(legacy.password, "deepseek");
    return true;
  }
}

function providerLabel(config) {
  return String(config?.profileName || config?.name || "AI 服务");
}

function completeClientConfig(config) {
  const input = config || {};
  const deepseek = /(^|\.)deepseek\.com$/i.test(new URL(normalizeBaseUrl(input.baseUrl)).hostname);
  return {
    ...input,
    profileId: input.profileId || (deepseek ? "deepseek" : "custom"),
    providerId: input.providerId || (deepseek ? "deepseek" : "custom"),
    profileName: input.profileName || (deepseek ? "DeepSeek" : "AI 服务"),
    requiresApiKey: input.requiresApiKey !== false,
  };
}

function unsupportedResponseFormat(error) {
  const message = error?.message || "";
  return errorStatus(error) === 400 && (
    /(response[_ ]?format|json[_ ]?object).*(unsupported|unknown|not supported|invalid)/i.test(message) ||
    /(unsupported|unknown|not supported|invalid).*(response[_ ]?format|json[_ ]?object)/i.test(message)
  );
}

export class OpenAICompatibleClient {
  constructor({ keyProvider, configProvider, httpRequest }) {
    this.keyProvider = keyProvider;
    this.configProvider = configProvider;
    this.httpRequest = httpRequest;
  }

  async listModels(config = this.configProvider(), key = "") {
    config = completeClientConfig(config);
    const response = await this.call("GET", endpoint(config.baseUrl, "models"), {
      key, timeout: 15_000, providerName: providerLabel(config),
    });
    const data = response.payload?.data ?? response.payload?.models;
    if (!Array.isArray(data)) throw new Error(`${providerLabel(config)} /models 响应缺少模型列表`);
    return [...new Set(data.map((item) => typeof item === "string" ? item : item?.id).filter(Boolean))].sort();
  }

  async testKey(key, config = this.configProvider()) {
    await this.listModels(config, key);
    return true;
  }

  async translate(paragraphs, { signal, onEvent, batchIndex = null, config: suppliedConfig } = {}) {
    const config = completeClientConfig(suppliedConfig || this.configProvider());
    const key = await this.keyProvider(config.profileId);
    if (config.requiresApiKey && !key) {
      const error = new Error(`尚未配置 ${providerLabel(config)} API Key，请先在插件设置中填写`);
      error.code = "AUTH_REQUIRED";
      throw error;
    }
    if (!String(config.model || "").trim()) throw new Error(`请先为 ${providerLabel(config)} 选择或填写模型 ID`);
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
        let responseAudit = audit;
        const body = {
          model: config.model,
          messages: [
            { role: "system", content: "你是严谨的学术论文翻译器。必须只输出有效 JSON，不要输出 Markdown。" },
            { role: "user", content: prompt },
          ],
          temperature: 0.2,
          max_tokens: 8192,
          stream: false,
          response_format: { type: "json_object" },
          ...(config.providerId === "deepseek" ? { thinking: { type: "disabled" } } : {}),
        };
        let response;
        try {
          response = await this.call("POST", endpoint(config.baseUrl, "chat/completions"), {
            key, timeout: config.timeoutMs, signal, body, providerName: providerLabel(config),
          });
        } catch (error) {
          if (!unsupportedResponseFormat(error)) throw error;
          delete body.response_format;
          onEvent?.({ type: "request.retrying", attempt: 1, reason: "unsupported_response_format", audit });
          responseAudit = Object.freeze({
            ...audit, requestIndex: ++requestIndex, isRetry: true, retryReason: "unsupported_response_format",
          });
          onEvent?.({ type: "request.started", audit: responseAudit });
          response = await this.call("POST", endpoint(config.baseUrl, "chat/completions"), {
            key, timeout: config.timeoutMs, signal, body, providerName: providerLabel(config),
          });
        }
        const payload = response.payload;
        const choice = payload?.choices?.[0];
        onEvent?.({
          type: "response.received",
          usage: normalizeUsage(payload?.usage),
          finishReason: choice?.finish_reason || null,
          audit: responseAudit,
        });
        const content = choice?.message?.content;
        if (typeof content !== "string" || !content.trim()) throw new Error(`${providerLabel(config)} 响应缺少 choices[0].message.content`);
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
          const error = new Error(`${providerLabel(config)} 返回的内容不是有效 JSON，完整修复重试仍失败`);
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
          const outputError = new Error(`${providerLabel(config)} 返回的 JSON 结构不符合预期（${getJsonShape(parsed)}）；应包含 results 数组`);
          outputError.code = "INVALID_MODEL_OUTPUT";
          throw outputError;
        }
        return snapshot.map((paragraph) => completed.get(paragraph.paragraph_id));
      } catch (error) {
        if (signal?.aborted) throw new Error("任务已取消");
        if (errorStatus(error) === 401 || errorStatus(error) === 403) {
          const authError = new Error(`${providerLabel(config)} API Key 无效或无权限，请在插件设置中重新配置`);
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

  async call(method, url, { key, body, timeout, signal, providerName = "AI 服务" } = {}) {
    let requestHandle = null;
    const onAbort = () => requestHandle?.abort?.();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const response = await this.httpRequest(method, url, {
        headers: {
          ...(key ? { Authorization: `Bearer ${key}` } : {}),
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
        const error = new Error(`${providerName} HTTP ${status}: ${errorDetail(payload)}`);
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

// 保留旧导出名，避免现有外部测试或集成立即失效。
export const DeepSeekClient = OpenAICompatibleClient;

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
          provider: revision.provider || "unknown",
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
              provider: documentData.provider || "unknown",
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
    const { controller, request, config, ...fields } = job;
    return fields;
  }

  getJob(id) {
    const job = this.jobs.get(id);
    return job ? this.publicJob(job) : null;
  }

  createJob(request) {
    const now = Date.now();
    const config = Object.freeze({ ...this.configProvider() });
    const job = {
      id: this.uuid(), request, config, status: "queued", phase: "queued",
      pageCurrent: 0, pageTotal: request.pages.length,
      prepareProgress: 0,
      paragraphCurrent: 0, paragraphTotal: 0, batchCurrent: 0, batchTotal: 0, batchActive: 0,
      paragraphTranslated: 0, paragraphCached: 0, paragraphSkipped: 0, paragraphFailed: 0,
      localCacheHits: 0,
      provider: config.profileName, profileId: config.profileId, model: config.model,
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
    const config = job.config;
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
        provider: config.profileName,
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
          config,
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
                config,
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

function getPref(name, fallback) {
  try {
    const value = Zotero.Prefs.get(`${PREF_PREFIX}${name}`, true);
    return value === undefined || value === null || value === "" ? fallback : value;
  } catch { return fallback; }
}

function setPref(name, value) {
  Zotero.Prefs.set(`${PREF_PREFIX}${name}`, value, true);
}

function profileRecords() {
  let saved = [];
  try {
    const parsed = JSON.parse(String(getPref("profiles", "[]")));
    if (Array.isArray(parsed)) saved = parsed;
  } catch { /* 损坏的偏好设置回退为内置档案。 */ }
  const byId = new Map(saved.filter((item) => item && typeof item.id === "string").map((item) => [item.id, item]));
  const profiles = PROVIDER_PRESETS.map((preset) => {
    const override = byId.get(preset.id) || {};
    const legacyModel = preset.id === "deepseek" ? String(getPref("model", preset.model)) : preset.model;
    return { ...preset, model: String(override.model ?? legacyModel) };
  });
  for (const item of saved) {
    if (!item || item.builtin || PROVIDER_PRESETS.some((preset) => preset.id === item.id)) continue;
    try {
      profiles.push({
        id: String(item.id), name: String(item.name || "自定义服务"),
        baseUrl: normalizeBaseUrl(item.baseUrl), model: String(item.model || ""),
        requiresApiKey: item.requiresApiKey !== false, builtin: false,
      });
    } catch { /* 忽略无法使用的旧记录。 */ }
  }
  return profiles;
}

function persistProfiles(profiles) {
  const records = profiles.map(({ id, name, baseUrl, model, requiresApiKey, builtin }) => ({
    id, name, baseUrl, model, requiresApiKey, builtin: Boolean(builtin),
  }));
  setPref("profiles", JSON.stringify(records));
}

function activeProfileId(profiles = profileRecords()) {
  const requested = String(getPref("activeProfileId", "deepseek"));
  return profiles.some((profile) => profile.id === requested) ? requested : "deepseek";
}

function configFromPrefs(profileId = null) {
  const profiles = profileRecords();
  const id = profileId || activeProfileId(profiles);
  const profile = profiles.find((item) => item.id === id) || profiles[0];
  return {
    profileId: profile.id, providerId: profile.builtin ? profile.id : "custom",
    profileName: profile.name, baseUrl: profile.baseUrl, model: profile.model,
    requiresApiKey: profile.requiresApiKey,
    timeoutMs: Math.max(10_000, Number(getPref("timeoutMs", 90_000))),
    retryCount: Math.max(0, Number(getPref("retryCount", 2))),
    maxBatchChars: Math.max(1000, Number(getPref("maxBatchChars", 7000))),
    concurrency: Math.max(1, Math.min(4, Number(getPref("concurrency", 2)))),
    translationFontSize: normalizeTranslationFontSize(getPref("translationFontSize", 16)),
    questionContentSource: normalizeQuestionContentSource(getPref("questionContentSource", "original")),
    questionPromptTemplate: String(getPref("questionPromptTemplate", DEFAULT_QUESTION_PROMPT_TEMPLATE)),
  };
}

function requireRuntime() {
  if (!runtime) throw new Error("AI Reader Service 尚未初始化");
  return runtime;
}

export async function init() {
  if (runtime) return;
  cleanupClipboardPDFTemp({ io: IOUtils, tempRoot: clipboardTempRoot() })
    .catch((error) => Zotero.logError(error));
  const cacheDir = PathUtils.join(Zotero.DataDirectory.dir, "ai-reader-cache");
  const secrets = new SecretStore({ logins: Services.logins, createLoginInfo });
  await secrets.migrateLegacyDeepSeek();
  const cache = new CacheStore({ cacheDir, io: IOUtils, path: PathUtils });
  const translator = new OpenAICompatibleClient({
    keyProvider: (profileId) => secrets.get(profileId),
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

function localFileFromPath(path) {
  const file = Components.classes["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
  file.initWithPath(path);
  return file;
}

function leafNameFromPath(path) {
  return String(path || "").split(/[\\/]/).pop() || "";
}

export function sanitizeClipboardPDFName(value) {
  let base = String(value || "")
    .replace(/\.pdf$/i, "")
    .replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, "")
    .replace(/[<>:"/\\|?*]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .trim();
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(base)) base = `_${base}`;
  base = [...base].slice(0, 120).join("").replace(/[. ]+$/g, "").trim();
  return `${base || "paper"}.pdf`;
}

export function isOpaquePDFFilename(value) {
  const base = String(value || "").replace(/\.pdf$/i, "").trim();
  return !base || UUID_FILE_NAME.test(base) || /^[0-9a-f]{20,}$/i.test(base) || GENERIC_PDF_NAMES.test(base);
}

export function chooseClipboardPDFName(item, sourcePath) {
  const attachmentName = String(item?.attachmentFilename || leafNameFromPath(sourcePath));
  if (!isOpaquePDFFilename(attachmentName)) return sanitizeClipboardPDFName(attachmentName);
  const parentTitle = String(item?.parentItem?.getField?.("title") || "").trim();
  const attachmentTitle = String(item?.getField?.("title") || "").trim();
  const title = parentTitle || (!isOpaquePDFFilename(attachmentTitle) ? attachmentTitle : "") || attachmentName;
  return sanitizeClipboardPDFName(title);
}

export async function prepareClipboardPDF(sourcePath, desiredFileName, {
  io = globalThis.IOUtils,
  path = globalThis.PathUtils,
  tempRoot,
  uuid = () => String(Date.now()),
} = {}) {
  const sourceName = leafNameFromPath(sourcePath);
  const fileName = sanitizeClipboardPDFName(desiredFileName);
  if (sourceName === fileName) return { path: sourcePath, fileName, temporary: false };
  if (!io?.makeDirectory || !io?.copy || !path?.join || !tempRoot) {
    throw new Error("当前环境无法生成可读文件名的 PDF 副本");
  }
  const directory = path.join(tempRoot, String(uuid()).replace(/[{}]/g, ""));
  const destination = path.join(directory, fileName);
  await io.makeDirectory(directory, { createAncestors: true, ignoreExisting: true });
  await io.copy(sourcePath, destination);
  return { path: destination, fileName, temporary: true, directory };
}

export async function cleanupClipboardPDFTemp({
  io = globalThis.IOUtils,
  tempRoot,
  now = Date.now(),
  maxAgeMs = CLIPBOARD_TEMP_MAX_AGE_MS,
} = {}) {
  if (!tempRoot || !io?.getChildren || !io?.stat || !io?.remove) return 0;
  let children;
  try { children = await io.getChildren(tempRoot); } catch { return 0; }
  let removed = 0;
  for (const child of children) {
    try {
      const info = await io.stat(child);
      const modified = Number(info.lastModified || info.lastModifiedTime || 0);
      if (modified && now - modified >= maxAgeMs) {
        await io.remove(child, { recursive: true, ignoreAbsent: true });
        removed += 1;
      }
    } catch { /* 临时文件被占用时留待下次清理。 */ }
  }
  return removed;
}

function clipboardTempRoot() {
  const systemTemp = PathUtils.tempDir || Services.dirsvc.get("TmpD", Ci.nsIFile).path;
  return PathUtils.join(systemTemp, "zotero-ai-reader-clipboard");
}

function transferableForFile(file) {
  const transferable = Components.classes["@mozilla.org/widget/transferable;1"]
    .createInstance(Ci.nsITransferable);
  transferable.init(null);
  transferable.addDataFlavor("application/x-moz-file");
  try {
    transferable.setTransferData("application/x-moz-file", file);
  } catch {
    // Zotero 6/7 所用的旧 Gecko 接口还要求长度参数。
    transferable.setTransferData("application/x-moz-file", file, 0);
  }
  return transferable;
}

export async function copyLocalPDFToClipboard(path, {
  createFile = localFileFromPath,
  createTransferable = transferableForFile,
  clipboard = globalThis.Services?.clipboard,
  reveal,
} = {}) {
  const file = createFile(path);
  const fileName = String(file?.leafName || String(path).split(/[\\/]/).pop() || "PDF");
  if (!file?.exists?.() || !file?.isFile?.() || !file?.isReadable?.()) {
    throw new Error("PDF 本地文件不存在或不可读，请先在 Zotero 中恢复附件。");
  }
  try {
    if (!clipboard?.setData) throw new Error("系统剪贴板接口不可用");
    clipboard.setData(createTransferable(file), null, clipboard.kGlobalClipboard);
    return { status: "copied", fileName };
  } catch (error) {
    try {
      if (reveal) await reveal(file, path);
      else if (typeof file.reveal === "function") file.reveal();
      else throw new Error("系统不支持定位文件");
      return { status: "revealed", fileName, reason: error?.message || String(error) };
    } catch (revealError) {
      throw new Error(`无法复制 PDF，也无法在文件管理器中定位：${revealError?.message || error?.message || revealError}`);
    }
  }
}

export async function copyPDFToClipboard(itemID) {
  const item = Zotero.Items.get(itemID);
  const sourcePath = await resolvePDFAttachmentPath(item);
  const desiredFileName = chooseClipboardPDFName(item, sourcePath);
  let prepared;
  try {
    prepared = await prepareClipboardPDF(sourcePath, desiredFileName, {
      io: IOUtils,
      path: PathUtils,
      tempRoot: clipboardTempRoot(),
      uuid: () => Services.uuid.generateUUID().toString(),
    });
  } catch (error) {
    Zotero.logError(error);
    prepared = { path: sourcePath, fileName: leafNameFromPath(sourcePath), temporary: false, filenameFallback: true };
  }
  const result = await copyLocalPDFToClipboard(prepared.path, {
    clipboard: Services.clipboard,
    reveal: () => localFileFromPath(sourcePath).reveal(),
  });
  return { ...result, fileName: prepared.fileName, temporary: prepared.temporary,
    filenameFallback: Boolean(prepared.filenameFallback) };
}

export async function resolvePDFAttachmentPath(item) {
  if (!item?.isAttachment?.()) throw new Error("当前 Reader 未关联 PDF 附件。");
  const path = await item.getFilePathAsync();
  if (!path) throw new Error("当前 PDF 没有可用的本地文件。");
  const contentType = String(item.attachmentContentType || "").toLowerCase();
  if (contentType !== "application/pdf" && !/\.pdf$/i.test(path)) {
    throw new Error("当前附件不是 PDF 文件。");
  }
  return path;
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

export async function listProfiles() {
  const profiles = profileRecords();
  const activeId = activeProfileId(profiles);
  return Promise.all(profiles.map(async (profile) => ({
    ...profile, active: profile.id === activeId,
    keyStatus: profile.requiresApiKey
      ? await requireRuntime().secrets.status(profile.id)
      : { configured: true, masked: "无需密钥" },
  })));
}

export function setActiveProfile(profileId) {
  const profiles = profileRecords();
  if (!profiles.some((profile) => profile.id === profileId)) throw new Error("配置档案不存在");
  setPref("activeProfileId", profileId);
  return configFromPrefs(profileId);
}

export function upsertProfile(input) {
  const profiles = profileRecords();
  const requestedId = String(input?.id || "");
  const builtin = PROVIDER_PRESETS.find((profile) => profile.id === requestedId);
  if (builtin) {
    const index = profiles.findIndex((profile) => profile.id === requestedId);
    profiles[index] = { ...profiles[index], model: String(input.model ?? profiles[index].model) };
    persistProfiles(profiles);
    return profiles[index];
  }
  const id = requestedId.startsWith("custom-")
    ? requestedId
    : `custom-${Services.uuid.generateUUID().toString().replace(/[{}]/g, "")}`;
  const profile = {
    id, name: String(input?.name || "").trim(), baseUrl: normalizeBaseUrl(input?.baseUrl),
    model: String(input?.model || "").trim(), requiresApiKey: input?.requiresApiKey !== false, builtin: false,
  };
  if (!profile.name) throw new Error("请填写配置名称");
  const index = profiles.findIndex((item) => item.id === id);
  if (index >= 0) profiles[index] = profile;
  else profiles.push(profile);
  persistProfiles(profiles);
  return profile;
}

export async function deleteProfile(profileId) {
  const profiles = profileRecords();
  const target = profiles.find((profile) => profile.id === profileId);
  if (!target) return false;
  if (target.builtin) throw new Error("内置服务商不能删除");
  persistProfiles(profiles.filter((profile) => profile.id !== profileId));
  await requireRuntime().secrets.clear(profileId);
  if (activeProfileId(profiles) === profileId) setPref("activeProfileId", "deepseek");
  return true;
}

export function getAPIKeyStatus(profileId = null) {
  const config = configFromPrefs(profileId);
  if (!config.requiresApiKey) return Promise.resolve({ configured: true, masked: "无需密钥" });
  return requireRuntime().secrets.status(config.profileId);
}

export async function listModels(profileId = null, optionalKey = undefined) {
  const config = configFromPrefs(profileId);
  const key = optionalKey === undefined ? await requireRuntime().secrets.get(config.profileId) : String(optionalKey || "").trim();
  if (config.requiresApiKey && !key) throw new Error(`尚未配置 ${config.profileName} API Key`);
  return requireRuntime().translator.listModels(config, key);
}

export async function testConnection(profileId = null, optionalKey = undefined) {
  const config = configFromPrefs(profileId);
  const key = optionalKey === undefined ? await requireRuntime().secrets.get(config.profileId) : String(optionalKey || "").trim();
  if (config.requiresApiKey && !key) throw new Error(`尚未配置 ${config.profileName} API Key`);
  try {
    const models = await requireRuntime().translator.listModels(config, key);
    return { ok: true, models, warning: null };
  } catch (error) {
    if ([401, 403].includes(errorStatus(error))) throw error;
    return { ok: false, models: [], warning: `${error.message}；配置仍可保存，将在首次翻译时验证。` };
  }
}

export async function configureAPIKey(profileId, key) {
  if (key === undefined) { key = profileId; profileId = null; }
  const config = configFromPrefs(profileId);
  const value = String(key || "").trim();
  if (!value) throw new Error("请输入 API Key");
  const result = await testConnection(config.profileId, value);
  const status = await requireRuntime().secrets.set(value, config.profileId);
  return { ...status, warning: result.warning };
}

export async function testAPIKey(profileId = null) {
  const result = await testConnection(profileId);
  if (!result.ok) throw new Error(result.warning);
  return true;
}

export function clearAPIKey(profileId = null) {
  return requireRuntime().secrets.clear(configFromPrefs(profileId).profileId);
}

export function getSettings() {
  const config = configFromPrefs();
  return {
    profileId: config.profileId,
    model: config.model,
    timeoutMs: config.timeoutMs,
    retryCount: config.retryCount,
    maxBatchChars: config.maxBatchChars,
    concurrency: config.concurrency,
    translationFontSize: config.translationFontSize,
    questionContentSource: config.questionContentSource,
    questionPromptTemplate: config.questionPromptTemplate,
  };
}

export function saveSettings(settings) {
  const config = configFromPrefs(settings.profileId || null);
  const questionPromptTemplate = inspectQuestionPromptTemplate(
    settings.questionPromptTemplate ?? config.questionPromptTemplate,
  ).template;
  const values = {
    model: String(settings.model ?? config.model),
    timeoutMs: Math.max(10_000, Number(settings.timeoutMs || 90_000)),
    retryCount: Math.max(0, Number(settings.retryCount || 2)),
    maxBatchChars: Math.max(1000, Number(settings.maxBatchChars || 7000)),
    concurrency: Math.max(1, Math.min(4, Number(settings.concurrency || 2))),
    translationFontSize: normalizeTranslationFontSize(settings.translationFontSize),
    questionContentSource: normalizeQuestionContentSource(
      settings.questionContentSource ?? config.questionContentSource,
    ),
    questionPromptTemplate,
  };
  const profiles = profileRecords();
  const index = profiles.findIndex((profile) => profile.id === config.profileId);
  profiles[index] = { ...profiles[index], model: values.model };
  persistProfiles(profiles);
  for (const [name, value] of Object.entries(values)) {
    if (name !== "model") setPref(name, value);
  }
  return { ...values, profileId: config.profileId };
}
