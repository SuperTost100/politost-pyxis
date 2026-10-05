// Reproduces how the core runs the extract worker, to find what kills it on Windows (exit 3221225477, 0xC0000005).
// The core is an Electron utility process that has already imported pdf.js (so @napi-rs/canvas is loaded on its thread),
// then starts a one-shot extract worker per import and terminates it as soon as the answer arrives (worker-client.ts).
//
//   node_modules/.bin/electron scripts/repro-extract-lifecycle.mjs [--parent=pdfjs|none] [--mode=pixels|full] [--runs=20]
//   ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron scripts/repro-extract-lifecycle.mjs ...   (plain Node mode, no utility process)
//
// Needs `npm run build` (out/main/extract-worker.js) and, for --mode=full, the staged files in .tmp/tessdata-fast.
// Each step is written synchronously BEFORE it runs, so the last line printed names the step that was running at the crash.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { createHash } from "node:crypto";

const args = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => a.slice(2).split("=")));
const parentMode = args.parent ?? "pdfjs";
const mode = args.mode ?? "pixels";
const runs = Number(args.runs ?? 20);
const root = process.cwd();
const log = (line) => writeSync(1, `${new Date().toISOString()} [${process.type ?? "node"}] ${line}\n`);

// Native modules and DLLs the process holds right now. On Windows this is the loaded-module list.
const loaded = () =>
  process.report
    .getReport()
    .sharedObjects.filter((name) => /\.node$|canvas|onnx|sharp|heif|tesseract|sqlite|vec0/i.test(name))
    .map((name) => name.replace(root, "."));

async function work() {
  log(`electron ${process.versions.electron ?? "-"} node ${process.versions.node} ${process.platform}-${process.arch}`);
  if (parentMode !== "none") {
    // What `core.js` does through `sources/documents.ts`: the import itself loads @napi-rs/canvas.
    log("parent: import pdfjs-dist/legacy/build/pdf.mjs");
    await import(pathToFileURL(join(root, "node_modules/pdfjs-dist/legacy/build/pdf.mjs")).href);
  }
  let database;
  if (parentMode === "core") {
    const { default: Database } = await import("better-sqlite3");
    const { load } = await import("sqlite-vec");
    database = new Database(":memory:");
    load(database);
  }
  log(`parent native modules: ${JSON.stringify(loaded())}`);
  const tess = mkdtempSync(join(tmpdir(), "pyxis-repro-"));
  if (mode === "full") {
    const staged = join(root, ".tmp", "tessdata-fast");
    if (!existsSync(staged)) throw new Error("run `npm run test:fixtures` first: .tmp/tessdata-fast is missing");
    // ocrDataDir() in src/core/sources/ocr-data.ts: the folder of the pinned revision.
    const revision = /OCR_DATA_REVISION = "([0-9a-f]+)"/.exec(readFileSync(join(root, "src/core/sources/ocr-data.ts"), "utf8"))[1];
    const dir = join(tess, `tessdata_fast-${revision.slice(0, 12)}`);
    mkdirSync(dir, { recursive: true });
    for (const code of ["eng", "ita"]) cpSync(join(staged, `${code}.traineddata`), join(dir, `${code}.traineddata`));
  }
  try {
    for (let run = 1; run <= runs; run += 1) {
      const scratch = join(tess, "scratch", `run-${run}`);
      if (args["hash-between-runs"] === "true") {
        log(`run ${run}: hash pinned OCR data before preview`);
        for (const code of ["eng", "ita"]) createHash("sha256").update(readFileSync(join(root, ".tmp/tessdata-fast", `${code}.traineddata`))).digest("hex");
      }
      log(`run ${run}/${runs}: spawn extract-worker (${mode})`);
      const reply = await new Promise((resolveRun, reject) => {
        const worker = new Worker(join(root, "out/main/extract-worker.js"), {
          workerData: {
            path: join(root, "tests/fixtures/synthetic-note.heic"),
            ext: ".heic",
            tess,
            scratch,
            ...(["pixels", "quality"].includes(mode) ? { mode } : {}),
          },
          resourceLimits: { maxOldGenerationSizeMb: 2048, maxYoungGenerationSizeMb: 64 },
        });
        worker.once("message", (message) => {
          log(`run ${run}: answer, terminate now`);
          void worker.terminate();
          resolveRun(message);
        });
        worker.once("error", reject);
        worker.once("exit", (code) => code && reject(new Error(`worker exit ${code}`)));
      });
      log(`run ${run}: ${reply.error ? `error ${reply.error}` : "ok"}; native modules: ${loaded().length}`);
      rmSync(scratch, { recursive: true, force: true });
    }
    log(`done: ${runs} runs, no crash`);
  } finally {
    database?.close();
    rmSync(tess, { recursive: true, force: true });
  }
}

if (process.type === "utility" || !process.versions.electron || process.env.ELECTRON_RUN_AS_NODE) {
  await work().catch((error) => {
    log(`failed: ${error?.stack ?? error}`);
    process.exitCode = 1;
  });
  if (process.type === "utility") process.exit(process.exitCode ?? 0);
} else {
  // Main process: fork this same file as the utility process, the way `startCore` forks core.js.
  // No top-level await here: Electron holds `ready` back until an ES-module entry has finished evaluating.
  import("electron").then(({ app, utilityProcess, crashReporter }) => {
    if (process.env.PYXIS_CRASH_DIR) {
      mkdirSync(process.env.PYXIS_CRASH_DIR, { recursive: true });
      app.setPath("crashDumps", process.env.PYXIS_CRASH_DIR);
      crashReporter.start({ uploadToServer: false });
    }
    app.setActivationPolicy?.("prohibited");
    app.dock?.hide();
    void app.whenReady().then(() => {
      const child = utilityProcess.fork(fileURLToPath(import.meta.url), process.argv.slice(2), { serviceName: "pyxis-repro", stdio: "inherit" });
      child.once("exit", (code) => {
        log(`utility process exited ${code} (0x${(code >>> 0).toString(16)})`);
        app.exit(code === 0 ? 0 : 1);
      });
    });
  });
}
