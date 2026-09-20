var ZoteroAIReaderPrefs = {
  profiles: [],
  editingNew: false,
  get doc() { return document; },
  get selectedId() { return this.editingNew ? null : this.doc.getElementById("zai-pref-profile").value; },
  get selectedProfile() { return this.profiles.find((item) => item.id === this.selectedId) || null; },

  async init() {
    const settings = Zotero.AIReaderService.getSettings();
    this.doc.getElementById("zai-pref-batch").value = settings.maxBatchChars;
    this.doc.getElementById("zai-pref-concurrency").value = settings.concurrency;
    this.doc.getElementById("zai-pref-timeout").value = settings.timeoutMs;
    this.doc.getElementById("zai-pref-retries").value = settings.retryCount;
    this.doc.getElementById("zai-pref-translation-font-size").value = settings.translationFontSize;
    this.doc.getElementById("zai-pref-question-source").value = settings.questionContentSource || "original";
    this.doc.getElementById("zai-pref-question-template").value = settings.questionPromptTemplate
      || Zotero.AIReaderService.DEFAULT_QUESTION_PROMPT_TEMPLATE;
    this.updateFontSizeLabel();
    this.updateQuestionPreview();
    await this.reloadProfiles(settings.profileId);
  },

  async reloadProfiles(preferredId) {
    this.profiles = await Zotero.AIReaderService.listProfiles();
    const select = this.doc.getElementById("zai-pref-profile");
    select.replaceChildren(...this.profiles.map((profile) => {
      const option = this.doc.createElement("option");
      option.value = profile.id;
      option.textContent = `${profile.name}${profile.active ? "（当前）" : ""}`;
      return option;
    }));
    select.value = this.profiles.some((item) => item.id === preferredId)
      ? preferredId : this.profiles.find((item) => item.active)?.id || this.profiles[0]?.id;
    this.editingNew = false;
    await this.selectProfile();
  },

  async selectProfile() {
    this.editingNew = false;
    const profile = this.selectedProfile;
    if (!profile) return;
    this.doc.getElementById("zai-pref-profile-name").value = profile.name;
    this.doc.getElementById("zai-pref-profile-name").disabled = profile.builtin;
    this.doc.getElementById("zai-pref-base-url").value = profile.baseUrl;
    this.doc.getElementById("zai-pref-base-url").disabled = profile.builtin;
    this.doc.getElementById("zai-pref-model").value = profile.model;
    this.doc.getElementById("zai-pref-requires-key").checked = profile.requiresApiKey;
    this.doc.getElementById("zai-pref-requires-key").disabled = profile.builtin;
    this.doc.getElementById("zai-pref-delete-profile").disabled = profile.builtin;
    this.doc.getElementById("zai-pref-active-profile").textContent = profile.active ? `当前使用：${profile.name}` : "";
    this.updateKeyVisibility();
    await this.refreshKeyStatus();
  },

  newCustomProfile() {
    this.editingNew = true;
    this.doc.getElementById("zai-pref-profile-name").disabled = false;
    this.doc.getElementById("zai-pref-profile-name").value = "";
    this.doc.getElementById("zai-pref-base-url").disabled = false;
    this.doc.getElementById("zai-pref-base-url").value = "https://";
    this.doc.getElementById("zai-pref-model").value = "";
    this.doc.getElementById("zai-pref-requires-key").disabled = false;
    this.doc.getElementById("zai-pref-requires-key").checked = true;
    this.doc.getElementById("zai-pref-delete-profile").disabled = true;
    this.doc.getElementById("zai-pref-key-status").textContent = "请先保存配置";
    this.doc.getElementById("zai-pref-active-profile").textContent = "正在新建自定义配置";
    this.updateKeyVisibility();
  },

  profileInput() {
    const value = (id) => this.doc.getElementById(id).value;
    return { id: this.selectedId, name: value("zai-pref-profile-name"), baseUrl: value("zai-pref-base-url"),
      model: value("zai-pref-model"), requiresApiKey: this.doc.getElementById("zai-pref-requires-key").checked };
  },

  async saveProfile() {
    try {
      const saved = Zotero.AIReaderService.upsertProfile(this.profileInput());
      await this.reloadProfiles(saved.id);
      this.show(`已保存配置：${saved.name}。`, "success");
    } catch (error) { this.show(error.message || "保存失败。", "error"); }
  },

  async activateProfile() {
    if (this.editingNew) return this.show("请先保存新配置。", "error");
    try {
      const config = Zotero.AIReaderService.setActiveProfile(this.selectedId);
      await this.reloadProfiles(config.profileId);
      this.show(`已切换到 ${config.profileName}。`, "success");
    } catch (error) { this.show(error.message, "error"); }
  },

  async deleteProfile() {
    const profile = this.selectedProfile;
    if (!profile || profile.builtin) return;
    if (!this.doc.defaultView.confirm(`删除“${profile.name}”及其已保存的 API Key？`)) return;
    try {
      await Zotero.AIReaderService.deleteProfile(profile.id);
      await this.reloadProfiles("deepseek");
      this.show("配置和密钥已删除。", "success");
    } catch (error) { this.show(error.message, "error"); }
  },

  updateKeyVisibility() {
    this.doc.getElementById("zai-pref-key-row").hidden = !this.doc.getElementById("zai-pref-requires-key").checked;
  },

  async refreshKeyStatus() {
    const profile = this.selectedProfile;
    if (!profile) return;
    const status = await Zotero.AIReaderService.getAPIKeyStatus(profile.id);
    this.doc.getElementById("zai-pref-key-status").textContent = status.configured ? `已配置 ${status.masked}` : "未配置";
  },

  show(message, kind = "") {
    const node = this.doc.getElementById("zai-pref-message"); node.textContent = message; node.dataset.kind = kind;
  },

  async saveKey() {
    const profile = this.selectedProfile;
    const input = this.doc.getElementById("zai-pref-key");
    if (!profile) return this.show("请先保存配置。", "error");
    if (!input.value.trim()) return this.show("请先粘贴新的 API Key。", "error");
    this.show("正在验证连接…");
    try {
      const status = await Zotero.AIReaderService.configureAPIKey(profile.id, input.value.trim());
      input.value = "";
      await this.reloadProfiles(profile.id);
      this.show(status.warning || "API Key 已验证并安全保存。", status.warning ? "warning" : "success");
    } catch (error) { this.show(error.message || "API Key 验证失败。", "error"); }
  },

  async testConnection() {
    const profile = this.selectedProfile;
    if (!profile) return this.show("请先保存配置。", "error");
    this.show("正在测试连接…");
    try {
      const result = await Zotero.AIReaderService.testConnection(profile.id);
      this.setModelOptions(result.models);
      this.show(result.warning || `${profile.name} 连接正常，发现 ${result.models.length} 个模型。`, result.warning ? "warning" : "success");
    } catch (error) { this.show(error.message || "连接失败。", "error"); }
  },

  async loadModels() {
    const profile = this.selectedProfile;
    if (!profile) return this.show("请先保存配置。", "error");
    this.show("正在加载模型…");
    try {
      const models = await Zotero.AIReaderService.listModels(profile.id);
      this.setModelOptions(models);
      this.show(`已加载 ${models.length} 个模型，也可继续手动输入。`, "success");
    } catch (error) { this.show(error.message || "模型加载失败。", "error"); }
  },

  setModelOptions(models) {
    const list = this.doc.getElementById("zai-pref-model-list");
    list.replaceChildren(...models.map((model) => { const option = this.doc.createElement("option"); option.value = model; return option; }));
  },

  async clearKey() {
    const profile = this.selectedProfile;
    if (!profile) return;
    await Zotero.AIReaderService.clearAPIKey(profile.id);
    this.doc.getElementById("zai-pref-key").value = "";
    await this.reloadProfiles(profile.id);
    this.show("API Key 已清除。", "success");
  },

  updateFontSizeLabel() {
    const value = this.doc.getElementById("zai-pref-translation-font-size").value;
    this.doc.getElementById("zai-pref-translation-font-size-value").textContent = `${value} px`;
  },

  saveDisplaySettings() {
    const settings = Zotero.AIReaderService.getSettings();
    const saved = Zotero.AIReaderService.saveSettings({ ...settings,
      translationFontSize: this.doc.getElementById("zai-pref-translation-font-size").value });
    this.doc.getElementById("zai-pref-translation-font-size").value = saved.translationFontSize;
    this.updateFontSizeLabel();
    this.show(`译文字号已保存为 ${saved.translationFontSize} px。`, "success");
  },

  questionInput() {
    return {
      questionContentSource: this.doc.getElementById("zai-pref-question-source").value,
      questionPromptTemplate: this.doc.getElementById("zai-pref-question-template").value,
    };
  },

  updateQuestionPreview() {
    const preview = this.doc.getElementById("zai-pref-question-preview");
    const warning = this.doc.getElementById("zai-pref-question-warning");
    try {
      const input = this.questionInput();
      const inspection = Zotero.AIReaderService.inspectQuestionPromptTemplate(input.questionPromptTemplate);
      preview.textContent = Zotero.AIReaderService.buildQuestionPrompt({
        page: 3,
        original: "Foundation models can generalize across medical imaging tasks.",
        translation: "基础模型可以在多种医学影像任务之间泛化。",
        summary: "基础模型具有跨任务泛化能力。",
      }, input);
      warning.textContent = inspection.warnings.join(" ");
      warning.dataset.kind = inspection.warnings.length ? "warning" : "";
    } catch (error) {
      preview.textContent = "";
      warning.textContent = error.message || "模板无效。";
      warning.dataset.kind = "error";
    }
  },

  saveQuestionSettings() {
    try {
      const input = this.questionInput();
      const inspection = Zotero.AIReaderService.inspectQuestionPromptTemplate(input.questionPromptTemplate);
      Zotero.AIReaderService.saveSettings({ ...Zotero.AIReaderService.getSettings(), ...input });
      const suffix = inspection.warnings.length ? ` ${inspection.warnings.join(" ")}` : "";
      this.show(`提问设置已保存。${suffix}`, inspection.warnings.length ? "warning" : "success");
    } catch (error) {
      this.show(error.message || "提问设置保存失败。", "error");
    }
  },

  restoreQuestionDefaults() {
    this.doc.getElementById("zai-pref-question-source").value = "original";
    this.doc.getElementById("zai-pref-question-template").value = Zotero.AIReaderService.DEFAULT_QUESTION_PROMPT_TEMPLATE;
    this.updateQuestionPreview();
    this.show("已恢复默认内容，请点击“保存提问设置”确认。");
  },

  saveAdvanced() {
    const value = (id) => this.doc.getElementById(id).value;
    const saved = Zotero.AIReaderService.saveSettings({ ...Zotero.AIReaderService.getSettings(),
      maxBatchChars: value("zai-pref-batch"), concurrency: value("zai-pref-concurrency"),
      timeoutMs: value("zai-pref-timeout"), retryCount: value("zai-pref-retries"),
      translationFontSize: value("zai-pref-translation-font-size") });
    this.show(`高级设置已保存：并发 ${saved.concurrency}。`, "success");
  },
};
