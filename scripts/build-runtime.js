import { build, context } from "esbuild";
import fs from "node:fs";
import path from "node:path";

const vendorDir = path.resolve("plugin/vendor/katex");
fs.mkdirSync(path.join(vendorDir, "fonts"), { recursive: true });
fs.copyFileSync(path.resolve("node_modules/katex/dist/katex.min.js"), path.join(vendorDir, "katex.min.js"));
fs.copyFileSync(path.resolve("node_modules/katex/dist/katex.min.css"), path.join(vendorDir, "katex.min.css"));
const katexFontsDir = path.resolve("node_modules/katex/dist/fonts");
for (const name of fs.readdirSync(katexFontsDir)) {
  fs.copyFileSync(path.join(katexFontsDir, name), path.join(vendorDir, "fonts", name));
}

const watch = process.argv.includes("--watch");
const buildOptions = {
  entryPoints: [path.resolve("plugin-src/service.js")],
  bundle: true,
  format: "iife",
  globalName: "AIReaderService",
  platform: "browser",
  target: "firefox115",
  outfile: path.resolve("plugin/content/service.js"),
  sourcemap: false,
  legalComments: "none",
  logLevel: "info",
};

if (watch) {
  const buildContext = await context(buildOptions);
  await buildContext.watch();
  console.log("AI Reader 插件运行时正在监听源码变更。按 Ctrl+C 停止。");
} else {
  await build(buildOptions);
}
