import { build } from "esbuild";
import { copyFile, cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = resolve(rootDir, "dist");
const assetsDir = resolve(distDir, "assets");
const ortDistDir = resolve(assetsDir, "ort");
const ocrDistDir = resolve(assetsDir, "ocr");
const rootAssetsDir = resolve(rootDir, "assets");
const rootOrtDir = resolve(rootAssetsDir, "ort");
const rootOcrDir = resolve(rootAssetsDir, "ocr");

await mkdir(distDir, { recursive: true });
await mkdir(assetsDir, { recursive: true });
await mkdir(ortDistDir, { recursive: true });
await mkdir(ocrDistDir, { recursive: true });
await mkdir(rootAssetsDir, { recursive: true });
await mkdir(rootOrtDir, { recursive: true });
await mkdir(rootOcrDir, { recursive: true });

const indexHtml = await readFile(resolve(rootDir, "index.html"), "utf8");
await writeFile(resolve(distDir, "index.html"), indexHtml);

for (const file of ["style.css", "paypal.jpg"]) {
  await copyFile(resolve(rootDir, file), resolve(distDir, file));
}

await build({
  entryPoints: [resolve(rootDir, "script.js")],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2022",
  outfile: resolve(distDir, "app.js"),
  sourcemap: false,
  alias: {
    fs: resolve(rootDir, "scripts", "shims", "empty-module.js"),
    path: resolve(rootDir, "scripts", "shims", "empty-module.js"),
  },
});

await copyFile(resolve(distDir, "app.js"), resolve(rootDir, "app.js"));

for (const file of [
  "ch_PP-OCRv4_det_infer.onnx",
  "ch_PP-OCRv4_rec_infer.onnx",
  "ppocr_keys_v1.txt",
]) {
  const sourcePath = resolve(rootDir, "node_modules", "@gutenye", "ocr-models", "assets", file);
  await copyFile(
    sourcePath,
    resolve(ocrDistDir, file),
  );
  await copyFile(sourcePath, resolve(rootOcrDir, file));
}

await cp(resolve(rootDir, "node_modules", "onnxruntime-web", "dist"), ortDistDir, {
  recursive: true,
  force: true,
});
await cp(resolve(rootDir, "node_modules", "onnxruntime-web", "dist"), rootOrtDir, {
  recursive: true,
  force: true,
});
