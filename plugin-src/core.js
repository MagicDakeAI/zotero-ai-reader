export function parsePageRange(input, totalPages) {
  if (!Number.isInteger(totalPages) || totalPages < 1) throw new RangeError("PDF 总页数无效");
  const text = String(input || "").trim();
  if (!text) throw new TypeError("请输入页码");
  const pages = new Set();
  for (const rawPart of text.split(",")) {
    const part = rawPart.trim();
    if (!part) throw new TypeError("页码格式错误");
    const match = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(part);
    if (!match) throw new TypeError(`页码格式错误：${part}`);
    const start = Number(match[1]);
    const end = Number(match[2] || match[1]);
    if (start < 1 || end < 1 || start > end) throw new RangeError(`页码范围无效：${part}`);
    if (end > totalPages) throw new RangeError(`页码超出 PDF 范围：${part}`);
    for (let page = start; page <= end; page += 1) pages.add(page);
  }
  return [...pages].sort((a, b) => a - b);
}

export function formatPageRange(pages) {
  const sorted = [...new Set(pages)].sort((a, b) => a - b);
  const ranges = [];
  for (let index = 0; index < sorted.length;) {
    const start = sorted[index];
    let end = start;
    while (index + 1 < sorted.length && sorted[index + 1] === end + 1) {
      index += 1;
      end = sorted[index];
    }
    ranges.push(start === end ? `${start}` : `${start}-${end}`);
    index += 1;
  }
  return ranges.join(",");
}

export function createBatches(paragraphs, maxChars = 7_000, maxItems = 8) {
  if (!Number.isFinite(maxChars) || maxChars < 1000) throw new RangeError("maxChars 太小");
  if (!Number.isInteger(maxItems) || maxItems < 1) throw new RangeError("maxItems 无效");
  const batches = [];
  let current = [];
  let size = 0;
  for (const paragraph of paragraphs) {
    const cost = paragraph.original.length + 160;
    if (current.length && (size + cost > maxChars || current.length >= maxItems)) {
      batches.push(current);
      current = [];
      size = 0;
    }
    current.push(paragraph);
    size += cost;
  }
  if (current.length) batches.push(current);
  return batches;
}

export function buildTranslationPrompt(paragraphs) {
  const items = paragraphs.map((paragraph) => ({ id: paragraph.paragraph_id, text: paragraph.original }));
  return [
    "翻译 JSON 中每个 items 元素的 text 为自然、完整的中文学术译文。",
    "数学公式、变量及其上下标必须按原文完整保留。输出中每个公式用 [[math:...]] 包围，并把 LaTeX 命令的反斜杠改用 § 代替。",
    "纯数字方括号文献引用必须作为普通文本原样保留，禁止置入 [[math:...]]。例如 [40]、[17, 24, 31]、[17-24]、[17–24, 31] 都是引文，不是数学公式。",
    "作者—年份引用、孤立数字上标引用、图表/章节/算法/附录/方程编号，以及 URL、DOI、邮箱和文件名也必须作为普通文本保留，禁止置入 [[math:...]]。例如 (Smith et al., 2024)、Fig. 2、Table S1、Section 3.1、Eq. (4)、https://example.com 和 10.1000/example 都不是公式。",
    "例如：[[math:x §sim f(x)]]、[[math:§mathcal{D}=§{(x_i,y_i)§}_{i=1}^{N}]]、[[math:§tilde{x}_i=x_i+§xi_i]]。这是为了避免 JSON 反斜杠转义失败。",
    "返回的 t 和 s 中禁止出现反斜杠字符。不得把 §sim 改成冒号，不得删除集合括号、上下标、希腊字母或重音符号；公式外的文字才翻译为中文。",
    "返回仅含 results 的 JSON：{\"results\":[{\"id\":\"输入 id\",\"t\":\"译文\",\"s\":\"不超过40个汉字的摘要\"}]}。",
    "id 必须与输入一致；不得遗漏、合并或拆分。纯参考文献的 t、s 均为空字符串。",
    "禁止回传 text、禁止 Markdown 或任何额外字段。",
    JSON.stringify({ items }),
  ].join("\n");
}

export function validateTranslationResults(source, results) {
  if (!Array.isArray(results)) throw invalidModelOutput("DeepSeek 输出缺少 results 数组");
  const byId = new Map(results.map((item) => [item.id, item]));
  if (byId.size !== results.length) throw invalidModelOutput("DeepSeek 输出含重复 paragraph_id");
  if (results.length !== source.length) throw invalidModelOutput("DeepSeek 输出段落数量与输入不一致");
  return source.map((paragraph) => {
    const result = byId.get(paragraph.paragraph_id);
    if (!result) throw invalidModelOutput(`DeepSeek 输出缺失或错配：${paragraph.paragraph_id}`);
    if (typeof result.t !== "string" || typeof result.s !== "string") {
      throw invalidModelOutput(`DeepSeek 输出字段类型错误：${paragraph.paragraph_id}`);
    }
    const translation = result.t.trim();
    const summary = result.s.trim();
    return {
      ...paragraph,
      translation,
      summary,
      processing_status: translation || summary ? "completed" : "skipped_reference",
    };
  });
}

function invalidModelOutput(message) {
  const error = new TypeError(message);
  error.code = "INVALID_MODEL_OUTPUT";
  return error;
}

export function getJsonShape(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return typeof value;
  return `对象字段：${Object.keys(value).slice(0, 12).join(", ") || "（空）"}`;
}

export function classifySkippedParagraphs(paragraphs) {
  const skipped = new Map();
  let referencesFromPage = null;
  for (const paragraph of paragraphs) {
    const text = paragraph.original.replace(/\s+/g, " ").trim();
    if (/^(references|bibliography|参考文献)$/i.test(text)) {
      referencesFromPage = paragraph.page;
      skipped.set(paragraph.paragraph_id, "skipped_reference");
    } else if (referencesFromPage !== null && paragraph.page >= referencesFromPage) {
      skipped.set(paragraph.paragraph_id, "skipped_reference");
    }
  }

  const edgeText = new Map();
  for (const paragraph of paragraphs) {
    const text = paragraph.original.replace(/\s+/g, " ").trim();
    if (!text || text.length > 160) continue;
    const [, y, , height] = paragraph.bbox || [];
    const pageHeight = Number(paragraph.page_height);
    if (!Number.isFinite(y) || !Number.isFinite(height) || !pageHeight) continue;
    const atEdge = y <= pageHeight * 0.1 || y + height >= pageHeight * 0.9;
    if (!atEdge) continue;
    if (/^(?:page\s*)?\d+(?:\s*\/\s*\d+)?$/i.test(text)) {
      skipped.set(paragraph.paragraph_id, "skipped_boilerplate");
      continue;
    }
    const key = text.toLocaleLowerCase();
    const entries = edgeText.get(key) || [];
    entries.push(paragraph);
    edgeText.set(key, entries);
  }
  for (const entries of edgeText.values()) {
    if (new Set(entries.map((item) => item.page)).size < 3) continue;
    for (const paragraph of entries) {
      if (!skipped.has(paragraph.paragraph_id)) skipped.set(paragraph.paragraph_id, "skipped_boilerplate");
    }
  }
  return skipped;
}

function isReferenceHeading(value) {
  const text = String(value || "")
    .replace(/\s+/g, " ")
    .replace(/^\s*(?:\d+(?:\.\d+)*[.)]?|[ivxlcdm]+[.)])\s*/i, "")
    .trim();
  return /^(?:references?|bibliography|works cited|literature cited)$/i.test(text);
}

function isMeaningfulBeforeReference(paragraph, skipped) {
  const text = String(paragraph.original || "").replace(/\s+/g, " ").trim();
  if (!text || /^(?:page\s*)?\d+(?:\s*\/\s*\d+)?$/i.test(text)) return false;
  if (skipped.get(paragraph.paragraph_id) === "skipped_boilerplate") return false;
  const [, y, , height] = paragraph.bbox || [];
  const pageHeight = Number(paragraph.page_height);
  const atEdge = Number.isFinite(y) && Number.isFinite(height) && pageHeight > 0 &&
    (y <= pageHeight * 0.1 || y + height >= pageHeight * 0.9);
  // 页边缘的短文本通常是期刊名、论文标题或页眉，不应让新起的 References 页被误判为“页内开始”。
  return !(atEdge && text.length <= 160);
}

/**
 * 根据 References 标题位置确定正文的最后一页。
 * References 在页首时截止上一页；同页前面还有正文时保留该页。
 */
export function detectMainTextRange(paragraphs, totalPages) {
  if (!Number.isInteger(totalPages) || totalPages < 1) throw new RangeError("PDF 总页数无效");
  const ordered = [...(paragraphs || [])];
  const candidates = ordered.filter((paragraph) => isReferenceHeading(paragraph.original));
  if (!candidates.length) return { found: false, pageRange: `1-${totalPages}`, endPage: totalPages };

  // 目录中可能也有独立的 References 文本块，优先使用最后一个标题。
  const heading = candidates.at(-1);
  const headingIndex = ordered.indexOf(heading);
  const skipped = classifySkippedParagraphs(ordered);
  const hasBodyBefore = ordered.slice(0, headingIndex).some((paragraph) =>
    paragraph.page === heading.page && isMeaningfulBeforeReference(paragraph, skipped));
  const endPage = Math.max(1, hasBodyBefore ? heading.page : heading.page - 1);
  return {
    found: true,
    pageRange: endPage === 1 ? "1" : `1-${endPage}`,
    endPage,
    referencePage: heading.page,
    referencesStartOnNewPage: !hasBodyBefore,
  };
}
