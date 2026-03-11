import { copyFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = resolve(rootDir, "dist");

await mkdir(distDir, { recursive: true });

for (const file of ["index.html", "style.css", "script.js"]) {
  await copyFile(resolve(rootDir, file), resolve(distDir, file));
}
