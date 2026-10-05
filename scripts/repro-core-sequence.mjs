// Replays what the core does between "Download" and "Add the file again" in tests/e2e/ocr-data.spec.ts, in one utility process:
//   parent: pdf.js (loads @napi-rs/canvas), better-sqlite3 + sqlite-vec on a file database, as core.js does
//   preview worker (HEIC, quality)  ->  download of the OCR data (fetch from a local server, sha-256, temp file, fsync, rename)
//   preview worker (HEIC, quality)  ->  the instant its answer arrives, the core thread hashes the OCR data, writes the blob
//                                       (open wx, fsync, rename) and commits a row, as `sources.import` does, while the worker is still stopping
//   import worker (HEIC, OCR)       ->  stopped the same way
//
//   node_modules/.bin/electron scripts/repro-core-sequence.mjs [--runs=10] [--await-stop=false|true] [--gap-ms=0] [--parent=core|none] [--preview-mode=quality|hash]
//
// --await-stop=true makes the core wait for `worker.terminate()` to finish before it uses the answer. It is the one
// difference between the two arms; production `oneShot` (worker-client.ts) is --await-stop=false. Needs `npm run build`
// and `.tmp/tessdata-fast` (`npm run test:fixtures`). Each step is written synchronously BEFORE it runs.
import { cpSync, existsSync, fsyncSync, mkdirSync, mkdtempSync, openSync, closeSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { createHash, randomUUID } from "node:crypto";

const args = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => a.slice(2).split("=")));
const runs = Number(args.runs ?? 10);
const awaitStop = args["await-stop"] === "true";
const gap = Number(args["gap-ms"] ?? 0);
const root = process.cwd();
const log = (line) => writeSync(1, `${new Date().toISOString()} [${process.type ?? "node"}] ${line}\n`);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function runWorker(label, data) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(join(root, "out/main/extract-worker.js"), {
      workerData: data,
      resourceLimits: { maxOldGenerationSizeMb: 2048, maxYoungGenerationSizeMb: 64 },
    });
    let done = false;
    worker.once("message", (message) => {
      if (done) return;
      done = true;
      log(`${label}: answer, terminate${awaitStop ? " and wait" : ""}`);
      const stopped = worker.terminate().then(() => log(`${label}: stopped`));
      if (awaitStop) void stopped.then(() => resolve(message));
      else resolve(message);
    });
    worker.once("error", reject);
    worker.once("exit", (code) => { if (!done && code) reject(new Error(`worker exit ${code}`)); });
  });
}

async function work() {
  log(`electron ${process.versions.electron ?? "-"} node ${process.versions.node} ${process.platform}-${process.arch} await-stop=${awaitStop} gap-ms=${gap}`);
  log("parent: import pdfjs-dist/legacy/build/pdf.mjs");
  await import(pathToFileURL(join(root, "node_modules/pdfjs-dist/legacy/build/pdf.mjs")).href);
  const work = mkdtempSync(join(tmpdir(), "pyxis-seq-"));
  let database;
  if (args.parent !== "none") {
    const { default: Database } = await import("better-sqlite3");
    const { load } = await import("sqlite-vec");
    database = new Database(join(work, "pyxis.db"));
    database.pragma("journal_mode = WAL");
    load(database);
    database.exec("create table sources (id integer primary key, sha text not null, name text not null, status text not null)");
  }
  const staged = join(root, ".tmp", "tessdata-fast");
  if (!existsSync(staged)) throw new Error("run `npm run test:fixtures` first: .tmp/tessdata-fast is missing");
  const files = new Map(["eng", "ita"].map((code) => [code, readFileSync(join(staged, `${code}.traineddata`))]));
  const server = createServer((request, response) => response.end(files.get(request.url.slice(1))));
  await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
  const base = `http://127.0.0.1:${server.address().port}`;
  const heic = join(root, "tests/fixtures/synthetic-note.heic");
  const heicBytes = readFileSync(heic);
  const revision = /OCR_DATA_REVISION = "([0-9a-f]+)"/.exec(readFileSync(join(root, "src/core/sources/ocr-data.ts"), "utf8"))[1];

  try {
    for (let run = 1; run <= runs; run += 1) {
      const tess = join(work, `tess-${run}`);
      const dir = join(tess, `tessdata_fast-${revision.slice(0, 12)}`);
      // --preview-mode=hash loads the whole worker bundle (pdf.js, canvas, wasm modules) and stops it without decoding anything.
      const quality = args["preview-mode"] === "hash" ? { path: heic, ext: ".heic", tess, mode: "hash", paths: [] } : { path: heic, ext: ".heic", tess, mode: "quality" };
      log(`run ${run}/${runs}: preview #1`);
      await runWorker(`run ${run} preview #1`, quality);

      log(`run ${run}: download`);
      mkdirSync(dir, { recursive: true });
      for (const code of files.keys()) {
        const bytes = Buffer.from(await (await fetch(`${base}/${code}`)).arrayBuffer());
        createHash("sha256").update(bytes).digest("hex");
        const temporary = join(dir, `.${code}.${randomUUID()}.tmp`);
        const fd = openSync(temporary, "wx", 0o600);
        writeFileSync(fd, bytes);
        fsyncSync(fd);
        closeSync(fd);
        renameSync(temporary, join(dir, `${code}.traineddata`));
      }
      if (gap) await sleep(gap);

      log(`run ${run}: preview #2`);
      const reply = await runWorker(`run ${run} preview #2`, quality);
      // Everything below runs on the core thread, straight after the answer, as `sources.import` does.
      log(`run ${run}: core work after preview #2 (${reply.error ?? "ok"})`);
      for (const code of files.keys()) createHash("sha256").update(readFileSync(join(dir, `${code}.traineddata`))).digest("hex");
      const sha = createHash("sha256").update(heicBytes).digest("hex");
      const blobDir = join(work, "blobs", sha.slice(0, 2));
      mkdirSync(blobDir, { recursive: true });
      const temporary = join(blobDir, `.${sha}.${randomUUID()}.tmp`);
      const fd = openSync(temporary, "wx", 0o600);
      writeFileSync(fd, heicBytes);
      fsyncSync(fd);
      closeSync(fd);
      renameSync(temporary, join(blobDir, sha));
      database?.transaction(() => database.prepare("insert into sources (sha, name, status) values (?, ?, ?)").run(sha, `run-${run}.heic`, "pending"))();

      log(`run ${run}: import worker (OCR)`);
      const scratch = join(tess, "scratch", randomUUID());
      const imported = await runWorker(`run ${run} import`, { path: heic, ext: ".heic", tess, scratch });
      rmSync(scratch, { recursive: true, force: true });
      log(`run ${run}: done (${imported.error ?? "ok"})`);
    }
    log(`done: ${runs} runs, no crash`);
  } finally {
    server.close();
    database?.close();
    rmSync(work, { recursive: true, force: true });
  }
}

if (process.type === "utility" || !process.versions.electron || process.env.ELECTRON_RUN_AS_NODE) {
  await work().catch((error) => {
    log(`failed: ${error?.stack ?? error}`);
    process.exitCode = 1;
  });
  if (process.type === "utility") process.exit(process.exitCode ?? 0);
} else {
  // Main process: fork this file as the utility process, the way `startCore` forks core.js.
  import("electron").then(({ app, utilityProcess, crashReporter }) => {
    if (process.env.PYXIS_CRASH_DIR) {
      mkdirSync(process.env.PYXIS_CRASH_DIR, { recursive: true });
      app.setPath("crashDumps", resolve(process.env.PYXIS_CRASH_DIR));
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
