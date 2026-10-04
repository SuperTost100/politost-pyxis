import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import { heicToPng, HEIC_PNG_EDGE, MAX_HEIC_PIXELS, type HeifApi } from "./heic";
import { importImageFile } from "./intake";
import { sha256 } from "./quality";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// ponytail: bytes are a valid `ftyp heic` header with junk after it, not a real HEVC image.
// The synthetic-note.heic fixture separately covers the actual WASM decoder.
function heicBytes(extra = 32): Uint8Array {
  const out = new Uint8Array(24 + extra);
  new DataView(out.buffer).setUint32(0, 24);
  out.set(new TextEncoder().encode("ftypheic"), 4);
  out.set(new TextEncoder().encode("mif1heic"), 16);
  out.fill(7, 24);
  return out;
}

function fakeApi(width: number, height: number, log: string[], ok = true): HeifApi {
  return {
    HeifDecoder: class {
      decode() {
        return [
          {
            get_width: () => width,
            get_height: () => height,
            display(
              target: { data: Uint8ClampedArray },
              done: (result: unknown) => void,
            ) {
              log.push(`display:${target.data.length}`);
              target.data.fill(200);
              done(ok ? target : null);
            },
            free: () => log.push("image-free"),
          },
        ];
      }
      free() {
        log.push("decoder-free");
      }
    },
  };
}

describe("SRC-04 HEIC decode", () => {
  it("decodes the real synthetic HEIC fixture with the bundled WASM decoder", async () => {
    const bytes = new Uint8Array(readFileSync("tests/fixtures/synthetic-note.heic"));
    const out = await heicToPng(bytes);
    const image = PNG.sync.read(Buffer.from(out.png));
    expect([image.width, image.height]).toEqual([64, 64]);
    expect(image.data[0]).toBeGreaterThan(210);
    expect(image.data[1]).toBeGreaterThan(170);
    expect(image.data[2]).toBeLessThan(40);
  });

  it("returns a bounded valid PNG and frees decoder objects", async () => {
    const log: string[] = [];
    const out = await heicToPng(heicBytes(), fakeApi(HEIC_PNG_EDGE * 2, 100, log));
    const png = PNG.sync.read(Buffer.from(out.png));
    expect(png.width).toBe(HEIC_PNG_EDGE);
    expect(png.height).toBe(50);
    expect(png.data[0]).toBe(200);
    expect(log).toEqual([`display:${HEIC_PNG_EDGE * 2 * 100 * 4}`, "image-free", "decoder-free"]);
  });

  it("selects the declared primary image and frees every image handle", async () => {
    const log: string[] = []; const base = fakeApi(2, 2, log);
    const api: HeifApi = { HeifDecoder: class extends base.HeifDecoder {
      decode() {
        return [{ ...super.decode(new Uint8Array())[0]!, is_primary: () => false, get_width: () => MAX_HEIC_PIXELS },
          { ...super.decode(new Uint8Array())[0]!, is_primary: () => true }];
      }
    } };
    const out = await heicToPng(heicBytes(), api);
    expect(out.width).toBe(2);
    expect(log.filter((entry) => entry === "image-free")).toHaveLength(2);
  });

  it("rejects oversize pixel dimensions before allocating RGBA", async () => {
    const log: string[] = [];
    const side = Math.ceil(Math.sqrt(MAX_HEIC_PIXELS)) + 1;
    await expect(heicToPng(heicBytes(), fakeApi(side, side, log))).rejects.toThrow("heic-too-large");
    expect(log).toEqual(["image-free", "decoder-free"]);
  });

  it("rejects non-HEIC bytes and failed decodes with explicit errors", async () => {
    const log: string[] = [];
    await expect(heicToPng(new Uint8Array(64), fakeApi(2, 2, log))).rejects.toThrow("heic-invalid");
    await expect(heicToPng(heicBytes(), fakeApi(2, 2, log, false))).rejects.toThrow("heic-invalid");
    expect(log.filter((entry) => entry === "decoder-free")).toHaveLength(1);
  });
});

describe("SRC-04 HEIC import", () => {
  it("keeps the original HEIC blob and OCRs the decoded PNG", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "pyxis-heic-"));
    dirs.push(workspace);
    const db = openDatabase(":memory:");
    const bytes = heicBytes();
    const path = join(workspace, "notes.heic");
    writeFileSync(path, bytes);
    let seen: Uint8Array | undefined;
    const result = await importImageFile(
      db,
      workspace,
      path,
      async (pixels) => {
        seen = pixels;
        return "Energia cinetica";
      },
      (original) => heicToPng(original, fakeApi(4, 4, [])),
    );
    expect(seen && PNG.sync.read(Buffer.from(seen)).width).toBe(4);
    expect(db.prepare(`SELECT mime, blob_sha, status FROM sources WHERE id = ?`).get(result.sourceId)).toEqual({
      mime: "image/heic",
      blob_sha: sha256(bytes),
      status: "ready",
    });
    expect(result.passages).toBe(1);
    db.close();
  });

  it("creates no source for a corrupt or non-HEIC file", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "pyxis-heic-bad-"));
    dirs.push(workspace);
    const db = openDatabase(":memory:");
    const path = join(workspace, "fake.heic");
    writeFileSync(path, "not a heic file at all");
    await expect(importImageFile(db, workspace, path, async () => "x")).rejects.toThrow("heic-invalid");
    expect(db.prepare(`SELECT COUNT(*) AS n FROM sources`).get()).toEqual({ n: 0 });
    db.close();
  });
});
