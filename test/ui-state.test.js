import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";

async function loadUIHelpers() {
  const source = await fs.readFile(new URL("../plugin/content/ai-reader.js", import.meta.url), "utf8");
  const context = { result: null };
  vm.createContext(context);
  vm.runInContext(`${source}\nresult = AIReader._test;`, context);
  return context.result;
}

test("运行状态提供收起与显式取消，不再混用关闭", async () => {
  const { taskView } = await loadUIHelpers();
  const view = taskView({
    status: "running", phase: "generating", startedAt: Date.now(),
    pageCurrent: 2, pageTotal: 3, paragraphCurrent: 4, paragraphTotal: 10,
    batchCurrent: 1, batchTotal: 3, batchActive: 2,
  });
  assert.match(view.actions, /收起/);
  assert.match(view.actions, /取消任务/);
  assert.match(view.actions, /zai-button--danger/);
  assert.match(view.actions, /zai-button--primary/);
  assert.doesNotMatch(view.actions, /data-action="close"/);
  assert.equal(view.progress, 40);
});

test("完成、部分失败和取消状态使用中文结束操作", async () => {
  const { taskView } = await loadUIHelpers();
  const completed = taskView({ status: "completed", phase: "done" });
  const partial = taskView({ status: "partial", phase: "done", paragraphFailed: 2, failed: [{ error: "bad" }] });
  const cancelled = taskView({ status: "cancelled", phase: "done" });
  assert.match(completed.actions, />关闭</);
  assert.match(partial.actions, /重试失败段落/);
  assert.match(cancelled.actions, /重新开始/);
  assert.doesNotMatch(completed.actions + partial.actions + cancelled.actions, /Cancel|Retry failed/);
});

test("操作栏渲染会显式恢复可见状态", async () => {
  const { renderActions } = await loadUIHelpers();
  const container = {
    hidden: true,
    removed: false,
    innerHTML: "",
    removeAttribute(name) { if (name === "hidden") this.removed = true; },
  };
  renderActions(container, '<button data-action="start">开始翻译</button>');
  assert.equal(container.hidden, false);
  assert.equal(container.removed, true);
  assert.match(container.innerHTML, /开始翻译/);
  const source = await fs.readFile(new URL("../plugin/content/ai-reader.js", import.meta.url), "utf8");
  assert.match(source, /\.zai-actions > \.zai-button \{ display: inline-flex !important;/);
});

test("取消和失败保留实际进度，不伪装成已完成", async () => {
  const { taskView } = await loadUIHelpers();
  for (const status of ["cancelled", "failed", "partial"]) {
    assert.equal(taskView({ status, phase: "done", paragraphCurrent: 3, paragraphTotal: 10 }).progress, 30);
    assert.equal(taskView({ status, phase: "done" }).progress, 0);
  }
  assert.equal(taskView({ status: "completed", phase: "done" }).progress, 100);
});

test("相同状态轮询不重建操作按钮，保留键盘焦点", async () => {
  const { renderActions } = await loadUIHelpers();
  let writes = 0;
  let html = "";
  const container = {
    removeAttribute() {},
    get innerHTML() { return html; },
    set innerHTML(value) { writes++; html = value; },
  };
  renderActions(container, '<button data-action="close">关闭</button>');
  renderActions(container, '<button data-action="close">关闭</button>');
  assert.equal(writes, 1);
});

test("复制提问包含固定说明和完整译文", async () => {
  const { buildChatGPTPrompt } = await loadUIHelpers();
  assert.equal(
    buildChatGPTPrompt("视觉基础模型可以泛化。"),
    "请用通俗中文解释以下论文译文，并说明关键术语：\n\n视觉基础模型可以泛化。",
  );
});

test("公式复制转换为保留行内与块级语义的 Obsidian Markdown", async () => {
  const { extractObsidianMathMarkdown } = await loadUIHelpers();
  assert.deepEqual(
    [...extractObsidianMathMarkdown("行内 \\(x_i^2\\)，块级 \\[\\frac{a}{b}\n= c\\]，还有 $y=z$ 与 $$\\sum_i x_i$$。")],
    [
      "$x_i^2$",
      "$$\n\\frac{a}{b}\n= c\n$$",
      "$y=z$",
      "$$\n\\sum_i x_i\n$$",
    ],
  );
});

test("公式复制仅接收完整边界，不把零散变量或未闭合公式写入 Markdown", async () => {
  const { extractObsidianMathMarkdown } = await loadUIHelpers();
  assert.deepEqual([...extractObsidianMathMarkdown("变量 x_i、命令 \\alpha 与未闭合 \\(x+y。")], []);
  assert.deepEqual([...extractObsidianMathMarkdown("没有公式的普通译文。")], []);
});

test("纯数字方括号引文不进入公式选择器，数学方括号表达式仍保留", async () => {
  const { isPureNumericBracketCitation, extractObsidianMathMarkdown } = await loadUIHelpers();
  for (const citation of ["[40]", "[17, 24, 31]", "[17-24]", "[17–24, 31]"]) {
    assert.equal(isPureNumericBracketCitation(citation), true);
  }
  assert.equal(isPureNumericBracketCitation("[x_i]"), false);
  assert.equal(isPureNumericBracketCitation("[\\frac{a}{b}]"), false);
  assert.equal(isPureNumericBracketCitation("[17,24,31\\]"), true);
  assert.deepEqual(
    [...extractObsidianMathMarkdown("引文 \\[[40]\\]、\\([17, 24, 31]\\)、\\([17,24,31\\]\\)、\\$[17-24]$，公式 \\([x_i]\\) 与 \\([\\frac{a}{b}]\\)。")],
    ["$[x_i]$", "$[\\frac{a}{b}]$"],
  );
});

test("统一分类器排除引文、编号、标识符和普通短语，但保留明确数学表达式", async () => {
  const { classifyMathBoundaryContent, extractObsidianMathMarkdown } = await loadUIHelpers();
  const nonMath = [
    "(17; 24–31)", "(Smith et al., 2024)", "（张三等，2024）", "^12", "Fig. 2", "Table S1",
    "Section 3.1", "Eq. (4)", "Appendix A", "(1)", "[A]", "IV.", "https://example.com/paper",
    "10.1000/example", "author@example.com", "results.csv", "clinical decision support",
  ];
  for (const value of nonMath) assert.equal(classifyMathBoundaryContent(value).isMath, false, value);
  const math = ["x_i", "\\frac{a}{b}", "A \\in \\mathbb{R}^{m\\times n}", "p < 0.05", "10 mm", "5%", "12:30"];
  for (const value of math) assert.equal(classifyMathBoundaryContent(value).isMath, true, value);
  assert.deepEqual(
    [...extractObsidianMathMarkdown("\\(Fig. 2\\) \\(Smith et al., 2024\\) \\(10.1000/example\\) \\(clinical decision support\\) \\(x_i\\) \\(p < 0.05\\) \\(10 mm\\)")],
    ["$x_i$", "$p < 0.05$", "$10 mm$"],
  );
});

test("公式选择默认不选，并始终按论文原始顺序复制所选公式", async () => {
  const { selectedFormulaState } = await loadUIHelpers();
  const formulas = ["$first$", "$$\nsecond\n$$", "$third$"];
  const none = selectedFormulaState(formulas, []);
  assert.equal(none.count, 0);
  assert.equal(none.markdown, "");
  const one = selectedFormulaState(formulas, [1]);
  assert.equal(one.count, 1);
  assert.equal(one.markdown, "$$\nsecond\n$$");
  const multiple = selectedFormulaState(formulas, [2, 0]);
  assert.equal(multiple.count, 2);
  assert.equal(multiple.markdown, "$first$\n\n$third$");
});

test("译文浮层样式允许选择、交互和自定义字号", async () => {
  const source = await fs.readFile(new URL("../plugin/content/ai-reader.js", import.meta.url), "utf8");
  assert.match(source, /pointer-events: auto; user-select: text/);
  assert.match(source, /font-size: var\(--zai-translation-font-size, 16px\)/);
  assert.match(source, /复制译文/);
  assert.match(source, /选择公式（\$\{formulas\.length\}）/);
  assert.match(source, /复制选中公式（\$\{state\.count\}）/);
  assert.match(source, /复制提问/);
  assert.match(source, /copySelected\.disabled = true/);
  assert.match(source, /aria-expanded", "false/);
  assert.match(source, /zai-formula-option/);
  assert.match(source, /已复制 \$\{state\.count\} 条公式，可直接粘贴到 Obsidian。/);
  assert.match(source, /overscroll-behavior: contain/);
  assert.match(source, /renderMathText\(doc, translation, paragraph\.translation\)/);
  assert.doesNotMatch(source, /layer\.addEventListener\("mousemove"/);
  assert.match(source, /tooltip\.addEventListener\("wheel"/);
});

test("公式渲染保留普通文本并支持嵌套上下标、分式和根号", async () => {
  const { renderMathText } = await loadUIHelpers();
  const element = (tagName = "span") => ({
    tagName, className: "", textContent: "", children: [],
    append(...nodes) { this.children.push(...nodes); },
  });
  const doc = {
    createElement: element,
    createTextNode: (textContent) => ({ tagName: "#text", textContent, children: [] }),
  };
  const container = element("div");
  renderMathText(doc, container, "分布 \\(\\mathcal{D}=\\{(x_i,y_i)\\}_{i=1}^{N}\\)，损失 \\(\\frac{a_i}{\\sqrt{b^2}}\\)。");
  const classes = [];
  const text = [];
  const visit = (node) => {
    if (node.className) classes.push(node.className);
    if (node.textContent) text.push(node.textContent);
    node.children.forEach(visit);
  };
  visit(container);
  assert.match(text.join(""), /分布 .*D=.*x.*i.*y.*i.*损失/);
  assert.ok(classes.some((value) => value.includes("zai-math-frac")));
  assert.ok(classes.some((value) => value.includes("zai-math-sqrt")));
  assert.ok(classes.filter((value) => value.includes("zai-math-script")).length >= 4);
});

test("历史缓存中被数学边界包裹的数字引文按普通文本渲染", async () => {
  const { renderMathText } = await loadUIHelpers();
  const element = (tagName = "span") => ({
    tagName, className: "", textContent: "", children: [],
    append(...nodes) { this.children.push(...nodes); },
  });
  const doc = { createElement: element, createTextNode: (textContent) => ({ tagName: "#text", textContent, children: [] }) };
  const container = element("div");
  renderMathText(doc, container, "参见 \\([17–24, 31\\]\\)，并计算 \\(x_i^2\\)。");
  const classes = [];
  const text = [];
  const visit = (node) => {
    if (node.className) classes.push(node.className);
    if (node.textContent) text.push(node.textContent);
    node.children.forEach(visit);
  };
  visit(container);
  assert.match(text.join(""), /参见 \[17–24, 31\]，并计算/);
  assert.equal(classes.filter((value) => value === "zai-math").length, 1);
});

test("非公式边界内容渲染为普通文本，不创建 KaTeX 节点", async () => {
  const { renderMathText } = await loadUIHelpers();
  const element = (tagName = "span") => ({
    tagName, className: "", textContent: "", children: [],
    append(...nodes) { this.children.push(...nodes); },
  });
  const doc = { createElement: element, createTextNode: (textContent) => ({ tagName: "#text", textContent, children: [] }) };
  const container = element("div");
  renderMathText(doc, container, "\\(Fig. 2\\)、\\([17,24,31\\]\\)、\\(Smith et al., 2024\\)、\\(https://example.com\\) 与 \\(x_i^2\\)");
  const classes = [];
  const text = [];
  const visit = (node) => {
    if (node.className) classes.push(node.className);
    if (node.textContent) text.push(node.textContent);
    node.children.forEach(visit);
  };
  visit(container);
  assert.match(text.join(""), /Fig\. 2.*\[17,24,31\].*Smith et al\., 2024.*https:\/\/example\.com/);
  assert.equal(classes.filter((value) => value === "zai-math").length, 1);
});

test("漏掉公式边界时仍能识别 LaTeX 命令和上下标", async () => {
  const { renderMathText } = await loadUIHelpers();
  const element = (tagName = "span") => ({
    tagName, className: "", textContent: "", children: [],
    append(...nodes) { this.children.push(...nodes); },
  });
  const doc = { createElement: element, createTextNode: (textContent) => ({ tagName: "#text", textContent, children: [] }) };
  const container = element("div");
  renderMathText(doc, container, "其中 \\tilde{y}_i = y_i + \\varepsilon_i，且 Z_i=f(x_i) 为预测。");
  const classes = [];
  const text = [];
  const visit = (node) => {
    if (node.className) classes.push(node.className);
    if (node.textContent) text.push(node.textContent);
    node.children.forEach(visit);
  };
  visit(container);
  assert.ok(classes.filter((value) => value.includes("zai-math")).length >= 5);
  assert.match(text.join(""), /其中.*y.*i.*ε.*i.*Z.*i.*f.*x.*i.*为预测/);
});

test("页码区域使用紧凑的正文范围识别按钮并移除手动排除提示", async () => {
  const source = await fs.readFile(new URL("../plugin/content/ai-reader.js", import.meta.url), "utf8");
  assert.match(source, /data-action="detect-range"/);
  assert.match(source, />识别正文范围<\/button>/);
  assert.doesNotMatch(source, /可手动排除 References/);
});

test("不渲染图表文本和旧缓存中的大面积图表覆盖层", async () => {
  const { shouldRenderParagraph } = await loadUIHelpers();
  const base = {
    translation: "译文", summary: "摘要", bbox: [0, 0, 300, 100], page_width: 600, page_height: 800,
  };
  assert.equal(shouldRenderParagraph({ ...base, block_type: "paragraph" }), true);
  assert.equal(shouldRenderParagraph({ ...base, block_type: "caption" }), true);
  assert.equal(shouldRenderParagraph({ ...base, block_type: "table" }), false);
  assert.equal(shouldRenderParagraph({ ...base, block_type: "image" }), false);
  assert.equal(shouldRenderParagraph({ ...base, block_type: undefined, bbox: [0, 0, 500, 400] }), false);
});

test("翻译弹窗提供可收起的译文字号设置", async () => {
  const source = await fs.readFile(new URL("../plugin/content/ai-reader.js", import.meta.url), "utf8");
  assert.match(source, /data-action="toggle-settings"/);
  assert.match(source, /class="zai-font-slider" type="range" min="12" max="22"/);
  assert.match(source, /data-action="save-font"/);
  assert.match(source, /译文字号预览/);
  assert.match(source, /zai-button--secondary zai-button--compact/);
});

test("Reader 打开后自动检查缓存并持续等待 PDF 页面挂载", async () => {
  const { renderOverlays } = await loadUIHelpers();
  let tick;
  const hostDoc = {
    defaultView: {
      setInterval(callback) { tick = callback; return 1; },
      clearInterval() {}, addEventListener() {}, removeEventListener() {},
    },
  };
  const appended = [];
  const page = {
    style: {},
    querySelector() { return null; },
    append(node) { appended.push(node); },
  };
  const viewerDoc = {
    body: {}, head: { append() {} },
    defaultView: { getComputedStyle: () => ({ position: "static" }) },
    getElementById() { return null; },
    querySelector(selector) { return selector.startsWith(".page[data-page-number") ? page : null; },
    querySelectorAll() { return []; },
    createElement() {
      return { className: "", dataset: {}, style: {}, setAttribute() {}, addEventListener() {} };
    },
    addEventListener() {}, removeEventListener() {},
  };
  const reader = {};
  renderOverlays(reader, hostDoc, {
    paragraphs: {
      one: {
        paragraph_id: "p1", paragraph_hash: "hash", page: 1,
        bbox: [10, 20, 30, 40], page_width: 100, page_height: 200,
        block_type: "paragraph", translation: "译文", summary: "摘要",
      },
    },
  });
  assert.equal(appended.length, 0);
  reader._iframeWindow = { document: viewerDoc };
  tick();
  assert.deepEqual(appended.map((node) => node.className), ["zai-page-badge", "zai-paragraph-layer"]);

  const source = await fs.readFile(new URL("../plugin/content/ai-reader.js", import.meta.url), "utf8");
  assert.match(source, /restoreCached\(reader, doc, task\)/);
  assert.match(source, /setInterval\(ensureAttached, 1000\)/);
  assert.match(source, /overlayStates\.get\(reader\)/);
  assert.doesNotMatch(source, /overlayStates\.get\(itemID\)/);
  assert.match(source, /label = "已有译文"/);
  assert.match(source, /译文已自动显示/);
});

test("已有缓存时提供明确的重新翻译入口和费用确认", async () => {
  const source = await fs.readFile(new URL("../plugin/content/ai-reader.js", import.meta.url), "utf8");
  assert.match(source, /data-action="force-start"/);
  assert.match(source, /重新翻译所选页/);
  assert.match(source, /翻译未缓存内容/);
  assert.match(source, /zai-button--secondary/);
  assert.doesNotMatch(source, /class="danger" data-action="force-start"/);
  assert.match(source, /会调用模型并产生 API 费用/);
  assert.match(source, /forceRetranslate: requestedForce/);
});

test("翻译弹窗使用统一按钮层级、缓存提示和紧凑指标", async () => {
  const source = await fs.readFile(new URL("../plugin/content/ai-reader.js", import.meta.url), "utf8");
  assert.match(source, /zai-dialog-header/);
  assert.match(source, /zai-cache-note/);
  assert.match(source, /class="zai-metric"/);
  assert.match(source, /--zai-control-height: 36px/);
  assert.match(source, /zai-button--ghost/);
  assert.match(source, /zai-button--danger/);
  assert.doesNotMatch(source, /\.zai-actions \.danger \{ margin-right: auto/);
});

test("窄屏、深色模式与工具栏缓存计数具备专门样式", async () => {
  const source = await fs.readFile(new URL("../plugin/content/ai-reader.js", import.meta.url), "utf8");
  assert.match(source, /@media \(max-width: 440px\)/);
  assert.match(source, /@media \(prefers-color-scheme: dark\)/);
  assert.match(source, /\$\{task\.cacheStats\.translatedParagraphs\} 段/);
  assert.match(source, /已缓存 \$\{count\} 译文/);
});
