import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { transform } from "esbuild";
import sharp from "sharp";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptDir, "..");
const frontendDir = join(repoRoot, "frontend");
const assetsDir = join(frontendDir, "assets");
const outputDir = join(frontendDir, "dist");

await rm(outputDir, { recursive: true, force: true });
await mkdir(join(outputDir, "assets"), { recursive: true });

const [appSource, cssSource, htmlSource, mark, icon] = await Promise.all([
  readFile(join(frontendDir, "app.js"), "utf8"),
  readFile(join(frontendDir, "styles.css"), "utf8"),
  readFile(join(frontendDir, "index.html"), "utf8"),
  ensureWebp("trinetra-mark.webp", "trinetra-mark.png"),
  ensureWebp("trinetra-mark-128.webp", "trinetra-mark-128.png")
]);

const appBuffer = Buffer.from((await transform(appSource, { loader: "js", format: "esm", minify: true, target: "es2020" })).code);
const cssBuffer = Buffer.from((await transform(cssSource, { loader: "css", minify: true })).code);
const appName = `app.${contentHash(appBuffer)}.js`;
const cssName = `styles.${contentHash(cssBuffer)}.css`;
const markName = `trinetra-mark.${contentHash(mark)}.webp`;
const iconName = `trinetra-mark-128.${contentHash(icon)}.webp`;

const outputHtml = htmlSource
  .replace('href="/styles.css"', `href="/${cssName}"`)
  .replace('src="/app.js"', `src="/${appName}"`)
  .replaceAll("/assets/trinetra-mark.webp", `/assets/${markName}`)
  .replaceAll("/assets/trinetra-mark-128.webp", `/assets/${iconName}`);

await Promise.all([
  writeFile(join(outputDir, appName), appBuffer),
  writeFile(join(outputDir, cssName), cssBuffer),
  writeFile(join(outputDir, "index.html"), outputHtml),
  writeFile(join(outputDir, "assets", markName), mark),
  writeFile(join(outputDir, "assets", iconName), icon)
]);

console.log(`Built frontend/${appName} and frontend/${cssName}`);

async function ensureWebp(webpName, pngFallbackName) {
  const webpPath = join(assetsDir, webpName);
  if (!existsSync(webpPath)) {
    await sharp(join(assetsDir, pngFallbackName)).webp({ quality: 82, effort: 6 }).toFile(webpPath);
  }
  return readFile(webpPath);
}

function contentHash(content) {
  return createHash("sha256").update(content).digest("hex").slice(0, 10);
}
