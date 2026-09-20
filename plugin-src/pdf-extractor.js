function cleanText(value) {
  return String(value || "")
    .replace(/\u00ad/g, "")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .trim();
}

function finiteRect(rect) {
  return Array.isArray(rect) && rect.length >= 5 && rect.slice(0, 5).every(Number.isFinite);
}

function collectPageRects(node, pageIndex, output = []) {
  const rects = node?.anchor?.pageRects;
  if (Array.isArray(rects)) {
    for (const rect of rects) {
      if (finiteRect(rect) && rect[0] === pageIndex) output.push(rect);
    }
  }
  if (Array.isArray(node?.content)) {
    for (const child of node.content) collectPageRects(child, pageIndex, output);
  }
  return output;
}

function textNodeBelongsToPage(node, pageIndex) {
  const encoded = node?.anchor?.textMap;
  if (typeof encoded !== "string") return true;
  try {
    const runs = JSON.parse(encoded);
    return !Array.isArray(runs) || !runs.length || runs.some((run) => Array.isArray(run) && run[1] === pageIndex);
  } catch {
    return true;
  }
}

function collectText(node, pageIndex, output = []) {
  if (!node || typeof node !== "object") return output;
  if (typeof node.text === "string") {
    if (textNodeBelongsToPage(node, pageIndex)) output.push(node.text);
    return output;
  }
  if (Array.isArray(node.content)) {
    for (const child of node.content) collectText(child, pageIndex, output);
  }
  return output;
}

function unionPageRects(rects, viewRect) {
  if (!rects.length) return null;
  const left = Math.min(...rects.map((rect) => rect[1]));
  const bottom = Math.min(...rects.map((rect) => rect[2]));
  const right = Math.max(...rects.map((rect) => rect[3]));
  const top = Math.max(...rects.map((rect) => rect[4]));
  const originX = Number(viewRect?.[0]) || 0;
  const originY = Number(viewRect?.[1]) || 0;
  return [left - originX, bottom - originY, right - left, top - bottom]
    .map((number) => Math.round(number * 100) / 100);
}

function pageSize(page) {
  const rect = page?.viewRect;
  if (!Array.isArray(rect) || rect.length !== 4 || !rect.every(Number.isFinite)) {
    throw new Error("结构化文档缺少有效的页面尺寸");
  }
  const width = Math.abs(rect[2] - rect[0]);
  const height = Math.abs(rect[3] - rect[1]);
  if (!width || !height) throw new Error("结构化文档的页面尺寸无效");
  return { width, height };
}

const TEXT_BLOCK_TYPES = new Set([
  "paragraph", "heading", "caption", "note", "listitem", "preformatted", "math",
]);
const VISUAL_BLOCK_TYPES = new Set(["image", "table"]);

function collectTextBlocks(nodes, pageIndex, output = []) {
  for (const node of nodes || []) {
    if (!node || typeof node !== "object") continue;
    // 表格和图像内部的 OCR/结构化文本会生成巨大遮挡层，且翻译结果缺乏结构。
    // 整块跳过，但保留与其并列的 caption 节点，方便阅读图注和表注。
    if (VISUAL_BLOCK_TYPES.has(node.type)) continue;
    const text = cleanText(collectText(node, pageIndex).join(" "));
    const rects = collectPageRects(node, pageIndex);
    if (TEXT_BLOCK_TYPES.has(node.type) && text && rects.length) {
      output.push({ text, rects, type: node.type });
      continue;
    }
    if (Array.isArray(node.content)) collectTextBlocks(node.content, pageIndex, output);
  }
  return output;
}

export async function hashText(text, cryptoImpl = globalThis.crypto) {
  if (!cryptoImpl?.subtle) throw new Error("当前 Zotero 环境不支持 Web Crypto");
  const bytes = new TextEncoder().encode(text);
  const digest = await cryptoImpl.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * 通过 Zotero 10 内置 Structured Document Text / PDFWorker 提取文本。
 * 这个接口读取附件文件，不传递 Reader iframe 中的 PDF.js 对象。
 */
export async function extractSelectedPages(sdt, itemID, selectedPages, {
  onPage,
  onPrepareProgress,
  signal,
  cryptoImpl,
} = {}) {
  if (typeof sdt?.getReader !== "function") {
    throw new Error("当前 Zotero 版本缺少结构化 PDF 提取接口，请升级到 Zotero 10.0.2 或更高版本");
  }
  if (signal?.aborted) throw new Error("任务已取消");

  let reader;
  try {
    reader = await sdt.getReader(itemID, {
      isPriority: true,
      onProgress: (percent) => {
        if (!signal?.aborted && Number.isFinite(percent)) onPrepareProgress?.(percent);
      },
    });
  } catch (error) {
    throw new Error(`Zotero 无法提取 PDF 结构化文本：${error?.message || error}`);
  }
  if (signal?.aborted) throw new Error("任务已取消");
  if (!reader) throw new Error("Zotero 无法生成 PDF 结构化文本");

  const catalog = await reader.getCatalog();
  const catalogPages = Array.isArray(catalog?.pages) ? catalog.pages : [];
  const invalid = selectedPages.filter((page) => page < 1 || page > catalogPages.length);
  if (invalid.length) throw new RangeError(`页码超出 PDF 范围：${invalid.join(",")}`);

  const pages = [];
  const paragraphs = [];
  for (const pageNumber of selectedPages) {
    if (signal?.aborted) throw new Error("任务已取消");
    const pageIndex = pageNumber - 1;
    const page = catalogPages[pageIndex];
    const size = pageSize(page);
    const blocks = await reader.getPageBlocks(pageIndex);
    const textBlocks = collectTextBlocks(blocks, pageIndex);
    pages.push({ page: pageNumber, width: size.width, height: size.height });

    for (let index = 0; index < textBlocks.length; index += 1) {
      const block = textBlocks[index];
      const bbox = unionPageRects(block.rects, page.viewRect);
      if (!bbox || bbox[2] <= 0 || bbox[3] <= 0) continue;
      paragraphs.push({
        paragraph_id: `p${String(pageNumber).padStart(4, "0")}-${String(index + 1).padStart(3, "0")}`,
        page: pageNumber,
        bbox,
        page_width: size.width,
        page_height: size.height,
        block_type: block.type,
        original: block.text,
        paragraph_hash: await hashText(block.text, cryptoImpl),
      });
    }
    onPage?.({ current: pages.length, total: selectedPages.length, page: pageNumber });
  }
  return { totalPages: catalogPages.length, pages, paragraphs };
}
