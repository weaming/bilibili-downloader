import { mkdir, readdir, rm, copyFile } from "node:fs/promises";
import { join, dirname, basename } from "node:path";

const projectRoot = dirname(import.meta.dir);
const sourceRoot = join(projectRoot, "src");
const outputRoot = join(projectRoot, "dist");

async function copyDirectory(sourcePath: string, outputPath: string): Promise<void> {
  await mkdir(outputPath, { recursive: true });
  const entries = await readdir(sourcePath, { withFileTypes: true });
  for (const entry of entries) {
    const sourceEntry = join(sourcePath, entry.name);
    const outputEntry = join(outputPath, entry.name);
    if (entry.isDirectory()) {
      await copyDirectory(sourceEntry, outputEntry);
      continue;
    }
    await copyFile(sourceEntry, outputEntry);
  }
}

async function buildBundle(
  entrypoint: string,
  outputFile: string,
  format: "iife" | "esm" = "iife",
  define?: Record<string, string>
): Promise<void> {
  const outputPath = join(outputRoot, outputFile);
  const result = await Bun.build({
    entrypoints: [entrypoint],
    outfile: outputPath,
    target: "browser",
    format,
    define,
    minify: false,
    sourcemap: "none"
  });

  if (!result.success) {
    throw new AggregateError(result.logs, `构建 ${entrypoint} 失败`);
  }

  const [output] = result.outputs;
  if (!output) {
    throw new Error(`构建 ${entrypoint} 未生成产物`);
  }
  await mkdir(dirname(outputPath), { recursive: true });
  await Bun.write(outputPath, output);
}

async function buildSource(entrypoint: string, outputFile: string): Promise<void> {
  await buildBundle(join(sourceRoot, entrypoint), outputFile);
}

await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });
await mkdir(join(outputRoot, "ffmpeg"), { recursive: true });

await Promise.all([
  buildSource("background/service-worker.ts", "service_worker.js"),
  buildSource("content/bridge.ts", "content_bridge.js"),
  buildSource("content/main.ts", "content_merge.js"),
  buildSource("popup/main.ts", "popup.js"),
  buildBundle(
    join(sourceRoot, "ffmpeg/runtime.ts"),
    "ffmpeg/ffmpeg.js",
    "iife",
    { "import.meta.url": JSON.stringify("chrome-extension://placeholder/ffmpeg/ffmpeg.js") }
  ),
  buildBundle(
    join(projectRoot, "node_modules/@ffmpeg/ffmpeg/dist/esm/worker.js"),
    "ffmpeg/ffmpeg.worker.js",
    "esm"
  )
]);

await Promise.all([
  copyFile(join(sourceRoot, "manifest.json"), join(outputRoot, "manifest.json")),
  copyFile(join(sourceRoot, "rules.json"), join(outputRoot, "rules.json")),
  copyFile(join(sourceRoot, "popup.html"), join(outputRoot, "popup.html")),
  copyFile(
    join(projectRoot, "node_modules/@ffmpeg/core/dist/esm/ffmpeg-core.js"),
    join(outputRoot, "ffmpeg/ffmpeg-core.js")
  ),
  copyFile(
    join(projectRoot, "node_modules/@ffmpeg/core/dist/umd/ffmpeg-core.wasm"),
    join(outputRoot, "ffmpeg/ffmpeg-core.wasm")
  ),
  copyDirectory(join(projectRoot, "public/icons"), join(outputRoot, "icons"))
]);

console.log(`构建完成: ${basename(outputRoot)}`);
