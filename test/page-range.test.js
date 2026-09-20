import test from "node:test";
import assert from "node:assert/strict";
import { detectMainTextRange, formatPageRange, parsePageRange } from "../plugin-src/core.js";

test("解析组合页码并去重排序", () => {
  assert.deepEqual(parsePageRange("1-8,10,12-15,3", 20), [1,2,3,4,5,6,7,8,10,12,13,14,15]);
});

test("拒绝越界、逆序和非法格式", () => {
  assert.throws(() => parsePageRange("0,2", 10), /范围无效/);
  assert.throws(() => parsePageRange("8-3", 10), /范围无效/);
  assert.throws(() => parsePageRange("1;2", 10), /格式错误/);
  assert.throws(() => parsePageRange("11", 10), /超出/);
});

test("格式化连续范围", () => {
  assert.equal(formatPageRange([1,2,3,7,9,10]), "1-3,7,9-10");
});

const paragraph = (page, id, original, y = 300) => ({
  page, paragraph_id: id, original, bbox: [20, y, 300, 30], page_height: 800,
});

test("References 新起一页时正文截止到上一页", () => {
  const result = detectMainTextRange([
    paragraph(7, "body", "Final conclusion paragraph."),
    paragraph(8, "header", "Paper title", 770),
    paragraph(8, "refs", "REFERENCES", 700),
    paragraph(8, "citation", "[1] Example citation"),
  ], 10);
  assert.deepEqual(result, {
    found: true, pageRange: "1-7", endPage: 7, referencePage: 8, referencesStartOnNewPage: true,
  });
});

test("References 与 Conclusion 同页时保留当前页", () => {
  const result = detectMainTextRange([
    paragraph(8, "conclusion", "Conclusion content remains above the reference section."),
    paragraph(8, "refs", "8. References"),
  ], 10);
  assert.equal(result.pageRange, "1-8");
  assert.equal(result.referencesStartOnNewPage, false);
});

test("未找到 References 时保留全文范围", () => {
  assert.deepEqual(detectMainTextRange([paragraph(1, "body", "Main text")], 3), {
    found: false, pageRange: "1-3", endPage: 3,
  });
});
