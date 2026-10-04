import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import { readBlob } from "../blobs";
import { heicToPng } from "../sources/heic";
import { prepareFiles } from "./attach";

it("SRC-04 sends HEIC pixels to vision or OCR and preserves the original", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "pyxis-heic-chat-"));
  const db = openDatabase(":memory:");
  try {
    const path = "tests/fixtures/synthetic-note.heic";
    const decode = async (file: string) => (await heicToPng(new Uint8Array(readFileSync(file)))).png;
    const vision = await prepareFiles(db, workspace, [path], "claude-sonnet-5-5", undefined, undefined, decode);
    expect(vision.images[0]?.mediaType).toBe("image/png");
    expect(PNG.sync.read(Buffer.from(vision.images[0]!.data, "base64")).width).toBe(64);
    const original = vision.images[0]!.original!;
    expect(original.mime).toBe("image/heic");
    expect(readFileSync(readBlob(workspace, original.sha).file)).toEqual(readFileSync(path));
    let width = 0;
    const ocr = await prepareFiles(db, workspace, [path], "text-only-model", async (bytes) => {
      width = PNG.sync.read(Buffer.from(bytes)).width;
      return "Local note text";
    }, undefined, decode);
    expect(width).toBe(64);
    expect(ocr.notes).toEqual(["Local note text"]);
    expect(ocr.images[0]!.data).toBe("");
  } finally { db.close(); rmSync(workspace, { recursive: true, force: true }); }
});
