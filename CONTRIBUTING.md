# 贡献指南

感谢你愿意帮助改进 Zotero AI Reader。这个仓库目前以稳定、可审计的 PDF 段落翻译体验为优先目标。

## 开发环境

- Zotero 10.0.2 或更高版本（用于人工验收）。
- Node.js 20 或更高版本（仅用于构建和测试）。

安装依赖并运行完整测试：

```powershell
npm install
npm test
```

生成可安装的 XPI：

```powershell
npm run build:xpi
```

构建结果会写入 `dist/`，该目录不提交到仓库；正式发布时请将生成的 `.xpi` 作为 GitHub Release 附件上传。

## 代码结构

- `plugin-src/`：可维护的运行时源码；其中 `service.js` 会被构建为插件中的运行时代码。
- `plugin/`：Zotero 插件清单、界面代码和随安装包分发的资源。
- `scripts/`：运行时构建与 XPI 打包脚本。
- `test/`：Node 内置测试框架的自动化测试。

不要直接修改构建生成的 `plugin/content/service.js`；请修改 `plugin-src/service.js`，再运行构建命令。

## 提交改动

1. 每次改动后运行 `npm test`。
2. 如改动影响用户可见行为，请更新 `CHANGELOG.md`，并使用中文说明。
3. 如改变缓存的字段或兼容策略，请同步更新 `CACHE_FORMAT.md`。
4. 请不要提交 API Key、真实 PDF、个人 Zotero 数据目录、构建产物或 `node_modules/`。

## 问题与安全

普通功能问题请通过 GitHub Issues 描述 Zotero 版本、插件版本、复现步骤和已脱敏的错误信息。请勿在 Issue 中提交 API Key、论文正文或个人数据。

如果发现可能泄露密钥、论文内容或本地文件的安全问题，请不要公开创建 Issue；请先联系仓库维护者并提供最小化复现信息。
