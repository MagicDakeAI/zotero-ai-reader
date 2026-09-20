import test from "node:test";
import assert from "node:assert/strict";
import { DeepSeekClient, parseModelJson } from "../plugin-src/service.js";

const source = [{ paragraph_id: "p001", page: 1, original: "A short academic paragraph." }];
const config = () => ({ baseUrl: "https://api.deepseek.com", model: "deepseek-flash", timeoutMs: 1000, retryCount: 2 });

test("插件内 DeepSeek 请求关闭思考模式并采集 Token", async () => {
  let request;
  const events = [];
  const client = new DeepSeekClient({
    keyProvider: async () => "test-key",
    configProvider: config,
    httpRequest: async (method, url, options) => {
      request = { method, url, options };
      return { status: 200, response: {
        choices: [{ finish_reason: "stop", message: { content: JSON.stringify({
          results: [{ id: "p001", t: "一段简短的学术段落。", s: "简短示例。" }],
        }) } }],
        usage: {
          prompt_tokens: 80, completion_tokens: 40, total_tokens: 120,
          prompt_cache_hit_tokens: 64, prompt_cache_miss_tokens: 16,
          completion_tokens_details: { reasoning_tokens: 0 },
        },
      } };
    },
  });
  const result = await client.translate(source, { onEvent: (event) => events.push(event) });
  const payload = JSON.parse(request.options.body);
  assert.equal(request.method, "POST");
  assert.equal(request.url, "https://api.deepseek.com/chat/completions");
  assert.equal(request.options.headers.Authorization, "Bearer test-key");
  assert.deepEqual(payload.thinking, { type: "disabled" });
  assert.deepEqual(payload.response_format, { type: "json_object" });
  assert.doesNotMatch(payload.messages[1].content, /"p":1/);
  assert.equal(events.at(-1).usage.totalTokens, 120);
  assert.equal(events.at(-1).usage.cacheHitTokens, 64);
  assert.equal(result[0].translation, "一段简短的学术段落。");
});

test("未配置密钥时不发送网络请求", async () => {
  const client = new DeepSeekClient({
    keyProvider: async () => "", configProvider: config,
    httpRequest: async () => { throw new Error("不应调用网络"); },
  });
  await assert.rejects(() => client.translate(source), /尚未配置/);
});

test("限流响应自动重试并统计真实请求次数", async () => {
  let calls = 0;
  const events = [];
  const client = new DeepSeekClient({
    keyProvider: async () => "test-key", configProvider: config,
    httpRequest: async () => {
      calls += 1;
      if (calls === 1) {
        const error = new Error("rate limited");
        error.status = 429;
        throw error;
      }
      return { status: 200, response: { choices: [{ message: { content: JSON.stringify({
        results: [{ id: "p001", t: "译文", s: "摘要" }],
      }) } }] } };
    },
  });
  const result = await client.translate(source, { onEvent: (event) => events.push(event) });
  assert.equal(calls, 2);
  assert.equal(events.filter((event) => event.type === "request.started").length, 2);
  assert.equal(result[0].translation, "译文");
});

test("401 被转换为不会泄露密钥的配置错误", async () => {
  const client = new DeepSeekClient({
    keyProvider: async () => "secret-key-value", configProvider: config,
    httpRequest: async () => {
      const error = new Error("unauthorized secret-key-value");
      error.status = 401;
      throw error;
    },
  });
  await assert.rejects(async () => client.translate(source), (error) => {
    assert.equal(error.code, "AUTH_INVALID");
    assert.doesNotMatch(error.message, /secret-key-value/);
    return true;
  });
});

test("模型返回错配结果时自动重试", async () => {
  let calls = 0;
  const client = new DeepSeekClient({
    keyProvider: async () => "test-key", configProvider: config,
    httpRequest: async () => {
      calls += 1;
      const results = calls === 1
        ? []
        : [{ id: "p001", t: "修复后的译文", s: "摘要" }];
      return { status: 200, response: { choices: [{ message: { content: JSON.stringify({ results }) } }] } };
    },
  });
  const result = await client.translate(source);
  assert.equal(calls, 2);
  assert.equal(result[0].translation, "修复后的译文");
});

test("连续翻译的请求完全隔离，审计信息不含原文或译文", async () => {
  const bodies = [];
  const audits = [];
  const client = new DeepSeekClient({
    keyProvider: async () => "secret-key-value", configProvider: config,
    httpRequest: async (_method, _url, options) => {
      const body = JSON.parse(options.body);
      bodies.push(body);
      const prompt = body.messages[1].content;
      const id = JSON.parse(prompt.split("\n").at(-1)).items[0].id;
      return { status: 200, response: { choices: [{ message: { content: JSON.stringify({
        results: [{ id, t: `译文-${id}`, s: "摘要" }],
      }) } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } } };
    },
  });
  await client.translate([{ ...source[0], paragraph_id: "first", original: "FIRST_PRIVATE_TEXT" }], {
    onEvent: (event) => { if (event.audit) audits.push(event.audit); },
  });
  await client.translate([{ ...source[0], paragraph_id: "second", original: "SECOND_PRIVATE_TEXT" }], {
    onEvent: (event) => { if (event.audit) audits.push(event.audit); },
  });
  assert.doesNotMatch(JSON.stringify(bodies[1]), /FIRST_PRIVATE_TEXT|first|译文-first/);
  const serializedAudits = JSON.stringify(audits);
  assert.doesNotMatch(serializedAudits, /PRIVATE_TEXT|译文|secret-key-value/);
  assert.match(audits[0].requestHash, /^[a-f0-9]{64}$/);
});

test("部分输出错误时只重试异常段落", async () => {
  const requestedIds = [];
  const events = [];
  const paragraphs = [
    { ...source[0], paragraph_id: "p1", original: "one" },
    { ...source[0], paragraph_id: "p2", original: "two" },
  ];
  const client = new DeepSeekClient({
    keyProvider: async () => "key", configProvider: config,
    httpRequest: async (_method, _url, options) => {
      const items = JSON.parse(JSON.parse(options.body).messages[1].content.split("\n").at(-1)).items;
      requestedIds.push(items.map((item) => item.id));
      const results = items.length === 2
        ? [{ id: "p1", t: "译文1", s: "摘要1" }]
        : [{ id: "p2", t: "译文2", s: "摘要2" }];
      return { status: 200, response: {
        choices: [{ message: { content: JSON.stringify({ results }) } }],
        usage: { prompt_tokens: items.length * 10, completion_tokens: 5, total_tokens: items.length * 10 + 5 },
      } };
    },
  });
  const result = await client.translate(paragraphs, { onEvent: (event) => events.push(event), batchIndex: 1 });
  assert.deepEqual(requestedIds, [["p1", "p2"], ["p2"]]);
  assert.deepEqual(result.map((item) => item.translation), ["译文1", "译文2"]);
  const responses = events.filter((event) => event.type === "response.received");
  assert.equal(responses[1].audit.retryReason, "partial_output");
  assert.equal(responses.reduce((sum, event) => sum + event.usage.totalTokens, 0), 40);
});

test("无效 JSON 最多进行一次完整修复重试", async () => {
  let calls = 0;
  const client = new DeepSeekClient({
    keyProvider: async () => "key", configProvider: config,
    httpRequest: async () => {
      calls += 1;
      return { status: 200, response: { choices: [{ message: { content: "not-json" } }] } };
    },
  });
  await assert.rejects(() => client.translate(source), /完整修复重试仍失败/);
  assert.equal(calls, 2);
});

test("数学协议避免 LaTeX 反斜杠破坏 JSON，并在入库前还原", async () => {
  const client = new DeepSeekClient({
    keyProvider: async () => "key", configProvider: config,
    httpRequest: async (_method, _url, options) => {
      const prompt = JSON.parse(options.body).messages[1].content;
      assert.match(prompt, /\[\[math:/);
      assert.match(prompt, /§mathcal/);
      assert.match(prompt, /普通文本.*\[17, 24, 31\]/);
      assert.match(prompt, /Smith et al\., 2024.*Fig\. 2.*10\.1000\/example/);
      return { status: 200, response: { choices: [{ message: { content: JSON.stringify({
        results: [{
          id: "p001",
          t: "设 [[math:§mathcal{D}=§{(x_i,y_i)§}_{i=1}^{N}]] 且 [[math:§tilde{x}_i=x_i+§xi_i]]。",
          s: "保留公式",
        }],
      }) } }] } };
    },
  });
  const [result] = await client.translate(source);
  assert.equal(result.translation, "设 \\(\\mathcal{D}=\\{(x_i,y_i)\\}_{i=1}^{N}\\) 且 \\(\\tilde{x}_i=x_i+\\xi_i\\)。");
});

test("容错解析可修复模型返回的未转义 LaTeX", () => {
  const parsed = parseModelJson('{"results":[{"id":"p1","t":"\\xi_i + \\varepsilon_i","s":"摘要"}]}');
  assert.equal(parsed.results[0].t, "\\xi_i + \\varepsilon_i");
});
