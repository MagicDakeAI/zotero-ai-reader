import test from "node:test";
import assert from "node:assert/strict";
import { SecretStore, createAbortController, normalizeTranslationFontSize } from "../plugin-src/service.js";

test("译文字号仅接受 12 至 22px 的整数，非法值回退默认值", () => {
  assert.equal(normalizeTranslationFontSize(12), 12);
  assert.equal(normalizeTranslationFontSize("18.6"), 19);
  assert.equal(normalizeTranslationFontSize(22), 22);
  for (const value of [undefined, "", 11, 23, "invalid"]) {
    assert.equal(normalizeTranslationFontSize(value), 16);
  }
});

function fakeLoginManager() {
  const records = [];
  return {
    records,
    searches: [],
    async searchLoginsAsync(query) {
      this.searches.push(query);
      return records.filter((login) => login.origin === query.origin && login.httpRealm === query.httpRealm);
    },
    async addLoginAsync(login) { records.push(login); },
    async modifyLoginAsync(oldLogin, newLogin) { records.splice(records.indexOf(oldLogin), 1, newLogin); },
    async removeLoginAsync(login) { records.splice(records.indexOf(login), 1); },
  };
}

test("API Key 只通过登录存储读写且状态不会回显原文", async () => {
  const logins = fakeLoginManager();
  const store = new SecretStore({
    logins,
    createLoginInfo: (origin, formActionOrigin, httpRealm, username, password) => ({
      origin, formActionOrigin, httpRealm, username, password,
    }),
  });
  await store.set("sk-super-secret-1234");
  assert.deepEqual(logins.searches[0], {
    origin: "https://api.deepseek.com",
    httpRealm: "DeepSeek API Key",
  });
  assert.equal(await store.get(), "sk-super-secret-1234");
  const status = await store.status();
  assert.deepEqual(status, { configured: true, masked: "••••1234" });
  assert.doesNotMatch(JSON.stringify(status), /super-secret/);
  await store.set("sk-replacement-5678");
  assert.equal(logins.records.length, 1);
  assert.equal(await store.get(), "sk-replacement-5678");
  await store.clear();
  assert.deepEqual(await store.status(), { configured: false, masked: "" });
});

test("Zotero 插件沙箱缺少 AbortController 时仍可取消任务", () => {
  const controller = createAbortController(null);
  let calls = 0;
  const listener = () => { calls += 1; };
  controller.signal.addEventListener("abort", listener, { once: true });
  controller.abort();
  controller.abort();
  assert.equal(controller.signal.aborted, true);
  assert.equal(calls, 1);
});
