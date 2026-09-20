import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("Zotero 10 manifest 包含 bootstrapped 扩展必填兼容字段", () => {
  const manifest = JSON.parse(fs.readFileSync("plugin/manifest.json", "utf8"));
  const packageJson = JSON.parse(fs.readFileSync("package.json", "utf8"));
  const zotero = manifest.applications?.zotero;
  assert.equal(manifest.manifest_version, 2);
  assert.equal(manifest.version, packageJson.version);
  assert.equal(manifest.applications?.gecko?.id, zotero.id);
  assert.match(zotero.update_url, /^https:\/\//);
  assert.equal(zotero.strict_min_version, "10.0.2");
  assert.equal(zotero.strict_max_version, "10.0.*");
});

test("更新清单与安装包版本一致", () => {
  const manifest = JSON.parse(fs.readFileSync("plugin/manifest.json", "utf8"));
  const updates = JSON.parse(fs.readFileSync("updates.json", "utf8"));
  const addon = updates.addons[manifest.applications.zotero.id];
  const latest = addon.updates.at(-1);
  assert.equal(latest.version, manifest.version);
  assert.match(latest.update_link, new RegExp(`v${manifest.version}/zotero-ai-reader-${manifest.version}\\.xpi$`));
  assert.match(latest.update_hash, /^sha256:[a-f0-9]{64}$/);
});

test("发布插件不再包含 localhost Bridge 或 Node 运行依赖", () => {
  const packageJson = JSON.parse(fs.readFileSync("package.json", "utf8"));
  const runtime = [
    "plugin/bootstrap.js",
    "plugin/content/ai-reader.js",
    "plugin/content/service.js",
  ].map((path) => fs.readFileSync(path, "utf8")).join("\n");
  assert.equal(packageJson.scripts.bridge, undefined);
  assert.equal(packageJson.dependencies, undefined);
  assert.equal(packageJson.devDependencies["pdfjs-dist"], undefined);
  assert.equal(packageJson.devDependencies["pdf-lib"], undefined);
  assert.doesNotMatch(runtime, /127\.0\.0\.1|23128|\/jobs|\/restore/);
  assert.doesNotMatch(runtime, /\.getTextContent\s*\(|\.getViewport\s*\(/);
  assert.match(runtime, /Zotero\.SDT/);
  assert.equal(fs.existsSync("plugin/preferences.xhtml"), true);
  assert.equal(fs.existsSync("plugin/prefs.js"), true);
  assert.equal(fs.existsSync("plugin/vendor/katex/katex.min.js"), true);
  assert.equal(fs.existsSync("plugin/vendor/katex/katex.min.css"), true);
});
