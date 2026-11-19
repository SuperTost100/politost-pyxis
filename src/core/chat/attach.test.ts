import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import jpeg from "jpeg-js";
import { PNG } from "pngjs";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import { putBlob, readBlob } from "../blobs";
import { heicToPng } from "../sources/heic";
import { normalizeForVision, VISION_MAX_BYTES } from "../sources/vision-image";
import { commitStaged, ORIGINAL_SUFFIX, recognisePhoto, savedImages, stagePhoto } from "./attach";
import { heldFilesFor } from "./test-attach";

/** Attaches one photo with the given fitting, as the composer does, and takes it as a turn does. */
async function heldPhoto(
  db: ReturnType<typeof openDatabase>,
  workspace: string,
  path: string,
  fit: NonNullable<Parameters<typeof heldFilesFor>[2]>["fit"],
) {
  const { attach } = heldFilesFor(db, workspace, { fit });
  return (await attach(path)).take().photos[0]!;
}

it("SRC-04 sends HEIC pixels to vision or OCR and preserves the original", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "pyxis-heic-chat-"));
  const db = openDatabase(":memory:");
  try {
    const path = "tests/fixtures/synthetic-note.heic";
    const decode = async (file: string) => (await heicToPng(new Uint8Array(readFileSync(file)))).png;
    const load = async (file: string) => ({ mediaType: "image/png" as const, bytes: await decode(file) });
    const photo = await heldPhoto(db, workspace, path, load);
    const vision = await stagePhoto(photo, true, undefined, decode);
    expect(vision.image.mediaType).toBe("image/png");
    expect(PNG.sync.read(Buffer.from(vision.image.data, "base64")).width).toBe(64);
    const original = vision.image.original!;
    expect(original.mime).toBe("image/heic");
    expect(readFileSync(readBlob(workspace, original.sha).file)).toEqual(readFileSync(path));
    // A model that cannot read the photo gets nothing of it. Local OCR reads the decoded pixels.
    let width = 0;
    const ocr = await stagePhoto(photo, false, undefined, decode);
    const text = await recognisePhoto(
      photo,
      workspace,
      async (bytes) => {
        width = PNG.sync.read(Buffer.from(bytes)).width;
        return "Local note text";
      },
      undefined,
      decode,
    );
    expect(width).toBe(64);
    expect(text).toBe("Local note text");
    expect(ocr.image.data).toBe("");
  } finally { db.close(); rmSync(workspace, { recursive: true, force: true }); }
});

describe("SRC-04 chat images fit provider limits", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const fit = async (file: string) => normalizeForVision(new Uint8Array(readFileSync(file)));

  /**
   * A busy 3000x2000 JPEG, above the 1.5 MB budget. Encoding and decoding six megapixels of noise in JavaScript takes
   * about 12 s locally and 75-85 s on a hosted macOS x64 runner, so the cases that use it allow 180 s.
   */
  function bigPhoto(dir: string): { path: string; bytes: Uint8Array } {
    const width = 3000;
    const height = 2000;
    const data = Buffer.alloc(width * height * 4);
    let seed = 3;
    for (let at = 0; at < data.length; at += 4) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      data.fill(seed % 256, at, at + 3);
      data[at + 3] = 255;
    }
    const bytes = new Uint8Array(jpeg.encode({ data, width, height }, 90).data);
    const path = join(dir, "page.jpg");
    writeFileSync(path, bytes);
    return { path, bytes };
  }

  function setup() {
    const workspace = mkdtempSync(join(tmpdir(), "pyxis-chat-image-"));
    dirs.push(workspace);
    const db = openDatabase(":memory:");
    db.prepare("INSERT INTO chats (id, title, created_at, updated_at) VALUES ('c', 't', 1, 1)").run();
    db.prepare("INSERT INTO messages (id, chat_id, role, body, created_at) VALUES ('m', 'c', 'user', 'q', 1)").run();
    return { workspace, db };
  }

  it("sends a resized copy, keeps the original, and resends only the copy", async () => {
    const { workspace, db } = setup();
    try {
      const { path, bytes } = bigPhoto(workspace);
      expect(bytes.length).toBeGreaterThan(VISION_MAX_BYTES);
      const staged = await stagePhoto(await heldPhoto(db, workspace, path, fit), true);
      const { image } = staged;
      // Nothing of the copy is stored until the message is.
      expect(() => readBlob(workspace, image.sha)).toThrow();
      commitStaged(db, workspace, staged.blobs, () => undefined);
      const sent = Buffer.from(image.data, "base64");
      expect(image.mediaType).toBe("image/jpeg");
      expect(sent.length).toBeLessThanOrEqual(VISION_MAX_BYTES);
      expect(image.resizedFrom).toEqual({ width: 3000, height: 2000, bytes: bytes.length });
      // The stored copy is what was sent. The original is the exact file, tagged so it is never resent.
      expect(readFileSync(readBlob(workspace, image.sha).file)).toEqual(sent);
      expect(image.original!.mime).toBe(`image/jpeg${ORIGINAL_SUFFIX}`);
      expect(readFileSync(readBlob(workspace, image.original!.sha).file)).toEqual(Buffer.from(bytes));
      const insert = db.prepare("INSERT INTO attachments (id, message_id, blob_sha, mime, created_at) VALUES (?, 'm', ?, ?, ?)");
      insert.run("a1", image.sha, image.mediaType, 10);
      insert.run("a2", image.original!.sha, image.original!.mime, 10);
      const resend = await savedImages(db, workspace, "c", undefined, fit);
      expect(resend.skipped).toEqual([]);
      expect(resend.images).toHaveLength(1);
      expect(Buffer.from(resend.images[0]!.data, "base64")).toEqual(sent);
    } finally { db.close(); }
  }, 180_000);

  it("fits an oversized image saved before fitting existed, off the core thread, and skips HEIC rows", async () => {
    const { workspace, db } = setup();
    try {
      const { bytes } = bigPhoto(workspace);
      const legacy = putBlob(workspace, bytes, "image/jpeg", ".jpg");
      const heic = putBlob(workspace, new Uint8Array([1, 2, 3]), "image/heic", ".heic");
      const insert = db.prepare("INSERT INTO attachments (id, message_id, blob_sha, mime, created_at) VALUES (?, 'm', ?, ?, ?)");
      insert.run("a1", legacy, "image/jpeg", 30);
      insert.run("a2", heic, "image/heic", 20);
      const asked: Array<{ ext: string; aborted: boolean | undefined }> = [];
      const controller = new AbortController();
      // The stand-in for the extract worker: the fit happens behind an await, and gets the extension and the signal.
      const worker = async (file: string, ext: string, signal?: AbortSignal) => {
        asked.push({ ext, aborted: signal?.aborted });
        await Promise.resolve();
        return normalizeForVision(new Uint8Array(readFileSync(file)));
      };
      const resend = await savedImages(db, workspace, "c", controller.signal, worker);
      expect(resend.skipped).toEqual([]);
      expect(resend.images).toHaveLength(1);
      expect(Buffer.from(resend.images[0]!.data, "base64").length).toBeLessThanOrEqual(VISION_MAX_BYTES);
      expect(asked).toEqual([{ ext: ".jpg", aborted: false }]);
    } finally { db.close(); }
  }, 60_000);

  it("says why a saved image was left out instead of dropping it silently", async () => {
    const { workspace, db } = setup();
    try {
      const insert = db.prepare("INSERT INTO attachments (id, message_id, blob_sha, mime, created_at) VALUES (?, 'm', ?, ?, ?)");
      const row = (id: string, bytes: number, at: number) =>
        insert.run(id, putBlob(workspace, new Uint8Array(bytes).fill(id.charCodeAt(1)), "image/png", ".png"), "image/png", at);
      row("a1", 11, 60);
      row("a2", 12, 50);
      row("a3", 13, 40);
      row("a4", 14, 30);
      row("a5", 15, 20);
      const verdicts: Record<number, string> = { 11: "vision-image-too-large", 12: "source-too-big", 13: "vision-image-unsupported" };
      const fitting = async (file: string) => {
        const size = readFileSync(file).length;
        if (verdicts[size]) throw new Error(verdicts[size]);
        return { mediaType: "image/png" as const, bytes: new Uint8Array([size]) };
      };
      const resend = await savedImages(db, workspace, "c", undefined, fitting);
      // The fifth image is past the four a turn resends; the first three could not be fitted; the fourth was sent.
      expect(resend.skipped).toEqual(["over-limit", "too-large", "too-large", "unreadable"]);
      expect(resend.images.map((image) => Buffer.from(image.data, "base64")[0])).toEqual([14]);
      // A missing blob is unreadable too, and the turn carries on.
      db.prepare("DELETE FROM attachments").run();
      insert.run("b1", "0".repeat(64), "image/png", 10);
      expect((await savedImages(db, workspace, "c", undefined, fitting)).skipped).toEqual(["unreadable"]);
    } finally { db.close(); }
  });

  it("stops when the turn is cancelled, rather than reporting the photo as unreadable", async () => {
    const { workspace, db } = setup();
    try {
      db.prepare("INSERT INTO attachments (id, message_id, blob_sha, mime, created_at) VALUES ('a', 'm', ?, 'image/png', 1)").run(
        putBlob(workspace, new Uint8Array([1, 2]), "image/png", ".png"),
      );
      const cancelled = async () => {
        throw new DOMException("Cancelled", "AbortError");
      };
      await expect(savedImages(db, workspace, "c", undefined, cancelled)).rejects.toThrow("Cancelled");
      const controller = new AbortController();
      controller.abort();
      await expect(savedImages(db, workspace, "c", controller.signal, fit)).rejects.toThrow();
    } finally { db.close(); }
  });

  it("reads a photo that cannot be fitted locally and keeps it", async () => {
    const { workspace, db } = setup();
    try {
      const path = join(workspace, "huge.webp");
      writeFileSync(path, new Uint8Array(8));
      const failing = async () => {
        throw new Error("vision-image-too-large");
      };
      const photo = await heldPhoto(db, workspace, path, failing);
      expect(photo.fitted).toBeNull();
      const { image } = await stagePhoto(photo, true);
      expect(await recognisePhoto(photo, workspace, async () => "read locally")).toBe("read locally");
      expect(image.data).toBe("");
      expect(readFileSync(readBlob(workspace, image.sha).file)).toEqual(Buffer.alloc(8));
      const controller = new AbortController();
      controller.abort();
      await expect(
        recognisePhoto(photo, workspace, async (_bytes, _cache, signal) => (signal?.throwIfAborted(), "x"), controller.signal),
      ).rejects.toThrow();
    } finally { db.close(); }
  });

  it("says the OCR data is missing instead of failing without a reason", async () => {
    const { workspace, db } = setup();
    try {
      const path = join(workspace, "foto.webp");
      writeFileSync(path, new Uint8Array(8));
      const photo = await heldPhoto(db, workspace, path, fit);
      await expect(
        recognisePhoto(photo, workspace, async () => {
          throw new Error("ocr-data-missing");
        }),
      ).rejects.toMatchObject({ messageKey: "sources.ocrDataMissing" });
    } finally { db.close(); }
  });

  it("hands local OCR the stored file bytes and the turn's signal, so a cancel reaches the worker", async () => {
    const { workspace, db } = setup();
    try {
      const { path, bytes } = bigPhoto(workspace);
      const controller = new AbortController();
      let seen: { bytes: Uint8Array; signal?: AbortSignal } | undefined;
      const recognize = async (given: Uint8Array, _cache: string, signal?: AbortSignal) => {
        seen = { bytes: given, signal };
        return "letto";
      };
      const photo = await heldPhoto(db, workspace, path, fit);
      expect(await recognisePhoto(photo, workspace, recognize, controller.signal)).toBe("letto");
      expect(seen!.signal).toBe(controller.signal);
      // The recognizer gets the original file at full size. Turning it upright is its own business, in the worker.
      expect(Buffer.from(seen!.bytes)).toEqual(Buffer.from(bytes));
    } finally { db.close(); }
  }, 180_000);
});
