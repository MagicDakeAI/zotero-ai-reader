var AIReader = (() => {
  const PLUGIN_ID = "zotero-ai-reader@local";
  const overlayStates = new Map();
  const taskStates = new Map();
  const tooltipCloseTimers = new WeakMap();
  const CHATGPT_EXPLANATION_PREFIX = "请用通俗中文解释以下论文译文，并说明关键术语：\n\n";
  let toolbarHandler;
  let pluginRootURI = "";

  function init({ rootURI = "" } = {}) {
    pluginRootURI = rootURI;
    toolbarHandler = ({ reader, doc, append }) => {
      const itemID = reader._itemID || reader.itemID;
      if (!itemID || doc.getElementById("zotero-ai-reader-button")) return;
      injectStyles(doc);
      const button = doc.createElement("button");
      button.id = "zotero-ai-reader-button";
      button.className = "toolbar-button zotero-ai-reader-button";
      button.type = "button";
      button.innerHTML = '<span class="zai-toolbar-icon" aria-hidden="true"></span><span class="zai-toolbar-label">AI 翻译</span><span class="zai-toolbar-count" hidden></span>';
      button.title = "仅处理选择的 PDF 页面";
      const task = getTaskState(itemID);
      task.buttons.add(button);
      task.reader = reader;
      task.doc = doc;
      button.addEventListener("click", () => openDialog(reader, doc, task));
      append(button);
      updateToolbar(task);
      restoreCached(reader, doc, task).catch((error) => {
        task.cacheStatus = "error";
        task.cacheError = error.message;
        updateToolbar(task);
        Zotero.logError(error);
      });
    };
    Zotero.Reader.registerEventListener("renderToolbar", toolbarHandler, PLUGIN_ID);
  }

  function shutdown() {
    if (toolbarHandler) Zotero.Reader.unregisterEventListener("renderToolbar", toolbarHandler);
    for (const state of overlayStates.values()) state.stop?.();
    for (const task of taskStates.values()) task.stopped = true;
    overlayStates.clear();
    taskStates.clear();
  }

  // Zotero 10 的 reader._iframeWindow 指向外层 reader.html；PDF.js 实际位于
  // internalReader 的 primary view iframe。保留外层窗口作为旧版本的兜底。
  function getPDFWindow(reader) {
    return reader?._internalReader?._primaryView?._iframeWindow
      || reader?._internalReader?._primaryView?._iframe?.contentWindow
      || reader?._iframeWindow;
  }

  // Zotero 的 Reader 层级会随版本和阅读器布局变化。不能假定某个私有 iframe
  // 一定就是 PDF.js；从候选文档中选择实际包含 PDF 页面节点的那个。
  function getPDFDocument(reader) {
    const documents = [];
    const seen = new Set();
    const collect = (win) => {
      const doc = win?.document;
      if (!doc || seen.has(doc)) return;
      seen.add(doc);
      documents.push(doc);
      for (const frame of doc.querySelectorAll("iframe")) {
        try { collect(frame.contentWindow); } catch { /* 非同源 frame 不影响 PDF Reader */ }
      }
    };
    collect(getPDFWindow(reader));
    collect(reader?._internalReader?._iframeWindow);
    collect(reader?._iframeWindow);
    return documents.find((doc) => doc.querySelector(".page[data-page-number]")) || null;
  }

  function getPDFApplication(reader) {
    const win = getPDFWindow(reader);
    return win?.wrappedJSObject?.PDFViewerApplication || win?.PDFViewerApplication;
  }

  function getTotalPages(reader) {
    const app = getPDFApplication(reader);
    return Number(
      app?.pdfDocument?.numPages
      || app?.pagesCount
      || app?.pdfViewer?.pagesCount
      || app?.pdfViewer?._pages?.length
      || 0,
    );
  }

  async function waitForTotalPages(reader) {
    for (let count = 0; count < 100; count += 1) {
      const total = getTotalPages(reader);
      if (total) return total;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("PDF 尚未完成加载，请稍后重试");
  }

  async function restoreCached(reader, doc, task = getTaskState(reader._itemID || reader.itemID)) {
    const itemID = reader._itemID || reader.itemID;
    task.cacheStatus = "loading";
    updateToolbar(task);
    const restored = await Zotero.AIReaderService.restore({ itemID });
    if (!restored.hit) {
      task.cacheStatus = "miss";
      task.cacheStats = restored.stats;
      return updateToolbar(task);
    }
    task.cacheStatus = "hit";
    task.cacheStats = restored.stats || restored.cache?.stats;
    task.restoredCache = restored.cache;
    updateToolbar(task);
    renderOverlays(reader, doc, restored.cache);
  }

  function getTaskState(itemID) {
    if (!taskStates.has(itemID)) {
      taskStates.set(itemID, {
        itemID, buttons: new Set(), job: null, jobId: null, lastRequest: null,
        modal: null, reader: null, doc: null, polling: false, stopped: false,
        resultRenderedFor: null, cacheStatus: "unknown", cacheStats: null,
        restoredCache: null, cacheError: null,
      });
    }
    return taskStates.get(itemID);
  }

  async function openDialog(reader, doc, task) {
    task.reader = reader;
    task.doc = doc;
    if (task.modal?.isConnected) {
      task.modal.querySelector(".zai-dialog")?.focus();
      return;
    }
    let totalPages = task.lastRequest?.totalPages || 0;
    if (!task.job) {
      totalPages = await waitForTotalPages(reader).catch((error) => {
        reader._iframeWindow.alert(error.message);
        return 0;
      });
      if (!totalPages) return;
    }
    task.keyStatus = await Zotero.AIReaderService.getAPIKeyStatus().catch(() => ({ configured: false, masked: "" }));
    const displaySettings = Zotero.AIReaderService.getSettings?.() || { translationFontSize: 16 };

    const modal = doc.createElement("div");
    modal.id = "zotero-ai-reader-modal";
    modal.innerHTML = `
      <div class="zai-dialog" role="dialog" aria-modal="true" aria-labelledby="zai-title" tabindex="-1">
        <header class="zai-dialog-header">
          <div><h2 id="zai-title">AI 翻译</h2><p class="zai-dialog-subtitle">选择页面后，本地缓存会优先复用。</p></div>
          <div class="zai-dialog-tools">
            <button type="button" class="zai-settings-toggle zai-icon-button" data-action="toggle-settings" aria-label="译文显示设置" aria-expanded="false">⚙</button>
            <button type="button" class="zai-close zai-icon-button" data-action="close" aria-label="关闭任务卡片">×</button>
          </div>
        </header>
        <div class="zai-display-settings" hidden>
          <div class="zai-settings-heading">译文字号</div>
          <div class="zai-font-control">
            <input class="zai-font-slider" type="range" min="12" max="22" step="1" value="${displaySettings.translationFontSize}" aria-label="译文字号">
            <output class="zai-font-value">${displaySettings.translationFontSize} px</output>
            <button type="button" class="zai-save-font zai-button zai-button--secondary zai-button--compact" data-action="save-font">保存</button>
          </div>
          <div class="zai-font-preview" style="font-size:${displaySettings.translationFontSize}px">译文字号预览</div>
          <div class="zai-font-feedback" role="status" aria-live="polite"></div>
        </div>
        <div class="zai-key-setup" hidden>
          <p><strong>首次使用</strong></p>
          <p>填写 DeepSeek API Key。验证成功后会保存到 Zotero 的加密登录存储中。</p>
          <label>API Key <input class="zai-api-key" type="password" placeholder="sk-…" autocomplete="off"></label>
          <p class="zai-help">验证连接不会产生模型 Token；插件不会把密钥写入日志或翻译缓存。</p>
        </div>
        <div class="zai-setup">
          <p>PDF 共 <strong>${totalPages}</strong> 页，只处理你选择的页面。</p>
          <label>页码 <span class="zai-page-row"><input class="zai-pages" value="${task.lastRequest?.pageRange || `1-${totalPages}`}" placeholder="1-8,10,12-15"><button type="button" class="zai-detect-range zai-button zai-button--secondary" data-action="detect-range">识别正文范围</button></span></label>
          <div class="zai-range-result" role="status" aria-live="polite" hidden></div>
          <div class="zai-cache-note" role="status" hidden></div>
        </div>
        <div class="zai-status" role="status" aria-live="polite" hidden>
          <div class="zai-status-row"><span class="zai-status-icon"></span><div><strong class="zai-status-title"></strong><div class="zai-status-detail"></div></div></div>
          <div class="zai-stages" aria-label="任务阶段"></div>
          <progress class="zai-progress-bar" max="100" aria-label="当前阶段进度"></progress>
          <div class="zai-progress-meta"></div>
          <div class="zai-counts"></div>
          <div class="zai-tokens" hidden></div>
        </div>
        <div class="zai-error" role="alert" hidden></div>
        <div class="zai-actions"></div>
      </div>`;
    doc.body.append(modal);
    task.modal = modal;
    task.returnFocus = [...task.buttons].find((button) => button.isConnected) || null;

    const close = () => closeDialog(task);
    modal.addEventListener("click", (event) => {
      if (event.target === modal) close();
      const action = event.target.closest?.("[data-action]")?.dataset.action;
      if (!action || action === "close") return action === "close" ? close() : undefined;
      if (action === "start") return startTask(task, false);
      if (action === "force-start") return startForcedTask(task);
      if (action === "toggle-settings") return toggleDisplaySettings(task);
      if (action === "save-font") return saveTranslationFontSize(task);
      if (action === "detect-range") return detectRange(task, totalPages);
      if (action === "collapse") return close();
      if (action === "cancel-job") return cancelTask(task);
      if (action === "retry") return startTask(task, true);
      if (action === "restart") return startTask(task, false, true);
      if (action === "save-key") return configureKeyFromDialog(task);
    });
    modal.addEventListener("input", (event) => {
      if (!event.target.matches?.(".zai-font-slider")) return;
      const value = event.target.value;
      modal.querySelector(".zai-font-value").textContent = `${value} px`;
      modal.querySelector(".zai-font-preview").style.fontSize = `${value}px`;
      modal.querySelector(".zai-font-feedback").textContent = "";
    });
    task.keyHandler = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
      }
      if (event.key === "Tab") {
        const targets = [...modal.querySelectorAll('button, input, [tabindex="0"]')]
          .filter((node) => !node.disabled && node.getClientRects().length);
        const first = targets[0];
        const last = targets[targets.length - 1];
        if (event.shiftKey && (doc.activeElement === first || !targets.includes(doc.activeElement))) {
          event.preventDefault(); last?.focus();
        } else if (!event.shiftKey && (doc.activeElement === last || !targets.includes(doc.activeElement))) {
          event.preventDefault(); first?.focus();
        }
      }
    };
    doc.addEventListener("keydown", task.keyHandler, true);
    renderTaskDialog(task);
    (task.job ? modal.querySelector('.zai-dialog') : task.keyStatus?.configured
      ? modal.querySelector(".zai-pages")
      : modal.querySelector(".zai-api-key"))?.focus();
  }

  function toggleDisplaySettings(task) {
    const panel = task.modal?.querySelector(".zai-display-settings");
    const toggle = task.modal?.querySelector(".zai-settings-toggle");
    if (!panel || !toggle) return;
    panel.hidden = !panel.hidden;
    toggle.setAttribute("aria-expanded", panel.hidden ? "false" : "true");
    if (!panel.hidden) panel.querySelector(".zai-font-slider")?.focus();
  }

  function saveTranslationFontSize(task) {
    const slider = task.modal?.querySelector(".zai-font-slider");
    const feedback = task.modal?.querySelector(".zai-font-feedback");
    if (!slider || !feedback) return;
    try {
      const settings = Zotero.AIReaderService.getSettings();
      const saved = Zotero.AIReaderService.saveSettings({ ...settings, translationFontSize: slider.value });
      slider.value = saved.translationFontSize;
      task.modal.querySelector(".zai-font-value").textContent = `${saved.translationFontSize} px`;
      task.modal.querySelector(".zai-font-preview").style.fontSize = `${saved.translationFontSize}px`;
      feedback.textContent = `已保存 ${saved.translationFontSize} px，重新悬停译文即可看到。`;
    } catch (error) {
      feedback.textContent = `保存失败：${error.message}`;
    }
  }

  async function detectRange(task, totalPages) {
    if (task.detectingRange || !task.modal?.isConnected) return;
    const button = task.modal.querySelector(".zai-detect-range");
    const input = task.modal.querySelector(".zai-pages");
    const resultBox = task.modal.querySelector(".zai-range-result");
    task.detectingRange = true;
    button.disabled = true;
    button.textContent = "识别中…";
    resultBox.hidden = false;
    resultBox.dataset.state = "working";
    resultBox.textContent = "正在本地检查 References 位置…";
    try {
      const detected = await Zotero.AIReaderService.detectTranslationRange({ itemID: task.itemID, totalPages });
      if (!task.modal?.isConnected) return;
      if (!detected.found) {
        resultBox.dataset.state = "warning";
        resultBox.textContent = "未识别到 References，已保留当前页码。";
        return;
      }
      input.value = detected.pageRange;
      resultBox.dataset.state = "success";
      resultBox.textContent = detected.referencesStartOnNewPage
        ? `References 从第 ${detected.referencePage} 页开始，已截止到第 ${detected.endPage} 页。`
        : `References 位于第 ${detected.referencePage} 页中部，已保留该页正文。`;
    } catch (error) {
      if (!task.modal?.isConnected) return;
      resultBox.dataset.state = "error";
      resultBox.textContent = `识别失败：${error.message}`;
    } finally {
      task.detectingRange = false;
      if (button?.isConnected) {
        button.disabled = false;
        button.textContent = "识别正文范围";
      }
    }
  }

  function closeDialog(task) {
    const terminal = task.job && !["queued", "running"].includes(task.job.status);
    if (task.modal) {
      task.doc?.removeEventListener("keydown", task.keyHandler, true);
      task.modal.remove();
      task.modal = null;
    }
    task.returnFocus?.focus?.();
    if (terminal) {
      task.job = null;
      task.jobId = null;
      task.lastRequest = null;
      task.resultRenderedFor = null;
    }
    updateToolbar(task);
  }

  async function startTask(task, retry, restart = false) {
    const modal = task.modal;
    const requestedForce = task.forceRetranslate === true;
    task.forceRetranslate = false;
    try {
      task.setupError = null;
      let job;
      if (retry && task.jobId) {
        job = Zotero.AIReaderService.retryJob(task.jobId);
        if (!job) throw new Error("原任务不存在，请重新开始");
      } else {
        if (!task.lastRequest || (!restart && !task.job)) {
          const totalPages = await waitForTotalPages(task.reader);
          task.lastRequest = {
            itemID: task.itemID,
            pageRange: modal?.querySelector(".zai-pages")?.value || `1-${totalPages}`,
            totalPages,
            forceRetranslate: requestedForce,
          };
        }
        job = await Zotero.AIReaderService.createJob(task.lastRequest);
      }
      task.job = job;
      task.jobId = job.id;
      task.resultRenderedFor = null;
      renderTaskDialog(task);
      updateToolbar(task);
      pollTask(task);
    } catch (error) {
      if (!task.jobId) {
        task.job = null;
        task.setupError = error.message;
      } else {
        task.job = { ...task.job, status: "failed", phase: "done", error: error.message, failed: task.job?.failed || [], tokenUsage: task.job?.tokenUsage || {} };
      }
      renderTaskDialog(task);
      updateToolbar(task);
    }
  }

  function startForcedTask(task) {
    const confirm = task.doc?.defaultView?.confirm || task.reader?._iframeWindow?.confirm;
    const accepted = confirm?.call(
      task.doc?.defaultView || task.reader?._iframeWindow,
      "重新翻译会调用模型并产生 API 费用。旧译文会保留，只有成功生成的新译文才会成为当前版本。是否继续？",
    );
    if (!accepted) return;
    task.forceRetranslate = true;
    task.lastRequest = null;
    return startTask(task, false);
  }

  async function cancelTask(task) {
    if (!task.jobId) return;
    try {
      task.job = Zotero.AIReaderService.cancelJob(task.jobId);
      if (!task.job) throw new Error("任务不存在");
    } catch (error) {
      task.job = { ...task.job, status: "failed", phase: "done", error: error.message };
    }
    renderTaskDialog(task);
    updateToolbar(task);
  }

  async function pollTask(task) {
    if (task.polling || !task.jobId) return;
    task.polling = true;
    let consecutiveErrors = 0;
    try {
      while (!task.stopped && task.jobId) {
        try {
          task.job = Zotero.AIReaderService.getJob(task.jobId);
          if (!task.job) throw new Error("任务不存在");
          consecutiveErrors = 0;
        } catch (error) {
          consecutiveErrors += 1;
          task.connectionError = `暂时无法读取任务状态：${error.message}`;
          renderTaskDialog(task);
          await delay(Math.min(5000, 1000 * consecutiveErrors));
          continue;
        }
        task.connectionError = null;
        renderTaskDialog(task);
        updateToolbar(task);
        if (!["queued", "running"].includes(task.job.status)) {
          if (task.job.result && task.resultRenderedFor !== task.job.id) {
            task.resultRenderedFor = task.job.id;
            task.cacheStatus = "hit";
            task.cacheStats = task.job.result.stats || {
              translatedParagraphs: Object.keys(task.job.result.paragraphs || {}).length,
              translatedPages: new Set(Object.values(task.job.result.paragraphs || {}).map((item) => item.page)).size,
            };
            task.restoredCache = task.job.result;
            try { renderOverlays(task.reader, task.doc, task.job.result); } catch (error) { Zotero.logError(error); }
            updateToolbar(task);
          }
          break;
        }
        await delay(task.modal?.isConnected ? 700 : 1500);
      }
    } finally {
      task.polling = false;
    }
  }

  function renderTaskDialog(task) {
    const modal = task.modal;
    if (!modal?.isConnected) return;
    const job = task.job;
    const keySetup = modal.querySelector(".zai-key-setup");
    const setup = modal.querySelector(".zai-setup");
    const statusBox = modal.querySelector(".zai-status");
    const errorBox = modal.querySelector(".zai-error");
    const actions = modal.querySelector(".zai-actions");
    const cacheNote = modal.querySelector(".zai-cache-note");
    if (!job) {
      const needsKey = !task.keyStatus?.configured;
      const hasCache = task.cacheStatus === "hit";
      keySetup.hidden = !needsKey;
      setup.hidden = needsKey;
      statusBox.hidden = true;
      errorBox.hidden = !task.setupError;
      errorBox.textContent = task.setupError || "";
      cacheNote.hidden = !hasCache || needsKey;
      cacheNote.textContent = hasCache
        ? `已缓存 ${task.cacheStats?.translatedPages || 0} 页、${task.cacheStats?.translatedParagraphs || 0} 段译文。重新翻译会发起新的 API 请求。`
        : "";
      const forceAction = hasCache
        ? `<button type="button" class="zai-button zai-button--secondary" data-action="force-start">重新翻译所选页</button>`
        : "";
      renderActions(actions, needsKey
        ? `<button type="button" class="zai-button zai-button--ghost" data-action="close">取消</button><button type="button" class="zai-button zai-button--primary" data-action="save-key">验证并保存</button>`
        : `<button type="button" class="zai-button zai-button--ghost" data-action="close">取消</button>${forceAction}<button type="button" class="zai-button zai-button--primary" data-action="start">${hasCache ? "翻译未缓存内容" : "开始翻译"}</button>`);
      return;
    }

    keySetup.hidden = true;
    setup.hidden = true;
    cacheNote.hidden = true;
    statusBox.hidden = false;
    const view = taskView(job);
    modal.querySelector(".zai-status-title").textContent = view.title;
    modal.querySelector(".zai-status-detail").textContent = view.detail;
    modal.querySelector(".zai-progress-meta").textContent = view.meta;
    modal.querySelector(".zai-status-icon").className = `zai-status-icon ${view.icon}`;
    const progress = modal.querySelector(".zai-progress-bar");
    if (view.progress === null) progress.removeAttribute("value");
    else progress.value = view.progress;
    renderStages(modal.querySelector(".zai-stages"), job.phase, job.status);
    modal.querySelector(".zai-counts").textContent = `翻译 ${job.paragraphTranslated || 0} · 本地译文缓存 ${job.localCacheHits ?? job.paragraphCached ?? 0} · 跳过 ${job.paragraphSkipped || 0} · 失败 ${job.paragraphFailed || 0}`;
    const tokens = modal.querySelector(".zai-tokens");
    const usage = job.tokenUsage || {};
    const showTokens = job.apiRequestCount || !["queued", "running"].includes(job.status);
    tokens.hidden = !showTokens;
    const retryUsage = job.retryTokenUsage || {};
    const retryRequests = (job.requestAudits || []).filter((audit) => audit.isRetry).length;
    const metric = (label, value, detail = "") => `<span class="zai-metric"><strong>${value}</strong><span>${label}</span>${detail ? `<small>${detail}</small>` : ""}</span>`;
    tokens.innerHTML = job.apiRequestCount
      ? `${metric("输入 Token", formatNumber(usage.promptTokens))}${metric("输出 Token", formatNumber(usage.completionTokens))}${metric("总计 Token", formatNumber(usage.totalTokens))}${metric("Prompt Cache", formatNumber(usage.cacheHitTokens), `未命中 ${formatNumber(usage.cacheMissTokens)}`)}${metric("API 请求", formatNumber(job.apiRequestCount), retryRequests ? `重试 ${retryRequests} 次` : "")}`
      : `${metric("模型调用", "0")}${metric("Token", "0")}`;

    const error = task.connectionError || view.error;
    errorBox.hidden = !error;
    errorBox.textContent = error || "";
    renderActions(actions, view.actions);
  }

  // Reader 的宿主页面会对普通 button 施加全局样式；每次渲染时确保操作栏
  // 没有残留 hidden 属性，并显式恢复其可见性。
  function renderActions(container, html) {
    container.hidden = false;
    container.removeAttribute("hidden");
    // 轮询时保留按钮节点，避免键盘焦点每隔 700ms 丢失。
    if (container.innerHTML !== html) container.innerHTML = html;
  }

  async function configureKeyFromDialog(task) {
    const input = task.modal?.querySelector(".zai-api-key");
    const key = input?.value?.trim();
    if (!key) {
      task.setupError = "请输入 DeepSeek API Key";
      return renderTaskDialog(task);
    }
    task.setupError = "正在验证 DeepSeek 连接…";
    renderTaskDialog(task);
    try {
      task.keyStatus = await Zotero.AIReaderService.configureAPIKey(key);
      input.value = "";
      task.setupError = null;
    } catch (error) {
      task.setupError = error.message || "API Key 验证失败";
    }
    renderTaskDialog(task);
  }

  function taskView(job) {
    const running = ["queued", "running"].includes(job.status);
    const phaseName = {
      queued: "等待开始", hashing: "校验 PDF", extracting: "提取页面", translating: "复用缓存",
      connecting: "连接 DeepSeek", generating: "模型翻译", saving: "保存结果", "cache-hit": "读取本地缓存", done: "完成",
    }[job.phase] || "处理中";
    const elapsed = job.startedAt ? ` · 已用时 ${formatDuration(Date.now() - job.startedAt)}` : "";
    let progress = null;
    if (job.phase === "extracting" && job.pageCurrent && job.pageTotal) progress = (job.pageCurrent / job.pageTotal) * 100;
    else if (job.phase === "extracting" && job.prepareProgress) progress = job.prepareProgress;
    else if (job.paragraphTotal) progress = (job.paragraphCurrent / job.paragraphTotal) * 100;
    else if (job.phase === "saving") progress = 98;
    if (job.status === "completed") progress = 100;
    else if (!running && progress === null) progress = 0;
    const batch = job.batchTotal ? ` · 批次 ${job.batchCurrent}/${job.batchTotal}${job.batchActive ? `（处理中 ${job.batchActive}）` : ""}` : "";
    const preparation = job.phase === "extracting" && !job.pageCurrent && job.prepareProgress
      ? ` · Zotero 文档解析 ${job.prepareProgress}%`
      : "";
    const meta = `${phaseName}${preparation} · 页面 ${job.pageCurrent || 0}/${job.pageTotal || 0} · 段落 ${job.paragraphCurrent || 0}/${job.paragraphTotal || 0}${batch}${elapsed}`;
    if (running) return {
      title: phaseName, detail: "任务可在后台继续运行", meta, progress, icon: "working", error: null,
      actions: `<button type="button" class="zai-button zai-button--danger" data-action="cancel-job">取消任务</button><button type="button" class="zai-button zai-button--primary" data-action="collapse">收起</button>`,
    };
    if (job.status === "completed") return {
      title: "翻译完成", detail: "结果已保存，下次打开无需重新处理", meta, progress: 100, icon: "success", error: null,
      actions: `<button type="button" class="zai-button zai-button--primary" data-action="close">关闭</button>`,
    };
    const cause = job.failed?.[0]?.error?.replace(/\s+/g, " ").slice(0, 420);
    if (job.status === "partial") return {
      title: "部分段落未完成", detail: "成功结果已经保存，可只重试失败内容", meta, progress, icon: "warning",
      error: `${job.paragraphFailed || job.failed?.length || 0} 个段落处理失败。${cause ? `\n首个原因：${cause}` : ""}`,
      actions: `<button type="button" class="zai-button zai-button--ghost" data-action="close">关闭</button><button type="button" class="zai-button zai-button--primary" data-action="retry">重试失败段落</button>`,
    };
    return {
      title: job.status === "cancelled" ? "任务已取消" : "翻译失败", detail: "可以使用相同页码重新开始", meta, progress,
      icon: job.status === "cancelled" ? "warning" : "error", error: job.error || cause || null,
      actions: `<button type="button" class="zai-button zai-button--ghost" data-action="close">关闭</button><button type="button" class="zai-button zai-button--primary" data-action="restart">重新开始</button>`,
    };
  }

  function renderStages(container, phase, status) {
    const stages = [["hashing", "校验"], ["extracting", "提取"], ["translating", "缓存"], ["generating", "翻译"], ["saving", "保存"], ["done", "完成"]];
    const aliases = { queued: -1, connecting: 3, "cache-hit": 2 };
    const active = phase === "done" && status !== "completed" ? -1
      : aliases[phase] ?? stages.findIndex(([name]) => name === phase);
    container.replaceChildren(...stages.map(([, label], index) => {
      const node = container.ownerDocument.createElement("span");
      node.textContent = label;
      node.className = index < active ? "done" : index === active ? "active" : "";
      return node;
    }));
  }

  function updateToolbar(task) {
    for (const button of [...task.buttons]) {
      if (!button.isConnected) {
        task.buttons.delete(button);
        continue;
      }
      const job = task.job;
      let label = "AI 翻译";
      let status = "idle";
      let count = "";
      if (job && ["queued", "running"].includes(job.status)) {
        label = { queued: "等待中", hashing: "校验中", extracting: "提取中", translating: "读取缓存", connecting: "连接中", saving: "保存中", "cache-hit": "读取缓存" }[job.phase] || "翻译中";
        if (job.batchTotal) count = `${job.batchCurrent || 0}/${job.batchTotal}`;
        status = "running";
      } else if (job?.status === "completed") {
        label = "翻译完成"; status = "completed";
      } else if (job?.status === "partial") {
        label = "部分失败"; status = "warning";
      } else if (job?.status === "failed") {
        label = "翻译失败"; status = "error";
      } else if (job?.status === "cancelled") {
        label = "已取消"; status = "warning";
      } else if (task.cacheStatus === "loading") {
        label = "检查缓存"; status = "running";
      } else if (task.cacheStatus === "hit") {
        label = "已有译文";
        count = task.cacheStats?.translatedParagraphs ? `${task.cacheStats.translatedParagraphs} 段` : "";
        status = "completed";
      } else if (task.cacheStatus === "error") {
        label = "缓存异常"; status = "error";
      }
      button.querySelector(".zai-toolbar-label").textContent = label;
      const counter = button.querySelector(".zai-toolbar-count");
      counter.textContent = count;
      counter.hidden = !count;
      counter.setAttribute("aria-label", count ? `已缓存 ${count} 译文` : "");
      button.dataset.status = status;
      button.setAttribute("aria-busy", status === "running" ? "true" : "false");
      const hint = task.cacheStatus === "hit" && !job
        ? `已缓存 ${task.cacheStats?.translatedPages || 0} 页，译文已自动显示`
        : task.cacheStatus === "error" && !job
          ? task.cacheError || "缓存读取失败，原文件未被修改"
          : status === "idle" ? "仅处理选择的 PDF 页面" : "点击查看任务详情";
      const countHint = count
        ? job && ["queued", "running"].includes(job.status) ? ` · 已完成 ${count} 批次` : ` · ${count}`
        : "";
      button.title = `${label}${countHint} · ${hint}`;
      button.setAttribute("aria-label", button.title);
      button.setAttribute("aria-haspopup", "dialog");
    }
  }

  function formatNumber(value) {
    return Number(value || 0).toLocaleString("zh-CN");
  }

  function formatDuration(ms) {
    const seconds = Math.max(0, Math.floor(ms / 1000));
    return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function renderOverlays(reader, doc, cache) {
    const old = overlayStates.get(reader);
    old?.stop?.();
    const paragraphs = Object.values(cache.paragraphs || {}).filter(shouldRenderParagraph);
    const state = { cache, viewerDoc: null, onScroll: null, timer: null, stopped: false };
    const clearViewer = () => {
      if (!state.viewerDoc) return;
      state.viewerDoc.removeEventListener("scroll", state.onScroll, true);
      state.viewerDoc.querySelectorAll(".zai-paragraph-layer, .zai-page-badge").forEach((node) => node.remove());
      state.viewerDoc = null;
      state.onScroll = null;
    };
    const render = (viewerDoc) => {
      const byPage = new Map();
      for (const paragraph of paragraphs) {
        const pageItems = byPage.get(paragraph.page) || [];
        pageItems.push(paragraph);
        byPage.set(paragraph.page, pageItems);
      }
      for (const [pageNumber, pageItems] of byPage) {
        const page = viewerDoc.querySelector(`.page[data-page-number="${pageNumber}"]`);
        if (!page || page.querySelector(".zai-page-badge")) continue;
        const badge = viewerDoc.createElement("div");
        badge.className = "zai-page-badge";
        badge.textContent = `AI 已翻译 ${pageItems.length} 段`;
        page.append(badge);
      }
      for (const paragraph of paragraphs) {
        const page = viewerDoc.querySelector(`.page[data-page-number="${paragraph.page}"]`);
        if (!page || page.querySelector(`[data-zai-id="${paragraph.paragraph_id}"]`)) continue;
        if (viewerDoc.defaultView.getComputedStyle(page).position === "static") page.style.position = "relative";
        const layer = viewerDoc.createElement("div");
        layer.className = "zai-paragraph-layer";
        layer.dataset.zaiId = paragraph.paragraph_id;
        const [x, y, width, height] = paragraph.bbox;
        layer.style.left = `${(x / paragraph.page_width) * 100}%`;
        layer.style.top = `${((paragraph.page_height - y - height) / paragraph.page_height) * 100}%`;
        layer.style.width = `${(width / paragraph.page_width) * 100}%`;
        layer.style.height = `${Math.max((height / paragraph.page_height) * 100, 1.2)}%`;
        layer.setAttribute("aria-label", `AI 摘要：${paragraph.summary}`);
        layer.addEventListener("mouseenter", (event) => {
          cancelTooltipClose(viewerDoc);
          showTooltip(viewerDoc, event, paragraph);
        });
        layer.addEventListener("mouseleave", () => scheduleTooltipClose(viewerDoc));
        page.append(layer);
      }
    };
    const ensureAttached = () => {
      if (state.stopped) return;
      const viewerDoc = getPDFDocument(reader);
      if (!viewerDoc?.body) return;
      if (viewerDoc !== state.viewerDoc) {
        clearViewer();
        state.viewerDoc = viewerDoc;
        injectOverlayStyles(viewerDoc);
        viewerDoc.querySelectorAll(".zai-paragraph-layer, .zai-page-badge").forEach((node) => node.remove());
        state.onScroll = () => render(viewerDoc);
        viewerDoc.addEventListener("scroll", state.onScroll, true);
      }
      render(viewerDoc);
    };
    // renderToolbar 早于 PDF.js 页面挂载；持续低频检查既能自动等待首次加载，
    // 也能在 PDF.js 重建 iframe 或虚拟化页面后重新绑定。
    state.timer = doc.defaultView.setInterval(ensureAttached, 1000);
    state.stop = () => {
      state.stopped = true;
      doc.defaultView.clearInterval(state.timer);
      doc.defaultView.removeEventListener("unload", state.stop);
      clearViewer();
    };
    doc.defaultView.addEventListener("unload", state.stop, { once: true });
    overlayStates.set(reader, state);
    ensureAttached();
  }

  function shouldRenderParagraph(paragraph) {
    if (!paragraph || (!paragraph.summary && !paragraph.translation)) return false;
    if (["table", "image"].includes(paragraph.block_type)) return false;
    if (paragraph.block_type) return true;
    // 旧缓存没有 block_type：隐藏明显占据大片页面的旧图表覆盖层。
    const [, , width, height] = paragraph.bbox || [];
    const widthRatio = Number(width) / Number(paragraph.page_width);
    const heightRatio = Number(height) / Number(paragraph.page_height);
    return !(Number.isFinite(widthRatio) && Number.isFinite(heightRatio) && widthRatio >= 0.65 && heightRatio >= 0.35);
  }

  function showTooltip(doc, event, paragraph) {
    if (!paragraph.translation) return;
    cancelTooltipClose(doc);
    doc.getElementById("zai-tooltip")?.remove();
    const tooltip = doc.createElement("div");
    tooltip.id = "zai-tooltip";
    tooltip.setAttribute("role", "dialog");
    tooltip.setAttribute("aria-label", "AI 译文");
    const heading = doc.createElement("div");
    heading.className = "zai-tooltip-heading";
    heading.textContent = "AI 摘要";
    const summary = doc.createElement("div");
    summary.className = "zai-tooltip-summary";
    summary.textContent = paragraph.summary || "未生成摘要";
    const divider = doc.createElement("div");
    divider.className = "zai-tooltip-divider";
    const translation = doc.createElement("div");
    translation.className = "zai-tooltip-translation";
    renderMathText(doc, translation, paragraph.translation);
    tooltip.style.setProperty("--zai-translation-font-size", `${translationFontSize()}px`);
    const actions = doc.createElement("div");
    actions.className = "zai-tooltip-actions";
    const copyTranslation = tooltipAction(doc, "复制译文", "复制完整中文译文");
    const formulas = extractObsidianMathMarkdown(paragraph.translation);
    const copyPrompt = tooltipAction(doc, "复制提问", "复制可直接粘贴到 ChatGPT 的提问");
    const feedback = doc.createElement("div");
    feedback.className = "zai-copy-feedback";
    feedback.setAttribute("role", "status");
    feedback.setAttribute("aria-live", "polite");
    const formulaPicker = formulas.length ? createFormulaPicker(doc, formulas, feedback) : null;
    copyTranslation.addEventListener("click", () => copyFromTooltip(doc, paragraph.translation, copyTranslation, feedback, "已复制完整中文译文。"));
    copyPrompt.addEventListener("click", () => copyFromTooltip(doc, buildChatGPTPrompt(paragraph.translation), copyPrompt, feedback, "已复制提问，可直接粘贴到 ChatGPT。"));
    actions.append(copyTranslation);
    if (formulaPicker) actions.append(formulaPicker.toggle);
    actions.append(copyPrompt);
    tooltip.addEventListener("mouseenter", () => cancelTooltipClose(doc));
    tooltip.addEventListener("mouseleave", () => scheduleTooltipClose(doc));
    tooltip.addEventListener("wheel", (wheelEvent) => wheelEvent.stopPropagation());
    tooltip.append(heading, summary, divider, translation, actions);
    if (formulaPicker) tooltip.append(formulaPicker.panel);
    tooltip.append(feedback);
    doc.body.append(tooltip);
    positionTooltip(doc, tooltip, event.currentTarget, event);
  }

  function tooltipAction(doc, label, title) {
    const button = doc.createElement("button");
    button.type = "button";
    button.className = "zai-tooltip-action zai-button zai-button--secondary zai-button--compact";
    button.textContent = label;
    button.title = title;
    return button;
  }

  function createFormulaPicker(doc, formulas, feedback) {
    const panelId = "zai-formula-picker";
    const toggle = tooltipAction(doc, `选择公式（${formulas.length}）`, "展开后选择要复制到 Obsidian 的公式");
    toggle.setAttribute("aria-controls", panelId);
    toggle.setAttribute("aria-expanded", "false");

    const panel = doc.createElement("fieldset");
    panel.id = panelId;
    panel.className = "zai-formula-picker";
    panel.hidden = true;
    const legend = doc.createElement("legend");
    legend.textContent = "选择要复制的公式";
    const list = doc.createElement("div");
    list.className = "zai-formula-list";
    const inputs = [];
    formulas.forEach((formula, index) => {
      const option = doc.createElement("label");
      option.className = "zai-formula-option";
      const input = doc.createElement("input");
      input.type = "checkbox";
      input.value = String(index);
      input.setAttribute("aria-label", `选择公式 ${index + 1}`);
      const number = doc.createElement("span");
      number.className = "zai-formula-number";
      number.textContent = `公式 ${index + 1}`;
      const preview = doc.createElement("span");
      preview.className = "zai-formula-preview";
      renderMathText(doc, preview, formula);
      option.append(input, number, preview);
      list.append(option);
      inputs.push(input);
    });
    const pickerActions = doc.createElement("div");
    pickerActions.className = "zai-formula-picker-actions";
    const copySelected = tooltipAction(doc, "复制选中公式（0）", "复制已选择的公式为 Obsidian Markdown/LaTeX");
    copySelected.disabled = true;

    const selectedState = () => selectedFormulaState(formulas, inputs
      .filter((input) => input.checked)
      .map((input) => Number(input.value)));
    const updateSelection = () => {
      const state = selectedState();
      copySelected.textContent = `复制选中公式（${state.count}）`;
      copySelected.disabled = state.count === 0;
    };
    inputs.forEach((input) => input.addEventListener("change", updateSelection));
    copySelected.addEventListener("click", () => {
      const state = selectedState();
      if (!state.count) return;
      copyFromTooltip(doc, state.markdown, copySelected, feedback, `已复制 ${state.count} 条公式，可直接粘贴到 Obsidian。`);
    });
    toggle.addEventListener("click", () => {
      panel.hidden = !panel.hidden;
      toggle.setAttribute("aria-expanded", String(!panel.hidden));
    });
    pickerActions.append(copySelected);
    panel.append(legend, list, pickerActions);
    return { toggle, panel };
  }

  function translationFontSize() {
    const value = Zotero.AIReaderService.getSettings?.().translationFontSize;
    const number = Number(value);
    return Number.isFinite(number) && number >= 12 && number <= 22 ? Math.round(number) : 16;
  }

  const MATH_COMMANDS = Object.freeze({
    alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ϵ", varepsilon: "ε", theta: "θ",
    lambda: "λ", mu: "μ", pi: "π", rho: "ρ", sigma: "σ", tau: "τ", phi: "ϕ", varphi: "φ", omega: "ω",
    Gamma: "Γ", Delta: "Δ", Theta: "Θ", Lambda: "Λ", Sigma: "Σ", Phi: "Φ", Omega: "Ω",
    in: "∈", notin: "∉", ge: "≥", geq: "≥", le: "≤", leq: "≤", neq: "≠", approx: "≈",
    times: "×", cdot: "·", pm: "±", mp: "∓", sum: "∑", prod: "∏", int: "∫",
    partial: "∂", nabla: "∇", forall: "∀", exists: "∃", infinity: "∞", infty: "∞",
    sim: "∼", to: "→", rightarrow: "→", leftarrow: "←", leftrightarrow: "↔",
    subset: "⊂", subseteq: "⊆", supset: "⊃", supseteq: "⊇", cup: "∪", cap: "∩",
    ldots: "…", cdots: "⋯", log: "log", exp: "exp", min: "min", max: "max",
  });

  // 译文来自模型，始终通过 DOM 节点构造，不接收 HTML，避免 XSS。
  // 模型偶尔将引文、编号或普通短语错误置入数学边界。分类器同时服务于渲染、
  // 公式选择和复制，保证旧缓存无需重译即可恢复为普通文本。
  function normalizeMathBoundaryText(value) {
    return String(value || "").replace(/\\([\[\]])/g, "$1").replace(/\u00a0/g, " ").trim();
  }

  function isNumericCitation(value) {
    return /^(?:\[|\()\s*\d+\s*(?:(?:[,;、]\s*|[-–—]\s*)\d+\s*)*(?:\]|\))$/.test(value);
  }

  function isAuthorYearCitation(value) {
    const year = "(?:19|20)\\d{2}[a-z]?";
    const latinAuthor = "[A-Z][A-Za-z'’-]*(?:\\s+(?:et\\s+al\\.?|and\\s+[A-Z][A-Za-z'’-]*|&\\s*[A-Z][A-Za-z'’-]*))?";
    const cjkAuthor = "[\\u4e00-\\u9fff]{2,}(?:等)?";
    return new RegExp(`^(?:\\(|（)\\s*(?:${latinAuthor}|${cjkAuthor})\\s*[,，]\\s*${year}(?:\\s*[;；]\\s*(?:${latinAuthor}|${cjkAuthor})\\s*[,，]\\s*${year})*\\s*(?:\\)|）)$`).test(value);
  }

  function isReferenceLabel(value) {
    const english = /^(?:fig(?:ure)?|table|section|sec\.?|chapter|ch\.?|appendix|app\.?|algorithm|alg\.?|equation|eq\.?)\s*(?:no\.?\s*)?\(?\s*[A-Za-z]?\d+(?:\.\d+)*[A-Za-z]?\s*\)?\.?$/i;
    const chinese = /^(?:图|表|章节|第\s*\d+(?:\.\d+)*\s*章|算法|附录|公式|式)\s*[A-Za-z]?\d*(?:\.\d+)*[A-Za-z]?\.?$/;
    return english.test(value) || chinese.test(value);
  }

  function isTechnicalIdentifier(value) {
    return /^(?:https?:\/\/|www\.)\S+$/i.test(value) ||
      /^(?:doi:\s*)?10\.\d{4,9}\/\S+$/i.test(value) ||
      /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ||
      /^[-\w.]+\.(?:pdf|docx?|xlsx?|csv|tsv|png|jpe?g|svg|json|xml|html?|py|js|ts|tex)$/i.test(value);
  }

  function hasMathFeature(value) {
    return /\\[A-Za-z]+|[_^]\s*(?:\{|[A-Za-z0-9])|[=<>±×÷∈∉≤≥≈∑∏√∞∂∇]|\b[A-Za-z]\s*\([^)]*\)|[α-ωΑ-Ω]|\{[^}]*\}/.test(value);
  }

  function isMeasurementOrTime(value) {
    return /^\d+(?:\.\d+)?\s*(?:%|‰|°[CF]|[a-zA-Zμµ]+(?:\/[a-zA-Z]+)?(?:\^-?\d+)?)$/i.test(value) ||
      /^\d{1,2}:\d{2}(?::\d{2})?$/.test(value);
  }

  function classifyMathBoundaryContent(value) {
    const text = normalizeMathBoundaryText(value);
    if (!text) return { isMath: false, text, reason: "empty" };
    if (isNumericCitation(text) || /^\^\s*\d+(?:(?:[,;]\s*|[-–—]\s*)\d+)*$/.test(text)) return { isMath: false, text, reason: "citation" };
    if (isAuthorYearCitation(text)) return { isMath: false, text, reason: "author-year-citation" };
    if (isReferenceLabel(text) || /^\[\s*[A-Za-z]\s*\]$/.test(text) || /^[IVXLCDM]+\.$/.test(text) || /^\(\s*\d+(?:\.\d+)*\s*\)$/.test(text)) return { isMath: false, text, reason: "label" };
    if (isTechnicalIdentifier(text)) return { isMath: false, text, reason: "identifier" };
    if (hasMathFeature(text) || isMeasurementOrTime(text)) return { isMath: true, text, reason: "math-feature" };
    if (/[\u4e00-\u9fff]/.test(text) || /\s/.test(text) || /[A-Za-z]+(?:[.,;:!?][A-Za-z]+)+/i.test(text)) return { isMath: false, text, reason: "prose" };
    return { isMath: true, text, reason: "ambiguous" };
  }

  // 兼容既有测试与调用点；新逻辑统一使用 classifyMathBoundaryContent。
  function isPureNumericBracketCitation(value) {
    return classifyMathBoundaryContent(value).reason === "citation" && /^[\[(]/.test(normalizeMathBoundaryText(value));
  }

  function renderMathText(doc, container, value) {
    const text = String(value || "");
    const parts = text.split(/(\\\([\s\S]*?\\\)|\\\[[\s\S]*?\\\]|\$\$[\s\S]*?\$\$|\$[^$\n]+\$)/g);
    for (const part of parts) {
      if (!part) continue;
      if (!/^(?:\\\(|\\\[|\$)/.test(part)) {
        renderPlainTextWithMathCandidates(doc, container, part);
        continue;
      }
      const source = part.replace(/^(?:\\\(|\\\[|\$\$?)/, "").replace(/(?:\\\)|\\\]|\$\$?)$/, "");
      const classification = classifyMathBoundaryContent(source);
      if (!classification.isMath) {
        container.append(doc.createTextNode(classification.text));
        continue;
      }
      appendMath(doc, container, source);
    }
  }

  // 只复制模型已明确标记边界的公式，避免将正文中的 x_i 等变量误认为独立公式。
  function extractObsidianMathMarkdown(value) {
    const formulas = [];
    const pattern = /\\\(([\s\S]*?)\\\)|\\\[([\s\S]*?)\\\]|\$\$([\s\S]*?)\$\$|\$([^$\n]+)\$/g;
    for (const match of String(value || "").matchAll(pattern)) {
      const inlineParentheses = match[1];
      const displayBrackets = match[2];
      const displayDollars = match[3];
      const inlineDollars = match[4];
      const source = inlineParentheses ?? displayBrackets ?? displayDollars ?? inlineDollars;
      if (!source || !classifyMathBoundaryContent(source).isMath) continue;
      const isDisplay = displayBrackets !== undefined || displayDollars !== undefined;
      formulas.push(isDisplay ? `$$\n${source}\n$$` : `$${source}$`);
    }
    return formulas;
  }

  function selectedFormulaState(formulas, selectedIndexes) {
    const selected = new Set(selectedIndexes);
    const values = formulas.filter((_formula, index) => selected.has(index));
    return { count: values.length, markdown: values.join("\n\n") };
  }

  // 模型偶尔会漏掉 [[math:...]] 边界。这里只识别满足数学特征的紧凑 token，
  // 避免把普通英文句子错当公式；可以覆盖 x_i、\\tilde{y}_i、\\varepsilon_i 等截图中的典型残留。
  function renderPlainTextWithMathCandidates(doc, container, value) {
    const text = String(value || "");
    const candidate = /\\[A-Za-z]+(?:\s*\{(?:[^{}]|\{[^{}]*\})*\})?(?:\s*[_^](?:\{[^{}]*\}|[A-Za-z0-9]))*|[A-Za-z](?:\s*[_^](?:\{[^{}]*\}|[A-Za-z0-9]))+/g;
    let cursor = 0;
    for (const match of text.matchAll(candidate)) {
      const start = match.index ?? 0;
      if (start > cursor) container.append(doc.createTextNode(text.slice(cursor, start)));
      appendMath(doc, container, match[0].replace(/\s+/g, ""));
      cursor = start + match[0].length;
    }
    if (cursor < text.length) container.append(doc.createTextNode(text.slice(cursor)));
  }

  function getKaTeX() {
    return globalThis.katex || (typeof katex !== "undefined" ? katex : null);
  }

  function appendMath(doc, container, source) {
      const classification = classifyMathBoundaryContent(source);
      if (!classification.isMath) {
        container.append(doc.createTextNode(classification.text));
        return;
      }
      const math = doc.createElement("span");
      math.className = "zai-math";
      const renderer = getKaTeX();
      if (renderer?.render) {
        try {
          renderer.render(source, math, {
            throwOnError: false,
            strict: "ignore",
            trust: false,
            output: "htmlAndMathml",
          });
        } catch {
          renderMathSource(doc, math, source);
        }
      } else {
        renderMathSource(doc, math, source);
      }
      container.append(math);
  }

  function renderMathSource(doc, container, source) {
    const text = String(source || "");
    let cursor = 0;
    let plain = "";
    const flush = () => {
      if (!plain) return;
      container.append(doc.createTextNode(plain));
      plain = "";
    };
    const readArgument = (start) => {
      if (text[start] !== "{") return { value: text[start] || "", end: Math.min(start + 1, text.length) };
      let depth = 1;
      let end = start + 1;
      while (end < text.length && depth) {
        if (text[end] === "{" && text[end - 1] !== "\\") depth += 1;
        if (text[end] === "}" && text[end - 1] !== "\\") depth -= 1;
        end += 1;
      }
      return { value: text.slice(start + 1, depth ? text.length : end - 1), end };
    };
    while (cursor < text.length) {
      const char = text[cursor];
      if (char === "\\") {
        const match = /^\\([A-Za-z]+)/.exec(text.slice(cursor));
        if (match && MATH_COMMANDS[match[1]]) {
          flush();
          const symbol = doc.createElement("span");
          symbol.className = "zai-math-symbol";
          symbol.textContent = MATH_COMMANDS[match[1]];
          container.append(symbol);
          cursor += match[0].length;
          continue;
        }
        if (match && match[1] === "frac") {
          const numerator = readArgument(cursor + match[0].length);
          const denominator = readArgument(numerator.end);
          flush();
          const fraction = doc.createElement("span");
          fraction.className = "zai-math-frac";
          const top = doc.createElement("span");
          const bottom = doc.createElement("span");
          top.className = "zai-math-frac-top";
          bottom.className = "zai-math-frac-bottom";
          renderMathSource(doc, top, numerator.value);
          renderMathSource(doc, bottom, denominator.value);
          fraction.append(top, bottom);
          container.append(fraction);
          cursor = denominator.end;
          continue;
        }
        if (match && match[1] === "sqrt") {
          const argument = readArgument(cursor + match[0].length);
          flush();
          const root = doc.createElement("span");
          root.className = "zai-math-sqrt";
          const radicand = doc.createElement("span");
          radicand.className = "zai-math-radicand";
          renderMathSource(doc, radicand, argument.value);
          root.append(doc.createTextNode("√"), radicand);
          container.append(root);
          cursor = argument.end;
          continue;
        }
        if (match && ["bar", "vec", "hat", "tilde", "mathbf", "mathrm", "mathit", "mathbb", "mathcal", "text"].includes(match[1])) {
          const argument = readArgument(cursor + match[0].length);
          flush();
          const symbol = doc.createElement("span");
          symbol.className = `zai-math-symbol zai-math-${match[1]}`;
          renderMathSource(doc, symbol, argument.value);
          container.append(symbol);
          cursor = argument.end;
          continue;
        }
        if (/^\\[,;:! ]/.test(text.slice(cursor))) {
          plain += " ";
          cursor += 2;
          continue;
        }
        if (/^\\[{}_%&#$]/.test(text.slice(cursor))) {
          plain += text[cursor + 1];
          cursor += 2;
          continue;
        }
      }
      if ((char === "_" || char === "^") && cursor + 1 < text.length) {
        const argument = readArgument(cursor + 1);
        if (argument.value && !/^\s/.test(argument.value)) {
          flush();
          const script = doc.createElement(char === "_" ? "sub" : "sup");
          script.className = "zai-math-script";
          renderMathSource(doc, script, argument.value);
          container.append(script);
          cursor = argument.end;
          continue;
        }
      }
      plain += char;
      cursor += 1;
    }
    flush();
  }

  function buildChatGPTPrompt(translation) {
    return `${CHATGPT_EXPLANATION_PREFIX}${translation}`;
  }

  async function copyFromTooltip(doc, text, button, feedback, successMessage) {
    try {
      await writeClipboard(doc, text);
      feedback.textContent = successMessage;
      button.dataset.copied = "true";
      doc.defaultView.setTimeout(() => {
        button.removeAttribute("data-copied");
        feedback.textContent = "";
      }, 1800);
    } catch {
      feedback.textContent = "无法自动复制，请直接选择译文后按 Ctrl+C。";
    }
  }

  async function writeClipboard(doc, text) {
    const clipboard = doc.defaultView?.navigator?.clipboard;
    if (clipboard?.writeText) {
      try {
        await clipboard.writeText(text);
        return;
      } catch { /* Firefox 的 iframe 权限受限时使用兼容回退。 */ }
    }
    const input = doc.createElement("textarea");
    input.value = text;
    input.setAttribute("readonly", "");
    input.className = "zai-clipboard-fallback";
    doc.body.append(input);
    input.select();
    const copied = doc.execCommand?.("copy");
    input.remove();
    if (!copied) throw new Error("Clipboard unavailable");
  }

  function cancelTooltipClose(doc) {
    const timer = tooltipCloseTimers.get(doc);
    if (timer !== undefined) doc.defaultView.clearTimeout(timer);
    tooltipCloseTimers.delete(doc);
  }

  function scheduleTooltipClose(doc) {
    cancelTooltipClose(doc);
    tooltipCloseTimers.set(doc, doc.defaultView.setTimeout(() => {
      doc.getElementById("zai-tooltip")?.remove();
      tooltipCloseTimers.delete(doc);
    }, 180));
  }

  function positionTooltip(doc, tooltip, anchor, event) {
    const margin = 12;
    const gap = 8;
    const viewportWidth = doc.defaultView.innerWidth;
    const viewportHeight = doc.defaultView.innerHeight;
    const anchorRect = anchor?.getBoundingClientRect?.();
    const width = tooltip.offsetWidth;
    const height = tooltip.offsetHeight;
    const pointerX = Number(event?.clientX) || margin;
    const pointerY = Number(event?.clientY) || margin;
    let left = anchorRect ? anchorRect.right + gap : pointerX + gap;
    if (left + width > viewportWidth - margin) {
      left = anchorRect && anchorRect.left - width - gap >= margin
        ? anchorRect.left - width - gap
        : pointerX - width - gap;
    }
    let top = anchorRect ? Math.max(anchorRect.top, pointerY - 24) : pointerY + gap;
    left = Math.max(margin, Math.min(left, viewportWidth - width - margin));
    top = Math.max(margin, Math.min(top, viewportHeight - height - margin));
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;
  }

  function injectStyles(doc) {
    if (doc.getElementById("zotero-ai-reader-styles")) return;
    injectKaTeXStyles(doc);
    const style = doc.createElement("style");
    style.id = "zotero-ai-reader-styles";
    style.textContent = `
      #zotero-ai-reader-button { box-sizing: border-box; display: inline-flex; flex: 0 0 auto; align-items: center; justify-content: center; gap: 7px; width: auto; min-width: 98px; max-width: none; height: 28px; margin: 0 6px; padding: 0 10px; border: 1px solid color-mix(in srgb, currentColor 14%, transparent); border-radius: 9px; color: CanvasText; background: color-mix(in srgb, CanvasText 4%, transparent); font: 600 12px/1 system-ui; white-space: nowrap; cursor: pointer; transition: background .15s ease, box-shadow .15s ease, border-color .15s ease; }
      #zotero-ai-reader-button:hover { box-shadow: 0 0 0 2px color-mix(in srgb, currentColor 10%, transparent); }
      #zotero-ai-reader-button:focus-visible, .zai-dialog button:focus-visible, .zai-dialog input:focus-visible { outline: 2px solid #3b82f6; outline-offset: 3px; }
      #zotero-ai-reader-button .zai-toolbar-label { white-space: nowrap; }
      .zai-toolbar-icon { display: inline-grid; place-items: center; flex: 0 0 14px; width: 14px; height: 14px; box-sizing: border-box; }
      .zai-toolbar-icon::before { content: "译"; font-size: 11px; }
      #zotero-ai-reader-button[data-status="running"] .zai-toolbar-icon { border: 2px solid color-mix(in srgb, currentColor 22%, transparent); border-top-color: currentColor; border-radius: 50%; animation: zai-spin .9s linear infinite; }
      #zotero-ai-reader-button[data-status="running"] .zai-toolbar-icon::before { content: none; }
      #zotero-ai-reader-button[data-status="completed"] .zai-toolbar-icon::before { content: "✓"; }
      #zotero-ai-reader-button[data-status="warning"] .zai-toolbar-icon::before { content: "!"; }
      #zotero-ai-reader-button[data-status="error"] .zai-toolbar-icon::before { content: "×"; }
      .zai-toolbar-count { padding: 3px 6px; border-radius: 999px; background: color-mix(in srgb, currentColor 10%, transparent); font-size: 11px; font-variant-numeric: tabular-nums; }
      .zai-toolbar-count[hidden], #zotero-ai-reader-modal [hidden] { display: none !important; }
      #zotero-ai-reader-button[data-status="running"] { color: #1d4ed8; background: color-mix(in srgb, #3b82f6 12%, transparent); }
      #zotero-ai-reader-button[data-status="completed"] { color: #047857; background: color-mix(in srgb, #10b981 12%, transparent); }
      #zotero-ai-reader-button[data-status="warning"] { color: #b45309; background: color-mix(in srgb, #f59e0b 12%, transparent); }
      #zotero-ai-reader-button[data-status="error"] { color: #be123c; background: color-mix(in srgb, #f43f5e 12%, transparent); }
      #zotero-ai-reader-modal { position: fixed; inset: 0; z-index: 2147483640; display: grid; place-items: center; background: rgba(0,0,0,.38); }
      .zai-dialog { --zai-control-height: 36px; --zai-radius: 8px; --zai-blue: #2563eb; box-sizing: border-box; position: relative; width: min(500px, calc(100vw - 32px)); max-height: calc(100vh - 32px); overflow: auto; padding: 22px; border: 1px solid color-mix(in srgb, CanvasText 12%, transparent); border-radius: 16px; color: CanvasText; background: Canvas; box-shadow: 0 22px 64px rgba(0,0,0,.24); font: 14px/1.6 system-ui; outline: none; }
      .zai-dialog-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 18px; }
      .zai-dialog h2 { margin: 0; font-size: 20px; line-height: 1.35; }
      .zai-dialog-subtitle { margin: 3px 0 0; color: color-mix(in srgb, CanvasText 60%, transparent); font-size: 12px; }
      .zai-dialog-tools { display: flex; flex: 0 0 auto; gap: 4px; }
      .zai-dialog label { display: grid; gap: 7px; font-weight: 600; }
      .zai-key-setup { margin-top: 8px; }
      .zai-key-setup p { margin: 8px 0; }
      .zai-api-key { padding: 8px 10px; border: 1px solid color-mix(in srgb, CanvasText 25%, transparent); border-radius: 6px; font: inherit; }
      .zai-icon-button { display: inline-grid; place-items: center; width: 30px; height: 30px; padding: 0; border: 0; border-radius: 7px; color: color-mix(in srgb, CanvasText 65%, transparent); background: transparent; cursor: pointer; }
      .zai-close { font: 22px/1 system-ui; }
      .zai-settings-toggle { font: 17px/1 system-ui; }
      .zai-close:hover, .zai-settings-toggle:hover, .zai-settings-toggle[aria-expanded="true"] { background: color-mix(in srgb, CanvasText 8%, transparent); }
      .zai-display-settings { margin: 4px 0 14px; padding: 12px; border: 1px solid color-mix(in srgb, CanvasText 12%, transparent); border-radius: 9px; background: color-mix(in srgb, CanvasText 3%, transparent); }
      .zai-settings-heading { margin-bottom: 7px; font-weight: 700; }
      .zai-font-control { display: grid; grid-template-columns: minmax(120px, 1fr) 52px auto; gap: 8px; align-items: center; }
      .zai-font-slider { width: 100%; min-height: 24px !important; accent-color: #2563eb; }
      .zai-font-value { font-variant-numeric: tabular-nums; text-align: center; }
      .zai-save-font { min-width: 58px; }
      .zai-font-preview { margin-top: 9px; padding: 7px 9px; border-radius: 6px; background: Canvas; line-height: 1.5; }
      .zai-font-feedback { min-height: 17px; margin-top: 5px; color: #047857; font-size: 11px; }
      .zai-pages { padding: 8px 10px; border: 1px solid color-mix(in srgb, CanvasText 25%, transparent); border-radius: var(--zai-radius); font: inherit; }
      .zai-page-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; align-items: stretch; }
      .zai-detect-range { min-height: 38px; white-space: nowrap; }
      .zai-detect-range:disabled { opacity: .6; cursor: wait; }
      .zai-range-result { margin-top: 7px; color: color-mix(in srgb, CanvasText 68%, transparent); font-size: 12px; }
      .zai-range-result[data-state="success"] { color: #047857; }
      .zai-range-result[data-state="warning"] { color: #b45309; }
      .zai-range-result[data-state="error"] { color: #be123c; }
      .zai-cache-note { margin-top: 10px; padding: 8px 10px; border: 1px solid color-mix(in srgb, #2563eb 22%, transparent); border-radius: var(--zai-radius); color: color-mix(in srgb, CanvasText 76%, transparent); background: color-mix(in srgb, #3b82f6 7%, Canvas); font-size: 12px; line-height: 1.55; }
      .zai-help { opacity: .7; font-size: 12px; }
      .zai-status { margin-top: 8px; }
      .zai-status-row { display: flex; align-items: center; gap: 12px; min-height: 44px; }
      .zai-status-title { display: block; font-size: 16px; }
      .zai-status-detail { margin-top: 3px; color: color-mix(in srgb, CanvasText 62%, transparent); font-size: 12px; }
      .zai-status-icon { flex: 0 0 auto; display: grid; place-items: center; width: 34px; height: 34px; border-radius: 50%; background: #dbeafe; color: #2563eb; }
      .zai-status-icon::before { content: "…"; font-weight: 700; }
      .zai-status-icon.working::before { content: ""; width: 13px; height: 13px; border: 2px solid #93c5fd; border-top-color: #2563eb; border-radius: 50%; animation: zai-spin .8s linear infinite; }
      .zai-status-icon.success { color: #047857; background: #d1fae5; }
      .zai-status-icon.success::before { content: "✓"; }
      .zai-status-icon.warning { color: #b45309; background: #fef3c7; }
      .zai-status-icon.warning::before { content: "!"; }
      .zai-status-icon.error { color: #be123c; background: #ffe4e6; }
      .zai-status-icon.error::before { content: "×"; }
      @keyframes zai-spin { to { transform: rotate(360deg); } }
      .zai-stages { display: grid; grid-template-columns: repeat(6, 1fr); gap: 4px; margin: 18px 0 10px; }
      .zai-stages span { padding-top: 7px; border-top: 3px solid color-mix(in srgb, CanvasText 12%, transparent); color: color-mix(in srgb, CanvasText 48%, transparent); text-align: center; font-size: 10px; }
      .zai-stages span.done { border-color: #60a5fa; color: #2563eb; }
      .zai-stages span.active { border-color: #2563eb; color: CanvasText; font-weight: 700; }
      .zai-progress-bar { width: 100%; height: 8px; accent-color: #2563eb; }
      .zai-progress-meta { min-height: 18px; margin-top: 7px; color: color-mix(in srgb, CanvasText 70%, transparent); font-size: 12px; }
      .zai-counts, .zai-tokens { margin-top: 10px; padding: 10px; border-radius: var(--zai-radius); background: color-mix(in srgb, CanvasText 5%, transparent); font-size: 12px; line-height: 1.5; }
      .zai-tokens { display: grid; grid-template-columns: repeat(auto-fit, minmax(82px, 1fr)); gap: 8px; margin-top: 6px; color: color-mix(in srgb, CanvasText 75%, transparent); }
      .zai-metric { display: grid; gap: 1px; min-width: 0; padding-left: 8px; border-left: 2px solid color-mix(in srgb, #2563eb 35%, transparent); }
      .zai-metric strong { color: CanvasText; font-size: 13px; font-variant-numeric: tabular-nums; }
      .zai-metric span, .zai-metric small { overflow: hidden; color: color-mix(in srgb, CanvasText 62%, transparent); font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
      .zai-error { margin-top: 12px; padding: 8px; border-radius: 6px; color: #9f1239; background: #ffe4e6; white-space: pre-wrap; }
      .zai-button { display: inline-flex; align-items: center; justify-content: center; min-height: var(--zai-control-height, 36px); padding: 7px 13px; border: 1px solid transparent; border-radius: var(--zai-radius, 8px); font: 600 13px/1 system-ui; white-space: nowrap; cursor: pointer; transition: background .15s ease, border-color .15s ease, color .15s ease, box-shadow .15s ease; }
      .zai-button--primary { border-color: var(--zai-blue, #2563eb); color: white; background: var(--zai-blue, #2563eb); }
      .zai-button--primary:hover { background: #1d4ed8; border-color: #1d4ed8; }
      .zai-button--secondary { border-color: color-mix(in srgb, var(--zai-blue, #2563eb) 42%, transparent); color: #1d4ed8; background: color-mix(in srgb, #3b82f6 8%, Canvas); }
      .zai-button--secondary:hover { border-color: #60a5fa; background: color-mix(in srgb, #3b82f6 15%, Canvas); }
      .zai-button--ghost { border-color: transparent; color: color-mix(in srgb, CanvasText 78%, transparent); background: transparent; }
      .zai-button--ghost:hover { border-color: color-mix(in srgb, CanvasText 14%, transparent); background: color-mix(in srgb, CanvasText 6%, transparent); }
      .zai-button--danger { border-color: #fecdd3; color: #be123c; background: #fff1f2; }
      .zai-button--danger:hover { border-color: #fda4af; background: #ffe4e6; }
      .zai-button--compact { min-height: 30px; padding: 5px 10px; font-size: 12px; }
      .zai-button:disabled { opacity: .58; cursor: not-allowed; }
      .zai-dialog input { box-sizing: border-box; width: 100%; min-width: 0; min-height: 38px; color: CanvasText; background: Canvas; }
      .zai-actions { display: flex !important; visibility: visible !important; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 8px; margin-top: 20px; padding-top: 16px; border-top: 1px solid color-mix(in srgb, CanvasText 9%, transparent); }
      .zai-actions > .zai-button { display: inline-flex !important; visibility: visible !important; opacity: 1 !important; }
      .zai-progress-bar { display: block; overflow: hidden; border: 0; border-radius: 999px; background: color-mix(in srgb, CanvasText 8%, transparent); }
      .zai-progress-bar::-moz-progress-bar { background: #3b82f6; border-radius: 999px; }
      .zai-progress-meta, .zai-error, .zai-tokens { overflow-wrap: anywhere; }
      @media (prefers-color-scheme: dark) {
        #zotero-ai-reader-button[data-status="running"] { color: #93c5fd; }
        #zotero-ai-reader-button[data-status="completed"] { color: #6ee7b7; }
        #zotero-ai-reader-button[data-status="warning"] { color: #fcd34d; }
        #zotero-ai-reader-button[data-status="error"] { color: #fda4af; }
        .zai-button--secondary { color: #93c5fd; background: color-mix(in srgb, #3b82f6 18%, Canvas); }
        .zai-button--danger { color: #fda4af; background: color-mix(in srgb, #e11d48 18%, Canvas); }
        .zai-cache-note { color: #bfdbfe; background: color-mix(in srgb, #3b82f6 15%, Canvas); }
        #zai-tooltip { color: CanvasText; background: color-mix(in srgb, Canvas 94%, #0f172a); border-color: color-mix(in srgb, #60a5fa 55%, transparent); }
        .zai-tooltip-summary, .zai-math, .zai-math-symbol, .zai-math-script { color: CanvasText; }
        .zai-tooltip-translation { color: color-mix(in srgb, CanvasText 86%, transparent); }
      }
      @media (prefers-reduced-motion: reduce) { .zai-status-icon.working::before, #zotero-ai-reader-button .zai-toolbar-icon { animation: none; } }
      @media (max-width: 520px) { .zai-page-row { grid-template-columns: 1fr; } }
      @media (max-width: 440px) { .zai-dialog { padding: 18px; } .zai-actions > .zai-button--primary { flex: 1 0 100%; order: 3; } .zai-actions > .zai-button--secondary { flex: 1 1 auto; } .zai-dialog-header { gap: 8px; } }
      .zai-paragraph-layer { position: absolute; z-index: 8; box-sizing: border-box; border-left: 2px solid rgba(37,99,235,.5); background: rgba(37,99,235,.025); border-radius: 2px; cursor: help; pointer-events: auto; transition: background .12s ease, outline-color .12s ease; }
      .zai-paragraph-layer:hover { outline: 1px solid rgba(37,99,235,.7); background: rgba(37,99,235,.12); }
      .zai-page-badge { position: absolute; z-index: 10; top: 8px; right: 8px; padding: 4px 7px; border-radius: 999px; color: #1d4ed8; background: rgba(219,234,254,.96); font: 11px/1.2 system-ui; box-shadow: 0 1px 4px rgba(0,0,0,.18); pointer-events: none; }
      #zai-tooltip { position: fixed; z-index: 2147483646; box-sizing: border-box; width: min(440px, calc(100vw - 24px)); max-height: 52vh; overflow: auto; overscroll-behavior: contain; scrollbar-gutter: stable; padding: 13px 15px; border: 1px solid #93c5fd; border-radius: 10px; color: #172554; background: rgba(255,255,255,.98); box-shadow: 0 12px 32px rgba(15,23,42,.28); font: 13px/1.7 system-ui; white-space: pre-wrap; pointer-events: auto; user-select: text; }
      .zai-tooltip-heading { color: #2563eb; font-size: 11px; font-weight: 700; letter-spacing: .04em; }
      .zai-tooltip-summary { margin-top: 3px; color: #1e3a8a; font-weight: 600; }
      .zai-tooltip-divider { height: 1px; margin: 9px 0; background: #dbeafe; }
      .zai-tooltip-translation { color: #334155; font-size: var(--zai-translation-font-size, 16px); line-height: 1.75; }
      .zai-math, .zai-math-symbol, .zai-math-script { color: #172554; font-family: "Cambria Math", "STIX Two Math", "Noto Sans Math", "Times New Roman", serif; }
      .zai-math { display: inline; margin: 0 .08em; white-space: nowrap; }
      .zai-math-script { font-size: .72em; line-height: 0; }
      .zai-math-bar { text-decoration: overline; }
      .zai-math-vec::after { content: "\u20d7"; margin-left: -.5em; }
      .zai-math-hat { text-decoration: overline; }
      .zai-math-tilde { text-decoration: overline wavy; }
      .zai-math-mathbf { font-weight: 700; }
      .zai-math-mathit { font-style: italic; }
      .zai-math-mathcal { font-style: italic; font-family: "Cambria Math", cursive; }
      .zai-math-frac { display: inline-flex; flex-direction: column; align-items: stretch; vertical-align: -.45em; margin: 0 .12em; font-size: .9em; line-height: 1.05; text-align: center; }
      .zai-math-frac-top { padding: 0 .15em .08em; border-bottom: 1px solid currentColor; }
      .zai-math-frac-bottom { padding: .08em .15em 0; }
      .zai-math-sqrt { display: inline-flex; align-items: flex-start; }
      .zai-math-radicand { margin-left: .04em; padding: 0 .08em; border-top: 1px solid currentColor; }
      .zai-tooltip-actions { display: flex; flex-wrap: wrap; gap: 7px; margin-top: 12px; padding-top: 10px; border-top: 1px solid color-mix(in srgb, #2563eb 18%, transparent); }
      .zai-formula-picker { min-inline-size: 0; margin: 9px 0 0; padding: 9px; border: 1px solid #bfdbfe; border-radius: 8px; background: #f8fbff; }
      .zai-formula-picker[hidden] { display: none; }
      .zai-formula-picker legend { padding: 0 4px; color: #1d4ed8; font-size: 11px; font-weight: 700; }
      .zai-formula-list { display: grid; gap: 6px; }
      .zai-formula-option { display: grid; grid-template-columns: auto auto minmax(0, 1fr); align-items: center; gap: 7px; padding: 6px 7px; border: 1px solid #dbeafe; border-radius: 6px; background: #fff; cursor: pointer; user-select: none; }
      .zai-formula-option:hover { border-color: #93c5fd; background: #eff6ff; }
      .zai-formula-option input { margin: 0; accent-color: #2563eb; }
      .zai-formula-number { color: #475569; font: 600 11px/1.2 system-ui; white-space: nowrap; }
      .zai-formula-preview { min-width: 0; overflow-x: auto; color: #172554; text-align: right; white-space: pre; }
      .zai-formula-picker-actions { display: flex; justify-content: flex-end; margin-top: 8px; }
      .zai-formula-picker .zai-button:disabled { cursor: not-allowed; opacity: .55; }
      .zai-tooltip-action[data-copied="true"] { color: #047857; border-color: #6ee7b7; background: #ecfdf5; }
      .zai-copy-feedback { min-height: 18px; margin-top: 5px; color: #475569; font-size: 11px; line-height: 1.4; }
      .zai-clipboard-fallback { position: fixed; top: -1000px; left: -1000px; opacity: 0; }
      @media (prefers-color-scheme: dark) { .zai-formula-picker { border-color: color-mix(in srgb, #60a5fa 50%, transparent); background: color-mix(in srgb, #3b82f6 10%, Canvas); } .zai-formula-option { border-color: color-mix(in srgb, #60a5fa 34%, transparent); color: CanvasText; background: color-mix(in srgb, Canvas 92%, #172554); } .zai-formula-option:hover { background: color-mix(in srgb, #3b82f6 20%, Canvas); } .zai-formula-number, .zai-formula-preview { color: CanvasText; } }
    `;
    doc.head.append(style);
  }

  // 覆盖层位于 PDF.js 的内部 iframe，需要单独把样式注入该文档。
  function injectOverlayStyles(doc) {
    if (doc.getElementById("zotero-ai-reader-overlay-styles")) return;
    injectKaTeXStyles(doc);
    const style = doc.createElement("style");
    style.id = "zotero-ai-reader-overlay-styles";
    style.textContent = `
      .zai-paragraph-layer { position: absolute; z-index: 8; box-sizing: border-box; border-left: 2px solid rgba(37,99,235,.5); background: rgba(37,99,235,.025); border-radius: 2px; cursor: help; pointer-events: auto; transition: background .12s ease, outline-color .12s ease; }
      .zai-paragraph-layer:hover { outline: 1px solid rgba(37,99,235,.7); background: rgba(37,99,235,.12); }
      .zai-page-badge { position: absolute; z-index: 10; top: 8px; right: 8px; padding: 4px 7px; border-radius: 999px; color: #1d4ed8; background: rgba(219,234,254,.96); font: 11px/1.2 system-ui; box-shadow: 0 1px 4px rgba(0,0,0,.18); pointer-events: none; }
      #zai-tooltip { position: fixed; z-index: 2147483646; box-sizing: border-box; width: min(440px, calc(100vw - 24px)); max-height: 52vh; overflow: auto; overscroll-behavior: contain; scrollbar-gutter: stable; padding: 13px 15px; border: 1px solid #93c5fd; border-radius: 10px; color: #172554; background: rgba(255,255,255,.98); box-shadow: 0 12px 32px rgba(15,23,42,.28); font: 13px/1.7 system-ui; white-space: pre-wrap; pointer-events: auto; user-select: text; }
      .zai-tooltip-heading { color: #2563eb; font-size: 11px; font-weight: 700; letter-spacing: .04em; }
      .zai-tooltip-summary { margin-top: 3px; color: #1e3a8a; font-weight: 600; }
      .zai-tooltip-divider { height: 1px; margin: 9px 0; background: #dbeafe; }
      .zai-tooltip-translation { color: #334155; font-size: var(--zai-translation-font-size, 16px); line-height: 1.75; }
      .zai-math, .zai-math-symbol, .zai-math-script { color: #172554; font-family: "Cambria Math", "STIX Two Math", "Noto Sans Math", "Times New Roman", serif; }
      .zai-math { display: inline; margin: 0 .08em; white-space: nowrap; }
      .zai-math-script { font-size: .72em; line-height: 0; }
      .zai-math-bar { text-decoration: overline; }
      .zai-math-vec::after { content: "\u20d7"; margin-left: -.5em; }
      .zai-math-hat { text-decoration: overline; }
      .zai-math-tilde { text-decoration: overline wavy; }
      .zai-math-mathbf { font-weight: 700; }
      .zai-math-mathit { font-style: italic; }
      .zai-math-mathcal { font-style: italic; font-family: "Cambria Math", cursive; }
      .zai-math-frac { display: inline-flex; flex-direction: column; align-items: stretch; vertical-align: -.45em; margin: 0 .12em; font-size: .9em; line-height: 1.05; text-align: center; }
      .zai-math-frac-top { padding: 0 .15em .08em; border-bottom: 1px solid currentColor; }
      .zai-math-frac-bottom { padding: .08em .15em 0; }
      .zai-math-sqrt { display: inline-flex; align-items: flex-start; }
      .zai-math-radicand { margin-left: .04em; padding: 0 .08em; border-top: 1px solid currentColor; }
      .zai-tooltip-actions { display: flex; flex-wrap: wrap; gap: 7px; margin-top: 12px; padding-top: 10px; border-top: 1px solid color-mix(in srgb, #2563eb 18%, transparent); }
      .zai-button { display: inline-flex; align-items: center; justify-content: center; min-height: 30px; padding: 5px 10px; border: 1px solid color-mix(in srgb, #2563eb 42%, transparent); border-radius: 8px; color: #1d4ed8; background: color-mix(in srgb, #3b82f6 8%, Canvas); font: 600 12px/1 system-ui; cursor: pointer; }
      .zai-button:hover { border-color: #60a5fa; background: color-mix(in srgb, #3b82f6 15%, Canvas); }
      .zai-formula-picker { min-inline-size: 0; margin: 9px 0 0; padding: 9px; border: 1px solid #bfdbfe; border-radius: 8px; background: #f8fbff; }
      .zai-formula-picker[hidden] { display: none; }
      .zai-formula-picker legend { padding: 0 4px; color: #1d4ed8; font-size: 11px; font-weight: 700; }
      .zai-formula-list { display: grid; gap: 6px; }
      .zai-formula-option { display: grid; grid-template-columns: auto auto minmax(0, 1fr); align-items: center; gap: 7px; padding: 6px 7px; border: 1px solid #dbeafe; border-radius: 6px; background: #fff; cursor: pointer; user-select: none; }
      .zai-formula-option:hover { border-color: #93c5fd; background: #eff6ff; }
      .zai-formula-option input { margin: 0; accent-color: #2563eb; }
      .zai-formula-number { color: #475569; font: 600 11px/1.2 system-ui; white-space: nowrap; }
      .zai-formula-preview { min-width: 0; overflow-x: auto; color: #172554; text-align: right; white-space: pre; }
      .zai-formula-picker-actions { display: flex; justify-content: flex-end; margin-top: 8px; }
      .zai-formula-picker .zai-button:disabled { cursor: not-allowed; opacity: .55; }
      .zai-tooltip-action[data-copied="true"] { color: #047857; border-color: #6ee7b7; background: #ecfdf5; }
      .zai-copy-feedback { min-height: 18px; margin-top: 5px; color: #475569; font-size: 11px; line-height: 1.4; }
      .zai-clipboard-fallback { position: fixed; top: -1000px; left: -1000px; opacity: 0; }
      @media (prefers-color-scheme: dark) { #zai-tooltip { color: CanvasText; background: color-mix(in srgb, Canvas 94%, #0f172a); border-color: color-mix(in srgb, #60a5fa 55%, transparent); } .zai-tooltip-summary, .zai-math, .zai-math-symbol, .zai-math-script { color: CanvasText; } .zai-tooltip-translation { color: color-mix(in srgb, CanvasText 86%, transparent); } .zai-button { color: #93c5fd; background: color-mix(in srgb, #3b82f6 18%, Canvas); } }
      @media (prefers-color-scheme: dark) { .zai-formula-picker { border-color: color-mix(in srgb, #60a5fa 50%, transparent); background: color-mix(in srgb, #3b82f6 10%, Canvas); } .zai-formula-option { border-color: color-mix(in srgb, #60a5fa 34%, transparent); color: CanvasText; background: color-mix(in srgb, Canvas 92%, #172554); } .zai-formula-option:hover { background: color-mix(in srgb, #3b82f6 20%, Canvas); } .zai-formula-number, .zai-formula-preview { color: CanvasText; } }
    `;
    doc.head.append(style);
  }

  function injectKaTeXStyles(doc) {
    if (!pluginRootURI || doc.getElementById("zotero-ai-reader-katex-styles")) return;
    const link = doc.createElement("link");
    link.id = "zotero-ai-reader-katex-styles";
    link.rel = "stylesheet";
    link.href = `${pluginRootURI}vendor/katex/katex.min.css`;
    doc.head.append(link);
  }

  return { init, shutdown, _test: { taskView, renderActions, buildChatGPTPrompt, normalizeMathBoundaryText, classifyMathBoundaryContent, isPureNumericBracketCitation, extractObsidianMathMarkdown, selectedFormulaState, translationFontSize, shouldRenderParagraph, renderMathText, renderOverlays } };
})();
