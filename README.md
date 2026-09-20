# Zotero AI Reader

> 在 Zotero 里选几页，直接在原文旁看中文译文。

Zotero AI Reader 是面向 Zotero 10 的 AI 论文精读插件。它只翻译你指定的 PDF 页面，把段落译文和一句话摘要叠加在原文位置；不用导出 PDF，不用切换网页，也不会修改你的原始论文。

[下载最新版 XPI](https://github.com/LeyangGu/zotero-ai-reader/releases) · [查看更新日志](CHANGELOG.md) · [隐私说明](PRIVACY.md)

## 为什么适合读论文

- **按需翻译，不浪费 Token**：支持 `1-8,10,12-15` 这样的页码范围，只向 AI 发送你选择的正文段落。
- **原文译文一一对应**：译文悬浮在对应段落旁，保留原文阅读节奏，并附一句话摘要，适合快速判断一段在讲什么。
- **读过一次，下次秒开**：译文保存在本地独立缓存中；重新打开 PDF 会自动显示，命中缓存时不再调用模型。
- **公式可以直接带走**：选择需要的公式，一键复制为 Obsidian 兼容 Markdown，区分行内与块级公式。
- **长文也能放心跑**：翻译可收起到后台，显示页码、段落与批次进度；支持取消、失败重试和断点保留已完成结果。

## 30 秒开始使用

1. 下载 [最新 `.xpi` 安装包](https://github.com/LeyangGu/zotero-ai-reader/releases)，要求 Zotero `10.0.2+`。
2. 在 Zotero 中打开“工具 → 插件”，点击齿轮图标，选择“从文件安装插件”，选中下载的 XPI。
3. 打开一篇 PDF，点击阅读器顶部的“AI 翻译”，首次使用时填写 DeepSeek API Key。
4. 输入要翻译的页码，开始翻译；完成后直接在原文旁阅读中文译文。

API Key 可在“设置 → Zotero AI Reader”中测试、更换或清除。它保存在 Zotero/Firefox 的加密登录存储中，不会写入普通设置或译文缓存。

## 你会看到什么

| 场景 | 插件会做什么 |
| --- | --- |
| 只想读论文的第 3–6 页 | 仅提取并翻译这些页的正文，跳过参考文献、页码和重复页眉页脚。 |
| 关闭 PDF 后再打开 | 自动识别本地译文并显示，不需要再次点击翻译或支付 API 费用。 |
| 某一段翻译失败 | 只重试出错段落，已经成功的内容会立即保留。 |
| 想把公式记到 Obsidian | 勾选公式后复制为 Markdown；引文、DOI、图表编号等不会被误当成公式。 |

## 隐私与费用

- 仅在你点击“开始翻译”后，才会把所选页面中未命中缓存的正文段落发送到 DeepSeek API。
- 不修改原 PDF，不读取 cookie，不启动本地服务，也不收集遥测数据。
- API Key、原文和译文不会写入日志；缓存和密钥的详细规则见[隐私说明](PRIVACY.md)。
- DeepSeek API 可能产生费用。请确认你有权将所选论文内容发送给第三方服务。

## 开发与贡献

Node.js 仅用于开发、测试和打包，普通用户无需安装。

```powershell
npm install
npm test
npm run build:xpi
```

完整贡献流程见 [CONTRIBUTING.md](CONTRIBUTING.md)，缓存兼容约定见 [CACHE_FORMAT.md](CACHE_FORMAT.md)。

本项目为独立开源项目，与 Zotero、DeepSeek 均无隶属或官方背书关系。
