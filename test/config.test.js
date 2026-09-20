import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_QUESTION_PROMPT_TEMPLATE,
  SecretStore,
  buildQuestionPrompt,
  chooseClipboardPDFName,
  cleanupClipboardPDFTemp,
  copyLocalPDFToClipboard,
  createAbortController,
  getSettings,
  inspectQuestionPromptTemplate,
  normalizeBaseUrl,
  normalizeQuestionContentSource,
  normalizeTranslationFontSize,
  prepareClipboardPDF,
  resolvePDFAttachmentPath,
  sanitizeClipboardPDFName,
  saveSettings,
} from "../plugin-src/service.js";

test("译文字号仅接受 12 至 22px 的整数，非法值回退默认值", () => {
  assert.equal(normalizeTranslationFontSize(12), 12);
  assert.equal(normalizeTranslationFontSize("18.6"), 19);
  assert.equal(normalizeTranslationFontSize(22), 22);
  for (const value of [undefined, "", 11, 23, "invalid"]) {
    assert.equal(normalizeTranslationFontSize(value), 16);
  }
});

test("提问模板支持三种内容来源和全部安全变量", () => {
  const paragraph = {
    page: 7, original: "An English paragraph.", translation: "一段中文译文。", summary: "摘要。",
  };
  assert.equal(normalizeQuestionContentSource("bad"), "original");
  assert.match(buildQuestionPrompt(paragraph, {
    questionContentSource: "original", questionPromptTemplate: DEFAULT_QUESTION_PROMPT_TEMPLATE,
  }), /An English paragraph\.$/);
  assert.equal(buildQuestionPrompt(paragraph, {
    questionContentSource: "translation", questionPromptTemplate: "{content}",
  }), "一段中文译文。");
  assert.equal(buildQuestionPrompt(paragraph, {
    questionContentSource: "bilingual", questionPromptTemplate: "{content}",
  }), "英文原文：\nAn English paragraph.\n\n中文译文：\n一段中文译文。");
  assert.equal(buildQuestionPrompt(paragraph, {
    questionPromptTemplate: "P{page}|{original}|{translation}|{summary}",
  }), "P7|An English paragraph.|一段中文译文。|摘要。");
});

test("提问模板缺失内容时回退，未知变量保留并警告", () => {
  assert.equal(buildQuestionPrompt({ original: "English" }, {
    questionContentSource: "translation", questionPromptTemplate: "{content}",
  }), "English");
  assert.equal(buildQuestionPrompt({ translation: "中文" }, {
    questionContentSource: "original", questionPromptTemplate: "{content}",
  }), "中文");
  const unknown = inspectQuestionPromptTemplate("自定义 {mystery}");
  assert.deepEqual(unknown.unknownVariables, ["mystery"]);
  assert.equal(unknown.hasParagraphVariable, false);
  assert.equal(buildQuestionPrompt({}, { questionPromptTemplate: "自定义 {mystery}" }), "自定义 {mystery}");
  assert.throws(() => inspectQuestionPromptTemplate(" \n "), /不能为空/);
});

test("提问设置首次升级使用默认值，保存后不覆盖其他设置", () => {
  const previous = globalThis.Zotero;
  const values = new Map();
  globalThis.Zotero = { Prefs: {
    get: (name) => values.get(name),
    set: (name, value) => values.set(name, value),
  } };
  try {
    const defaults = getSettings();
    assert.equal(defaults.questionContentSource, "original");
    assert.equal(defaults.questionPromptTemplate, DEFAULT_QUESTION_PROMPT_TEMPLATE);
    const saved = saveSettings({ ...defaults, timeoutMs: 120000,
      questionContentSource: "translation", questionPromptTemplate: "第 {page} 页：{content}" });
    assert.equal(saved.timeoutMs, 120000);
    assert.equal(getSettings().questionContentSource, "translation");
    assert.equal(getSettings().questionPromptTemplate, "第 {page} 页：{content}");
    assert.throws(() => saveSettings({ ...getSettings(), questionPromptTemplate: "" }), /不能为空/);
  } finally {
    globalThis.Zotero = previous;
  }
});

test("PDF 文件以 application\/x-moz-file 写入剪贴板", async () => {
  const calls = [];
  const file = { leafName: "paper.pdf", exists: () => true, isFile: () => true, isReadable: () => true };
  const result = await copyLocalPDFToClipboard("C:\\papers\\paper.pdf", {
    createFile: () => file,
    createTransferable: (value) => { calls.push(["transfer", value]); return { flavor: "application/x-moz-file" }; },
    clipboard: { kGlobalClipboard: 1, setData: (...args) => calls.push(["clipboard", ...args]) },
  });
  assert.deepEqual(result, { status: "copied", fileName: "paper.pdf" });
  assert.equal(calls[0][1], file);
  assert.equal(calls[1][1].flavor, "application/x-moz-file");
});

test("PDF 智能命名保留正常附件名，UUID 和通用名回退论文标题", () => {
  const item = (attachmentFilename, parentTitle = "A Study of Foundation Models", attachmentTitle = "PDF") => ({
    attachmentFilename,
    parentItem: { getField: () => parentTitle },
    getField: () => attachmentTitle,
  });
  assert.equal(chooseClipboardPDFName(item("authors-2026-models.pdf"), "C:\\z\\uuid.pdf"), "authors-2026-models.pdf");
  assert.equal(chooseClipboardPDFName(item("a691caca-8be2-40e7-a9d2-86963f4924e1.pdf"), "uuid.pdf"), "A Study of Foundation Models.pdf");
  assert.equal(chooseClipboardPDFName(item("fulltext.pdf", "肿瘤边界：方法/评估"), "fulltext.pdf"), "肿瘤边界：方法 评估.pdf");
  assert.equal(chooseClipboardPDFName(item("document.pdf", "", "Readable attachment title"), "document.pdf"), "Readable attachment title.pdf");
});

test("PDF 文件名清理非法字符、Windows 保留名并限制长度", () => {
  assert.equal(sanitizeClipboardPDFName("CON.pdf"), "_CON.pdf");
  assert.equal(sanitizeClipboardPDFName("  a:b*c?  .pdf"), "a b c.pdf");
  assert.equal([...sanitizeClipboardPDFName("论".repeat(200))].length, 124);
});

test("PDF 只在需要改名时生成临时副本，原附件保持不变", async () => {
  const calls = [];
  const io = {
    makeDirectory: async (...args) => calls.push(["mkdir", ...args]),
    copy: async (...args) => calls.push(["copy", ...args]),
  };
  const path = { join: (...parts) => parts.join("/") };
  assert.deepEqual(await prepareClipboardPDF("C:\\papers\\readable.pdf", "readable.pdf", {
    io, path, tempRoot: "C:/temp/root", uuid: () => "id",
  }), { path: "C:\\papers\\readable.pdf", fileName: "readable.pdf", temporary: false });
  const prepared = await prepareClipboardPDF("C:\\papers\\uuid.pdf", "论文标题.pdf", {
    io, path, tempRoot: "C:/temp/root", uuid: () => "copy-id",
  });
  assert.deepEqual(prepared, {
    path: "C:/temp/root/copy-id/论文标题.pdf", fileName: "论文标题.pdf",
    temporary: true, directory: "C:/temp/root/copy-id",
  });
  assert.deepEqual(calls[1], ["copy", "C:\\papers\\uuid.pdf", "C:/temp/root/copy-id/论文标题.pdf"]);
});

test("临时 PDF 副本只清理超过 24 小时的目录", async () => {
  const removed = [];
  const now = Date.now();
  const io = {
    getChildren: async () => ["old", "recent", "busy"],
    stat: async (path) => {
      if (path === "busy") throw new Error("locked");
      return { lastModified: path === "old" ? now - 24 * 60 * 60 * 1000 : now - 1000 };
    },
    remove: async (path) => removed.push(path),
  };
  assert.equal(await cleanupClipboardPDFTemp({ io, tempRoot: "temp", now }), 1);
  assert.deepEqual(removed, ["old"]);
});

test("PDF 剪贴板失败时定位文件，无效文件直接报错", async () => {
  const file = { leafName: "paper.pdf", exists: () => true, isFile: () => true, isReadable: () => true };
  let revealed = false;
  const result = await copyLocalPDFToClipboard("paper.pdf", {
    createFile: () => file,
    createTransferable: () => ({}),
    clipboard: { kGlobalClipboard: 1, setData: () => { throw new Error("denied"); } },
    reveal: async (value) => { revealed = value === file; },
  });
  assert.equal(result.status, "revealed");
  assert.equal(revealed, true);
  await assert.rejects(copyLocalPDFToClipboard("missing.pdf", {
    createFile: () => ({ exists: () => false }), clipboard: {},
  }), /不存在或不可读/);
});

test("PDF 附件解析拒绝非附件、缺失路径和非 PDF", async () => {
  await assert.rejects(resolvePDFAttachmentPath(null), /未关联 PDF/);
  await assert.rejects(resolvePDFAttachmentPath({
    isAttachment: () => true, getFilePathAsync: async () => "",
  }), /没有可用的本地文件/);
  await assert.rejects(resolvePDFAttachmentPath({
    isAttachment: () => true, getFilePathAsync: async () => "notes.txt", attachmentContentType: "text/plain",
  }), /不是 PDF/);
  assert.equal(await resolvePDFAttachmentPath({
    isAttachment: () => true, getFilePathAsync: async () => "paper.pdf", attachmentContentType: "",
  }), "paper.pdf");
});

function fakeLoginManager() {
  const records = [];
  return {
    records,
    searches: [],
    async searchLoginsAsync(query) {
      this.searches.push(query);
      return records.filter((login) => login.origin === query.origin && login.httpRealm === query.httpRealm);
    },
    async addLoginAsync(login) { records.push(login); },
    async modifyLoginAsync(oldLogin, newLogin) { records.splice(records.indexOf(oldLogin), 1, newLogin); },
    async removeLoginAsync(login) { records.splice(records.indexOf(login), 1); },
  };
}

test("API Key 只通过登录存储读写且状态不会回显原文", async () => {
  const logins = fakeLoginManager();
  const store = new SecretStore({
    logins,
    createLoginInfo: (origin, formActionOrigin, httpRealm, username, password) => ({
      origin, formActionOrigin, httpRealm, username, password,
    }),
  });
  await store.set("sk-super-secret-1234");
  assert.deepEqual(logins.searches[0], {
    origin: "https://zotero-ai-reader.local",
    httpRealm: "Zotero AI Reader API Key",
  });
  assert.equal(await store.get(), "sk-super-secret-1234");
  const status = await store.status();
  assert.deepEqual(status, { configured: true, masked: "••••1234" });
  assert.doesNotMatch(JSON.stringify(status), /super-secret/);
  await store.set("sk-replacement-5678");
  assert.equal(logins.records.length, 1);
  assert.equal(await store.get(), "sk-replacement-5678");
  await store.clear();
  assert.deepEqual(await store.status(), { configured: false, masked: "" });
});

test("API Key 按配置档案隔离", async () => {
  const logins = fakeLoginManager();
  const store = new SecretStore({
    logins,
    createLoginInfo: (origin, formActionOrigin, httpRealm, username, password) => ({
      origin, formActionOrigin, httpRealm, username, password,
    }),
  });
  await store.set("deepseek-key", "deepseek");
  await store.set("openai-key", "openai");
  assert.equal(await store.get("deepseek"), "deepseek-key");
  assert.equal(await store.get("openai"), "openai-key");
  await store.clear("openai");
  assert.equal(await store.get("deepseek"), "deepseek-key");
  assert.equal(await store.get("openai"), "");
});

test("Base URL 规范化并限制非安全 HTTP", () => {
  assert.equal(normalizeBaseUrl("https://example.com/v1///"), "https://example.com/v1");
  assert.equal(normalizeBaseUrl("http://localhost:11434/v1/"), "http://localhost:11434/v1");
  assert.equal(normalizeBaseUrl("http://192.168.1.9:8000/v1"), "http://192.168.1.9:8000/v1");
  assert.equal(normalizeBaseUrl("http://model.local/v1"), "http://model.local/v1");
  assert.throws(() => normalizeBaseUrl("http://example.com/v1"), /HTTPS/);
  assert.throws(() => normalizeBaseUrl("ftp://example.com"), /HTTP/);
  assert.throws(() => normalizeBaseUrl("https://user:pass@example.com/v1"), /用户名/);
  assert.throws(() => normalizeBaseUrl("https://example.com/v1?token=secret"), /查询参数/);
});

test("Zotero 插件沙箱缺少 AbortController 时仍可取消任务", () => {
  const controller = createAbortController(null);
  let calls = 0;
  const listener = () => { calls += 1; };
  controller.signal.addEventListener("abort", listener, { once: true });
  controller.abort();
  controller.abort();
  assert.equal(controller.signal.aborted, true);
  assert.equal(calls, 1);
});
