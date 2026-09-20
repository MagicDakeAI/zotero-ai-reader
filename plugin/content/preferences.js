var ZoteroAIReaderPrefs = {
  get doc() {
    return document;
  },

  async init() {
    const settings = Zotero.AIReaderService.getSettings();
    this.doc.getElementById("zai-pref-model").value = settings.model;
    this.doc.getElementById("zai-pref-batch").value = settings.maxBatchChars;
    this.doc.getElementById("zai-pref-concurrency").value = settings.concurrency;
    this.doc.getElementById("zai-pref-timeout").value = settings.timeoutMs;
    this.doc.getElementById("zai-pref-retries").value = settings.retryCount;
    this.doc.getElementById("zai-pref-translation-font-size").value = settings.translationFontSize;
    this.updateFontSizeLabel();
    await this.refreshKeyStatus();
  },

  async refreshKeyStatus() {
    const status = await Zotero.AIReaderService.getAPIKeyStatus();
    this.doc.getElementById("zai-pref-key-status").textContent = status.configured
      ? `已配置 ${status.masked}`
      : "未配置";
  },

  show(message, kind = "") {
    const node = this.doc.getElementById("zai-pref-message");
    node.textContent = message;
    node.dataset.kind = kind;
  },

  async saveKey() {
    const input = this.doc.getElementById("zai-pref-key");
    const key = input.value.trim();
    if (!key) return this.show("请先粘贴新的 API Key。", "error");
    this.show("正在验证连接…");
    try {
      await Zotero.AIReaderService.configureAPIKey(key);
      input.value = "";
      await this.refreshKeyStatus();
      this.show("API Key 已验证并安全保存。", "success");
    } catch (error) {
      this.show(error.message || "API Key 验证失败。", "error");
    }
  },

  async testConnection() {
    this.show("正在测试连接…");
    try {
      await Zotero.AIReaderService.testAPIKey();
      this.show("DeepSeek 连接正常。", "success");
    } catch (error) {
      this.show(error.message || "连接失败。", "error");
    }
  },

  async clearKey() {
    await Zotero.AIReaderService.clearAPIKey();
    this.doc.getElementById("zai-pref-key").value = "";
    await this.refreshKeyStatus();
    this.show("API Key 已清除。", "success");
  },

  updateFontSizeLabel() {
    const value = this.doc.getElementById("zai-pref-translation-font-size").value;
    this.doc.getElementById("zai-pref-translation-font-size-value").textContent = `${value} px`;
  },

  saveDisplaySettings() {
    const settings = Zotero.AIReaderService.getSettings();
    const translationFontSize = this.doc.getElementById("zai-pref-translation-font-size").value;
    const saved = Zotero.AIReaderService.saveSettings({ ...settings, translationFontSize });
    this.doc.getElementById("zai-pref-translation-font-size").value = saved.translationFontSize;
    this.updateFontSizeLabel();
    this.show(`译文字号已保存为 ${saved.translationFontSize} px。重新悬停译文即可生效。`, "success");
  },

  saveAdvanced() {
    const value = (id) => this.doc.getElementById(id).value;
    const settings = Zotero.AIReaderService.saveSettings({
      model: value("zai-pref-model"),
      maxBatchChars: value("zai-pref-batch"),
      concurrency: value("zai-pref-concurrency"),
      timeoutMs: value("zai-pref-timeout"),
      retryCount: value("zai-pref-retries"),
      translationFontSize: value("zai-pref-translation-font-size"),
    });
    this.show(`高级设置已保存：${settings.model}，并发 ${settings.concurrency}。`, "success");
  },
};
