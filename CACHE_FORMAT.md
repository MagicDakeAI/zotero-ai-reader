# 缓存格式与兼容约定

Zotero AI Reader 0.6.0 起使用稳定的 v2 缓存。缓存属于用户数据，不属于插件安装包；插件更新、禁用或卸载都不会自动删除缓存。

## 位置与身份

- 目录：`<Zotero 数据目录>/ai-reader-cache/v2/`
- 文件：`<pdf_hash>.json`
- 主键：Zotero 提供的 PDF 附件内容哈希
- Zotero item key 仅记录在 `attachment_refs` 中，不参与文件命名或缓存命中。

相同内容的 PDF 即使 item key 不同，也会复用同一份缓存。PDF 内容发生变化时会产生新的内容哈希和缓存文件。

## v2 结构

```json
{
  "schema_version": 2,
  "pdf_hash": "…",
  "created_at": "…",
  "updated_at": "…",
  "attachment_refs": [{ "item_key": "ABCD1234" }],
  "migration_sources": ["v1:旧文件名.json"],
  "pages": {
    "1": {
      "page": 1,
      "width": 612,
      "height": 792,
      "occurrences": [
        {
          "paragraph_id": "p0001-001",
          "paragraph_hash": "…",
          "bbox": [0, 0, 100, 20],
          "block_type": "paragraph"
        }
      ]
    }
  },
  "entries": {
    "<paragraph_hash>": {
      "paragraph_hash": "…",
      "original": "…",
      "translations": {
        "zh-CN": {
          "active_revision_id": "rev-…",
          "revisions": [
            {
              "id": "rev-…",
              "translation": "…",
              "summary": "…",
              "processing_status": "completed",
              "prompt_version": "…",
              "model": "…",
              "created_at": "…",
              "operation_id": "…"
            }
          ]
        }
      }
    }
  }
}
```

页面位置与译文分开保存。重新提取 PDF 时可以更新 bbox，而已生成的译文仍按 `paragraph_hash` 复用。提示词和模型版本只记录来源，不参与有效性判断。

## 长期兼容规则

1. 普通翻译永久复用已有的成功译文，不因插件、模型或提示词版本变化而失效。
2. 强制重译只追加修订；每个段落的新修订成功写入后才成为该段落的当前版本，旧修订不删除。
3. 每次写入先写临时文件，再原子替换目标文件；同一 PDF 的写操作在进程内串行执行。
4. 无法解析的 v2 文件会报告“缓存异常”，插件不会用空缓存覆盖它。
5. v1 和 `%USERPROFILE%/.zotero-ai-reader/cache` 只读迁移到 v2，旧文件保留不动。
6. 不执行自动过期、容量淘汰或卸载清理。任何未来的删除功能都必须由用户明确触发。

未来如需扩展字段，读取器必须忽略不认识的可选字段。只有无法通过向后兼容扩展表达的结构变化才允许增加 `schema_version`，并且迁移必须保留全部译文修订。
