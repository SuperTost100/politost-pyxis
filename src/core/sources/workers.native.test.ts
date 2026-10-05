import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import jpeg from "jpeg-js";
import { PNG } from "pngjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { embeddingReady, embedTexts } from "./embed";
import { ocrDataDir } from "./ocr-data";
import { hashFiles } from "./quality";
import { loadVisionImage, VISION_MAX_BYTES, VISION_MAX_EDGE } from "./vision-image";
import { closeSourceWorkers, ocrBytes, runSourceWorker, setSourceWorkerDirectory } from "./worker-client";

// These start the built workers, so they need `npx electron-vite build` first and report a skip without it.
// Real embedding inference also needs the pinned model, from PYXIS_E5_DIR or .tmp/e5.
const built = resolve(process.env.PYXIS_WORKER_DIR ?? "out/main");
const have = existsSync(join(built, "extract-worker.js")) && existsSync(join(built, "embed-worker.js"));
const model = resolve(process.env.PYXIS_E5_DIR ?? ".tmp/e5");

let dir = "";
beforeAll(() => {
  setSourceWorkerDirectory(built);
  dir = mkdtempSync(join(tmpdir(), "pyxis-native-workers-"));
});
afterAll(() => {
  closeSourceWorkers();
  rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!have)("built extract worker", () => {
  it("hashes files by streaming and gives null to one it cannot read", async () => {
    const file = join(dir, "a.txt");
    writeFileSync(file, "alpha");
    const hashes = await runSourceWorker<Array<string | null>>("extract-worker", { mode: "hash", paths: [file, join(dir, "gone.txt")], maxBytes: 1000 });
    expect(hashes).toEqual([...(await hashFiles([file], 1000)), null]);
  });

  it("fits a phone-size photo in the worker and refuses a file over its size cap", async () => {
    const width = 3000;
    const height = 2000;
    const data = Buffer.alloc(width * height * 4, 255);
    let seed = 11;
    for (let at = 0; at < data.length; at += 4) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      data.fill(seed % 256, at, at + 3);
    }
    const file = join(dir, "phone.jpg");
    writeFileSync(file, jpeg.encode({ data, width, height }, 90).data);
    const image = await loadVisionImage(file, ".jpg");
    expect(image.mediaType).toBe("image/jpeg");
    expect(image.bytes.length).toBeLessThanOrEqual(VISION_MAX_BYTES);
    expect(Math.max(image.width!, image.height!)).toBeLessThanOrEqual(VISION_MAX_EDGE);
    expect(image.resizedFrom).toMatchObject({ width, height });
    const quality = await runSourceWorker<{ sha: string; variance: number | null }>("extract-worker", { path: file, ext: ".jpg", mode: "quality", maxBytes: 1000 }).catch((error: Error) => error);
    expect((quality as Error).message).toBe("source-too-big");
    const measured = await runSourceWorker<{ sha: string; variance: number | null }>("extract-worker", { path: file, ext: ".jpg", mode: "quality", maxBytes: 1 << 30 });
    expect(measured.sha).toMatch(/^[a-f0-9]{64}$/);
    expect(measured.variance).toBeGreaterThan(40);
  }, 60_000);
});

describe.skipIf(!have)("built extract worker, local OCR", () => {
  it("refuses a picture that declares a huge size before the recognizer decodes it, and honours a cancel", async () => {
    const bomb = new Uint8Array(PNG.sync.write(new PNG({ width: 1, height: 1 })));
    new DataView(bomb.buffer).setUint32(16, 20_000);
    new DataView(bomb.buffer).setUint32(20, 20_000);
    await expect(ocrBytes(bomb, join(dir, "tess"))).rejects.toThrow("vision-image-too-large");
    const controller = new AbortController();
    const pending = ocrBytes(bomb, join(dir, "tess"), controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  }, 60_000);
});

// The pinned language files, from the git-ignored dev download (see ocr-data.test.ts).
const tessdata = resolve(process.env.PYXIS_TEST_TESSDATA ?? ".tmp/tessdata-fast");
const haveTessdata = existsSync(join(tessdata, "eng.traineddata")) && existsSync(join(tessdata, "ita.traineddata"));

// A build from before the OCR data check would fetch language data from the network here, so it is not run at all.
const chunkDir = join(built, "chunks");
const haveOcrData =
  have && existsSync(chunkDir) && readdirSync(chunkDir).some((name) => readFileSync(join(chunkDir, name), "utf8").includes("ocr-data-integrity"));

describe.skipIf(!haveOcrData)("built extract worker, OCR language data", () => {
  const word = () => {
    // "HI" in block letters: enough pixels for the recognizer, small enough to be quick.
    const png = new PNG({ width: 220, height: 120 });
    png.data.fill(255);
    const ink = (x: number, y: number, w: number, h: number) => {
      for (let dy = 0; dy < h; dy += 1)
        for (let dx = 0; dx < w; dx += 1) {
          const at = ((y + dy) * 220 + x + dx) * 4;
          png.data[at] = png.data[at + 1] = png.data[at + 2] = 0;
        }
    };
    ink(30, 20, 14, 80); ink(94, 20, 14, 80); ink(30, 52, 78, 14); // H
    ink(140, 20, 14, 80); // I
    return new Uint8Array(PNG.sync.write(png));
  };

  it("fails by name when the data is not downloaded, and never reaches for the network", async () => {
    await expect(ocrBytes(word(), join(dir, "no-data"))).rejects.toThrow("ocr-data-missing");
  }, 60_000);

  // A build from before the scratch folder is owned by the parent would leave a copy of the language files behind.
  const haveScratch = readFileSync(join(built, "extract-worker.js"), "utf8").includes(".scratch");
  it.skipIf(!haveTessdata || !haveScratch)("leaves no copy of the language files behind when a run is cancelled or times out, in the workspace or the OS temp folder", async () => {
    const tess = join(dir, "scratch-data");
    mkdirSync(ocrDataDir(tess), { recursive: true });
    for (const lang of ["eng", "ita"]) copyFileSync(join(tessdata, `${lang}.traineddata`), join(ocrDataDir(tess), `${lang}.traineddata`));
    const root = join(tess, "scratch");
    const osLeftovers = () => readdirSync(tmpdir()).filter((name) => name.startsWith("pyxis-tessdata-")).sort();
    const before = osLeftovers();
    const left = () => (existsSync(root) ? readdirSync(root) : []);
    // A big page of noise keeps the recognizer busy long enough to stop it mid-run.
    const page = new PNG({ width: 2400, height: 3200 });
    let seed = 7;
    for (let at = 0; at < page.data.length; at += 4) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      page.data.fill(seed & 0x400 ? 0 : 255, at, at + 3);
      page.data[at + 3] = 255;
    }
    const pixels = new Uint8Array(PNG.sync.write(page));

    const controller = new AbortController();
    const cancelled = ocrBytes(pixels, tess, controller.signal);
    // The files are in the scratch folder once the run is under way.
    await expect.poll(() => left().length, { timeout: 30_000 }).toBe(1);
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    await expect.poll(left, { timeout: 10_000 }).toEqual([]);

    // The same for a run that hits its time limit.
    const limited = ocrBytes(pixels, tess, AbortSignal.timeout(1500));
    await expect(limited).rejects.toBeTruthy();
    await expect.poll(left, { timeout: 10_000 }).toEqual([]);

    // And a run that finishes.
    expect(await ocrBytes(word(), tess)).toMatch(/H/i);
    expect(left()).toEqual([]);
    expect(osLeftovers()).toEqual(before);
  }, 120_000);

  const haveScratchGuard = readFileSync(join(built, "extract-worker.js"), "utf8").includes("createOcrScratch");
  it.skipIf(!haveTessdata || !haveScratchGuard)("refuses a symlinked scratch root, writing nothing outside the workspace and deleting nothing there", async () => {
    const tess = join(dir, "linked-scratch");
    mkdirSync(ocrDataDir(tess), { recursive: true });
    for (const lang of ["eng", "ita"]) copyFileSync(join(tessdata, `${lang}.traineddata`), join(ocrDataDir(tess), `${lang}.traineddata`));
    const outside = join(dir, "linked-scratch-outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "mine.txt"), "mine");
    symlinkSync(outside, join(tess, "scratch"), "dir");
    await expect(ocrBytes(word(), tess)).rejects.toThrow("ocr-scratch-unsafe");
    expect(readdirSync(outside)).toEqual(["mine.txt"]);
  }, 60_000);

  it.skipIf(!haveTessdata)("reads with the verified data in the worker and refuses it once altered", async () => {
    const tess = join(dir, "with-data");
    mkdirSync(ocrDataDir(tess), { recursive: true });
    for (const lang of ["eng", "ita"]) copyFileSync(join(tessdata, `${lang}.traineddata`), join(ocrDataDir(tess), `${lang}.traineddata`));
    expect(await ocrBytes(word(), tess)).toMatch(/H/i);
    writeFileSync(join(ocrDataDir(tess), "ita.traineddata"), "altered");
    await expect(ocrBytes(word(), tess)).rejects.toThrow("ocr-data-integrity");
  }, 120_000);
});

describe.skipIf(!have || !embeddingReady(model))("built embed worker", () => {
  it("loads the model once for repeated calls and gives a call made during another its own worker", async () => {
    const first = performance.now();
    const [one] = await embedTexts(model, ["query: derivata di x^2"]);
    const cold = performance.now() - first;
    expect(one).toHaveLength(384);
    const second = performance.now();
    const [again] = await embedTexts(model, ["query: derivata di x^2"]);
    const warm = performance.now() - second;
    expect(Array.from(again!)).toEqual(Array.from(one!));
    // Not a benchmark: a reload of the model per call would cost about as much as the cold start.
    expect(warm).toBeLessThan(cold / 2);
    const [a, b] = await Promise.all([
      embedTexts(model, ["passage: primo"]),
      embedTexts(model, ["passage: secondo"]),
    ]);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    const controller = new AbortController();
    const cancelled = embedTexts(model, ["passage: lungo"], controller.signal);
    const expectation = expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await expectation;
    expect(await embedTexts(model, ["passage: dopo"])).toHaveLength(1);
    // Once every embed worker has exited, a new one must still load the addon. Node forgets an addon when the last
    // thread that loaded it closes, but glibc and macOS keep onnxruntime_binding.node mapped, so without the pin in
    // worker-client.ts this fails with "Module did not self-register".
    closeSourceWorkers();
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(await embedTexts(model, ["passage: ancora"])).toHaveLength(1);
  }, 120_000);
});
