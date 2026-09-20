import fs from "node:fs";
import path from "node:path";
import archiver from "archiver";

const root = path.resolve("plugin");
const dist = path.resolve("dist");
fs.mkdirSync(dist, { recursive: true });
const packageJson = JSON.parse(fs.readFileSync(path.resolve("package.json"), "utf8"));
const outputPath = path.join(dist, `zotero-ai-reader-${packageJson.version}.xpi`);
const output = fs.createWriteStream(outputPath);
const archive = archiver("zip", { zlib: { level: 9 } });
archive.on("error", (error) => { throw error; });
output.on("close", () => console.log(`${outputPath} (${archive.pointer()} bytes)`));
archive.pipe(output);
archive.directory(root, false);
await archive.finalize();
