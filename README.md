# Zotero AI Reader

面向 Zotero 10 的纯插件式 AI 论文翻译工具。只处理用户明确选择的 PDF 页面，为正文段落生成中文译文和一句话摘要；原 PDF 永不修改，结果保存在插件独立缓存中。

> 独立开源项目，与 Zotero、DeepSeek 均无隶属或官方背书关系。使用前请确认你有权将所选 PDF 内容发送至 DeepSeek API；API 调用可能产生费用。

## 用户安装

最终用户不需要安装 Node.js，也不需要打开终端或运行 npm。

1. 确认 Zotero 版本为 10.0.2 或更高，从 [Releases](https://github.com/LeyangGu/zotero-ai-reader/releases) 下载最新 `.xpi`。
2. 在 Zotero 中打开“工具 → 插件”，安装该 XPI。
3. 打开一篇 PDF；如果已有译文，插件会自动识别并直接显示。首次翻译时点击 Reader 顶部的“AI 翻译”。
4. 首次使用时粘贴 DeepSeek API Key，插件会先验证连接，再安全保存。
5. 选择页码并开始翻译。任务可以收起到后台继续运行。

API Key 也可以在“设置 → Zotero AI Reader”中更换、测试或清除。密钥保存在 Zotero/Firefox 的加密登录存储中，不会写入普通设置、日志或翻译缓存。

## 当前能力

- 纯 Zotero 插件运行时：PDF 提取、任务调度、缓存和 DeepSeek 请求均在 Zotero 内完成。
- 页码支持 `1-8`、`1-8,10,12-15`，严格拒绝越界和非法输入。
- 通过 Zotero 内置 Structured Document Text / PDFWorker 读取附件，不跨 iframe 传递私有 PDF.js 对象；只取选中页的结构化段落并保留 bbox。
- 提取和翻译都不依赖 Reader DOM，任务启动后收起卡片或关闭 PDF 标签不会导致 `getTextContent` / `getViewport` 错误。
- 显式关闭 DeepSeek 思考模式，统计输入、输出、缓存命中及 reasoning token。
- 分开显示本地译文缓存与 DeepSeek Prompt Cache，并单独统计重试产生的 Token。
- 每次请求仅记录段落 ID、字符数和 SHA-256 指纹等审计元数据，不记录原文、译文或 API Key。
- 部分段落输出异常时只补发异常段落；无效 JSON 最多整批修复一次。
- 本地跳过参考文献、纯页码和重复页眉页脚；相同段落优先复用本地缓存。
- 不翻译表格主体和图像内部 OCR 文本，保留图注、表注和普通正文，避免大面积覆盖图表及无效 Token 消耗。
- 后台任务卡片显示逐页、段落和批次进度；支持取消、失败重试和完成后明确关闭。
- 每个成功批次立即原子写入缓存；中途失败或 Zotero 重启后无需重译已完成内容。
- 插件、模型或提示词升级不会使旧译文失效；只有用户明确选择“强制重译所选页”才会调用模型替换当前版本。
- 强制重译会追加译文修订，失败时仍保留并显示上一个有效版本。
- 自动无损迁移旧版 `ai-reader-cache/*.json` 和 `%USERPROFILE%/.zotero-ai-reader/cache`，原文件不会删除。
- 译文悬浮层会识别带完整 LaTeX 边界的公式；可勾选需要的公式后复制为 Obsidian 兼容 Markdown，保留行内与块级公式格式。引文、图表/章节/方程编号、URL、DOI、邮箱、文件名和不含数学特征的普通短语始终按普通文本显示，不进入公式选择器；该修正对已有缓存立即生效且不调用模型。

v2 缓存位于 Zotero 数据目录的 `ai-reader-cache/v2/<pdf_hash>.json`，按 PDF 内容哈希识别，不访问 `zotero.sqlite`。完整兼容约定见 [CACHE_FORMAT.md](CACHE_FORMAT.md)。

## DeepSeek 配置

默认使用 `deepseek-flash` 和 `https://api.deepseek.com/chat/completions`，启用 JSON Output，并发送 `thinking: { type: "disabled" }`。保存 Key 时调用 `/models` 验证，不产生模型 Token。

高级设置中可以调整模型、单批字符数、并发数、超时和自动重试次数。默认每批约 7000 字符、并发 2、超时 90 秒、自动重试 2 次。

## 开发者构建

Node.js 只用于开发测试和生成 XPI，不是插件运行依赖。

```powershell
npm install
npm test
npm run build:xpi
```

生成的安装包位于 `dist/zotero-ai-reader-0.6.6.xpi`。

开发时可监听插件运行时源码：

```powershell
npm run dev
```

`npm run dev` 只负责监听并重新生成 `plugin/content/service.js`，不会启动 HTTP Server，也不是用户使用步骤。

## 安全边界

- 不启动本地 Server、后台 EXE 或独立 Node 进程。
- 不读取 cookie，不模拟网页，只调用 DeepSeek 官方 API。
- DeepSeek 请求只包含选中页中尚未命中缓存的正文段落。
- API Key 不进入任务对象、缓存、日志或错误详情。
- 原 PDF 只读；插件不会修改或生成临时 PDF。

## 测试

`npm test` 覆盖页码语法、SDT 选页提取、跨页文本与 bbox、接口缺失的明确报错、DeepSeek 请求格式、Token 聚合、限流重试、加密密钥存储适配、批处理并发、缓存复用、任务取消、部分失败和 UI 状态映射。

真实 Zotero 验收流程：安装 XPI → 打开 PDF → 首次填写 Key → 翻译选中页 → 收起任务 → 完成后查看译文 → 关闭并重开 PDF → 不点击“AI 翻译”即可看到“已有译文”和页面浮层 → 验证模型调用与 Token 均为 0。
