import { systemPrompt, promptProvenance } from "../engine/prompts";
import { mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import jpeg from "jpeg-js";
import { PNG } from "pngjs";
import { afterEach, describe, expect, it } from "vitest";
import { readBlob } from "../blobs";
import { MAX_IMAGE_BYTES } from "../../shared/source-types";
import { normalizeForVision, VISION_MAX_BYTES } from "./vision-image";
import { openDatabase } from "../db/connection";
import { createRunner } from "../jobs/runner";
import { enqueueReextract, enqueueSourceFile, registerSourceJobs, visionSelection } from "./jobs";
import { sourceHandlers } from "./handlers";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

// A real 8x8 PNG: an image whose header does not read is refused before it is sent anywhere.
const png = PNG.sync.write(new PNG({ width: 8, height: 8 }));
const ocrText = "OCR text from the photo";
const ocr = async () => ({
  document: {
    pages: [{ text: ocrText, locator: { page: 1 }, section: "text" }],
    scanned: false,
  },
});

function setup(model: string | null) {
  const workspace = mkdtempSync(join(tmpdir(), "pyxis-vision-"));
  dirs.push(workspace);
  const db = openDatabase(":memory:");
  if (model)
    db.prepare(
      "INSERT INTO feature_engines (feature, selection_json, updated_at) VALUES ('vision', ?, 1)",
    ).run(JSON.stringify({ provider: "claude", model }));
  const runner = createRunner(db, () => {});
  const path = join(workspace, "note.png");
  writeFileSync(path, png);
  return { workspace, db, runner, path };
}
const extractor = (db: ReturnType<typeof openDatabase>, id: string) =>
  JSON.parse(
    (
      db
        .prepare("SELECT tree_json FROM source_documents WHERE source_id = ?")
        .get(id) as { tree_json: string }
    ).tree_json,
  ).extractor;
const passages = (db: ReturnType<typeof openDatabase>, id: string) =>
  db.prepare("SELECT text FROM passages WHERE source_id = ?").all(id);

describe("SRC-04 photos read through vision, then local OCR", () => {
  it("sends the pixels to the vision engine and records the model that read them", async () => {
    const { workspace, db, runner, path } = setup("claude-sonnet-4-6");
    const calls: Array<{
      selection: unknown;
      attachments: unknown;
      prompt: string;
      system?: string;
    }> = [];
    registerSourceJobs(db, workspace, runner, ocr, {
      run: async (input) => {
        calls.push(input as never);
        return {
          text: "  $v = \\Delta x / \\Delta t$ ",
          model: "claude-sonnet-4-6",
          provider: "claude",
          inputTokens: 1,
        };
      },
    });
    const result = await enqueueSourceFile(db, workspace, runner, path);
    await expect
      .poll(() =>
        db.prepare("SELECT state FROM jobs WHERE id = ?").get(result.jobId),
      )
      .toEqual({ state: "succeeded" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.selection).toMatchObject({
      provider: "claude",
      model: "claude-sonnet-4-6",
    });
    expect(calls[0]!.attachments).toEqual([
      { type: "image", mediaType: "image/png", data: png.toString("base64") },
    ]);
    expect(calls[0]!.system).toBe(systemPrompt("source.transcribe"));
    expect(passages(db, result.sourceId)).toEqual([
      { text: "$v = \\Delta x / \\Delta t$" },
    ]);
    expect(extractor(db, result.sourceId)).toEqual({
      path: "vision",
      prompt: promptProvenance("source.transcribe"),
      provider: "claude",
      model: "claude-sonnet-4-6",
      // The 8x8 stand-in is inside every limit, so it goes out as is: its size is recorded and no resize is.
      sent: { mediaType: "image/png", bytes: png.length, width: 8, height: 8 },
    });
    expect(
      sourceHandlers(db, workspace).meta({ sourceId: result.sourceId }),
    ).toMatchObject({
      extractor: { path: "vision", model: "claude-sonnet-4-6" },
    });
    expect(
      db
        .prepare("SELECT status FROM sources WHERE id = ?")
        .get(result.sourceId),
    ).toEqual({ status: "ready" });
    db.close();
  });

  it("uses a model slot for the vision call and a local slot for the rest", async () => {
    const { workspace, db, runner, path } = setup("claude-sonnet-4-6");
    registerSourceJobs(db, workspace, runner, ocr, {
      run: async () => ({
        text: "text",
        model: "m",
        provider: "claude",
        inputTokens: 1,
      }),
    });
    const result = await enqueueSourceFile(db, workspace, runner, path);
    expect(
      db.prepare("SELECT kind FROM jobs WHERE id = ?").get(result.jobId),
    ).toEqual({ kind: "source-import-vision" });
    await expect
      .poll(() =>
        db.prepare("SELECT state FROM jobs WHERE id = ?").get(result.jobId),
      )
      .toEqual({ state: "succeeded" });
    db.close();
  });

  it("reads locally when the vision model cannot see images or none is set", async () => {
    for (const model of ["text-only-small", null]) {
      const { workspace, db, runner, path } = setup(model);
      let called = false;
      registerSourceJobs(db, workspace, runner, ocr, {
        run: async () => {
          called = true;
          throw new Error("must not be called");
        },
      });
      expect(visionSelection(db, ".png")).toBeUndefined();
      const result = await enqueueSourceFile(db, workspace, runner, path);
      expect(
        db.prepare("SELECT kind FROM jobs WHERE id = ?").get(result.jobId),
      ).toEqual({ kind: "source-import" });
      await expect
        .poll(() =>
          db.prepare("SELECT state FROM jobs WHERE id = ?").get(result.jobId),
        )
        .toEqual({ state: "succeeded" });
      expect(called).toBe(false);
      expect(passages(db, result.sourceId)).toEqual([{ text: ocrText }]);
      db.close();
    }
  });

  it("never sends a document to the vision engine", () => {
    const { db } = setup("claude-sonnet-4-6");
    expect(visionSelection(db, ".pdf")).toBeUndefined();
    expect(visionSelection(db, ".txt")).toBeUndefined();
    expect(visionSelection(db, ".heic")).toMatchObject({
      model: "claude-sonnet-4-6",
    });
    db.close();
  });

  it("falls back to local OCR on an engine error and keeps that on the record", async () => {
    const { workspace, db, runner, path } = setup("claude-sonnet-4-6");
    registerSourceJobs(db, workspace, runner, ocr, {
      run: async () => {
        throw new Error("engine exploded");
      },
    });
    const result = await enqueueSourceFile(db, workspace, runner, path);
    await expect
      .poll(() =>
        db.prepare("SELECT state FROM jobs WHERE id = ?").get(result.jobId),
      )
      .toEqual({ state: "succeeded" });
    expect(passages(db, result.sourceId)).toEqual([{ text: ocrText }]);
    expect(extractor(db, result.sourceId)).toEqual({
      path: "ocr",
      after: "vision-failed",
    });
    db.close();
  });

  it("stops without reading locally when the user declines the provider disclosure", async () => {
    const { workspace, db, runner, path } = setup("claude-sonnet-4-6");
    let local = 0;
    registerSourceJobs(
      db,
      workspace,
      runner,
      async () => {
        local += 1;
        return ocr();
      },
      {
        run: async () => {
          throw new Error("engine-disclosure-cancelled");
        },
      },
    );
    const result = await enqueueSourceFile(db, workspace, runner, path);
    await expect
      .poll(
        () =>
          (
            db
              .prepare("SELECT state FROM jobs WHERE id = ?")
              .get(result.jobId) as { state: string }
          ).state,
      )
      .toBe("failed");
    expect(local).toBe(0);
    expect(passages(db, result.sourceId)).toEqual([]);
    db.close();
  });

  it("cancels the vision call and keeps no text", async () => {
    const { workspace, db, runner, path } = setup("claude-sonnet-4-6");
    let aborted = false;
    registerSourceJobs(db, workspace, runner, ocr, {
      run: (input) =>
        new Promise((_resolve, reject) => {
          input.signal?.addEventListener("abort", () => {
            aborted = true;
            reject(new DOMException("Cancelled", "AbortError"));
          });
          setTimeout(() => runner.cancel(result.jobId), 5);
        }),
    });
    const result = await enqueueSourceFile(db, workspace, runner, path);
    await expect
      .poll(
        () =>
          (
            db
              .prepare("SELECT state FROM jobs WHERE id = ?")
              .get(result.jobId) as { state: string }
          ).state,
      )
      .toBe("cancelled");
    expect(aborted).toBe(true);
    expect(passages(db, result.sourceId)).toEqual([]);
    db.close();
  });

  it("a retry picks the vision engine again, so a model that lost vision reads locally", async () => {
    const { workspace, db, runner, path } = setup("claude-sonnet-4-6");
    let attempts = 0;
    registerSourceJobs(db, workspace, runner, ocr, {
      run: async () => {
        attempts += 1;
        throw new Error("engine-disclosure-timeout");
      },
    });
    const result = await enqueueSourceFile(db, workspace, runner, path);
    await expect
      .poll(
        () =>
          (
            db
              .prepare("SELECT state FROM jobs WHERE id = ?")
              .get(result.jobId) as { state: string }
          ).state,
      )
      .toBe("failed");
    db.prepare(
      "UPDATE feature_engines SET selection_json = ? WHERE feature = 'vision'",
    ).run(JSON.stringify({ provider: "claude", model: "text-only-small" }));
    runner.retry(result.jobId);
    await expect
      .poll(
        () =>
          (
            db
              .prepare("SELECT state FROM jobs WHERE id = ?")
              .get(result.jobId) as { state: string }
          ).state,
      )
      .toBe("succeeded");
    expect(attempts).toBe(1);
    expect(passages(db, result.sourceId)).toEqual([{ text: ocrText }]);
    expect(extractor(db, result.sourceId)).toEqual({ path: "ocr" });
    db.close();
  });

  it("sends a HEIC original as decoded PNG pixels and keeps the original", async () => {
    const { workspace, db, runner } = setup("claude-sonnet-4-6");
    const original = readFileSync("tests/fixtures/synthetic-note.heic");
    const path = join(workspace, "note.heic");
    writeFileSync(path, original);
    let media = "";
    registerSourceJobs(db, workspace, runner, ocr, {
      vision: async () => ({ mediaType: "image/png" as const, bytes: png }),
      run: async (input) => {
        media = String(input.attachments?.[0]?.mediaType);
        return {
          text: "heic words",
          model: "m",
          provider: "claude",
          inputTokens: 1,
        };
      },
    });
    const result = await enqueueSourceFile(db, workspace, runner, path);
    await expect
      .poll(() =>
        db.prepare("SELECT state FROM jobs WHERE id = ?").get(result.jobId),
      )
      .toEqual({ state: "succeeded" });
    expect(media).toBe("image/png");
    expect(
      db.prepare("SELECT mime FROM sources WHERE id = ?").get(result.sourceId),
    ).toEqual({ mime: "image/heic" });
    expect(passages(db, result.sourceId)).toEqual([{ text: "heic words" }]);
    db.close();
  });
});

describe("SRC-04 vision import fits the image to provider limits", () => {
  function busyJpeg(): Uint8Array {
    const width = 3000;
    const height = 2000;
    const data = Buffer.alloc(width * height * 4);
    let seed = 5;
    for (let at = 0; at < data.length; at += 4) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      data.fill(seed % 256, at, at + 3);
      data[at + 3] = 255;
    }
    return new Uint8Array(jpeg.encode({ data, width, height }, 90).data);
  }
  const fit = async (file: string) => normalizeForVision(new Uint8Array(readFileSync(file)));
  const succeeded = (db: ReturnType<typeof openDatabase>, jobId: string) =>
    expect.poll(() => db.prepare("SELECT state FROM jobs WHERE id = ?").get(jobId)).toEqual({ state: "succeeded" });

  it("sends a resized copy, keeps the stored original, and records what was sent", async () => {
    const { workspace, db, runner } = setup("claude-sonnet-4-6");
    const original = busyJpeg();
    const path = join(workspace, "phone.jpg");
    writeFileSync(path, original);
    const sent: Array<{ mediaType: string; data: string }> = [];
    registerSourceJobs(db, workspace, runner, ocr, {
      vision: fit,
      run: async (input) => {
        sent.push(...(input.attachments as never[]));
        return { text: "page text", model: "claude-sonnet-4-6", provider: "claude", inputTokens: 1 };
      },
    });
    const result = await enqueueSourceFile(db, workspace, runner, path);
    await succeeded(db, result.jobId);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.mediaType).toBe("image/jpeg");
    expect(Buffer.from(sent[0]!.data, "base64").length).toBeLessThanOrEqual(VISION_MAX_BYTES);
    const stored = db.prepare("SELECT blob_sha FROM sources WHERE id = ?").get(result.sourceId) as { blob_sha: string };
    expect(readFileSync(readBlob(workspace, stored.blob_sha).file)).toEqual(Buffer.from(original));
    expect(extractor(db, result.sourceId)).toMatchObject({
      path: "vision",
      sent: { mediaType: "image/jpeg", resizedFrom: { width: 3000, height: 2000, bytes: original.length } },
    });
    expect(sourceHandlers(db, workspace).meta({ sourceId: result.sourceId })).toMatchObject({
      extractor: { sent: { resizedFrom: { width: 3000, height: 2000 } } },
    });
    db.close();
  }, 60_000);

  it("reads a stored photo again through vision as a new version of the same source, and records the rotation", async () => {
    const { workspace, db, runner } = setup("claude-sonnet-4-6");
    // A small portrait phone photo: 20 KB, stored sideways with EXIF orientation 6.
    const width = 300;
    const height = 200;
    const data = Buffer.alloc(width * height * 4, 180);
    const plain = jpeg.encode({ data, width, height }, 70).data;
    const exif = Buffer.concat([
      Buffer.from("Exif\0\0", "binary"),
      Buffer.from([0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8]),
      Buffer.from([0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0, 0, 0, 0, 0]),
    ]);
    const original = Buffer.concat([plain.subarray(0, 2), Buffer.from([0xff, 0xe1, 0, exif.length + 2]), exif, plain.subarray(2)]);
    const path = join(workspace, "portrait.jpg");
    writeFileSync(path, original);
    let reads = 0;
    registerSourceJobs(db, workspace, runner, ocr, {
      vision: fit,
      run: async () => {
        reads += 1;
        return { text: `reading ${reads}`, model: "claude-sonnet-4-6", provider: "claude", inputTokens: 1 };
      },
    });
    const first = await enqueueSourceFile(db, workspace, runner, path);
    await succeeded(db, first.jobId);
    const before = db.prepare("SELECT blob_sha, kind, title FROM sources WHERE id = ?").get(first.sourceId);
    const again = enqueueReextract(db, workspace, runner, first.sourceId, false);
    expect(again).toMatchObject({ started: true, inUse: 0 });
    await succeeded(db, again.jobId!);
    expect(reads).toBe(2);
    // Same source, same stored original, a second version.
    expect(db.prepare("SELECT blob_sha, kind, title FROM sources WHERE id = ?").get(first.sourceId)).toEqual(before);
    const trees = db.prepare("SELECT version, tree_json FROM source_documents WHERE source_id = ? ORDER BY version").all(first.sourceId) as Array<{ version: number; tree_json: string }>;
    expect(trees.map((tree) => tree.version)).toEqual([1, 2]);
    const second = JSON.parse(trees[1]!.tree_json) as { blobSha: string; kind: string; extractor: { path: string; sent: { width: number; height: number; orientation: number; resizedFrom: { width: number; height: number } } } };
    expect(second).toMatchObject({ kind: "image", extractor: { path: "vision" } });
    // The stored file is untouched, and the copy the model saw was turned upright.
    expect(readFileSync(readBlob(workspace, second.blobSha).file)).toEqual(original);
    expect(second.extractor.sent).toMatchObject({ width: 200, height: 300, orientation: 6, resizedFrom: { width: 200, height: 300 } });
    expect(passages(db, first.sourceId)).toEqual([{ text: "reading 1" }, { text: "reading 2" }]);
    expect(sourceHandlers(db, workspace).meta({ sourceId: first.sourceId })).toMatchObject({
      extractor: { sent: { orientation: 6 } },
    });
    db.close();
  });

  it("reads locally and says why when the image cannot be fitted", async () => {
    for (const [message, after] of [
      ["vision-image-too-large", "vision-too-large"],
      ["vision-image-unsupported", "vision-failed"],
    ] as const) {
      const { workspace, db, runner, path } = setup("claude-sonnet-4-6");
      let called = false;
      registerSourceJobs(db, workspace, runner, ocr, {
        vision: async () => {
          throw new Error(message);
        },
        run: async () => {
          called = true;
          throw new Error("must not be called");
        },
      });
      const result = await enqueueSourceFile(db, workspace, runner, path);
      await succeeded(db, result.jobId);
      expect(called).toBe(false);
      expect(extractor(db, result.sourceId)).toEqual({ path: "ocr", after });
      db.close();
    }
  });

  it("refuses a file over the size cap before reading it", async () => {
    const { workspace, db, runner } = setup(null);
    const path = join(workspace, "huge.png");
    writeFileSync(path, "");
    truncateSync(path, MAX_IMAGE_BYTES + 1);
    await expect(enqueueSourceFile(db, workspace, runner, path)).rejects.toThrow("source-too-big");
    expect(db.prepare("SELECT COUNT(*) AS n FROM sources").get()).toEqual({ n: 0 });
    db.close();
  });
});
