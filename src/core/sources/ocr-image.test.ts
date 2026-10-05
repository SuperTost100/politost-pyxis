import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDatabase } from "../db/connection";
import { MAX_IMAGE_BASE64, MAX_IMAGE_BYTES } from "../../shared/source-types";
import { requests } from "../../shared/ipc";
import { sourceHandlers } from "./handlers";
import type { runSourceWorker } from "./worker-client";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const png = PNG.sync.write(new PNG({ width: 8, height: 8 }));
const page = png.toString("base64");

function setup(work: ReturnType<typeof vi.fn>) {
  const workspace = mkdtempSync(join(tmpdir(), "pyxis-ocr-image-"));
  dirs.push(workspace);
  const db = openDatabase(":memory:");
  db.prepare(
    `INSERT INTO sources (id, kind, title, status, mime, created_at, updated_at) VALUES ('scan', 'pdf', 'Scan', 'needs-ocr', 'application/pdf', 1, 1)`,
  ).run();
  db.prepare(`INSERT INTO source_documents (id, source_id, version, tree_json, created_at) VALUES ('doc', 'scan', 1, '{"pages":1}', 1)`).run();
  const handlers = sourceHandlers(db, workspace, undefined, undefined, work as unknown as typeof runSourceWorker);
  const state = () => ({
    status: (db.prepare(`SELECT status FROM sources WHERE id = 'scan'`).get() as { status: string }).status,
    passages: (db.prepare(`SELECT COUNT(*) AS n FROM passages`).get() as { n: number }).n,
  });
  return { workspace, db, handlers, state };
}
const input = (pngBase64: string, last = true) => ({ sourceId: "scan", pngBase64, page: 1, last });

describe("a scanned-PDF page is read by the OCR worker behind the decode gate", () => {
  it("hands the PNG bytes and the request's signal to the worker, and registers the text it returns", async () => {
    const work = vi.fn(async () => "Il calore si trasmette");
    const { handlers, state, workspace } = setup(work);
    const controller = new AbortController();
    expect(await handlers.ocrImage(input(page), controller.signal)).toEqual({ status: "ready" });
    expect(work).toHaveBeenCalledWith(
      "extract-worker",
      { path: "", ext: "", tess: join(workspace, "runtimes", "tesseract"), mode: "ocr", bytes: png },
      controller.signal,
    );
    expect(state()).toEqual({ status: "ready", passages: 1 });
  });

  it("a cancel reaches the worker call, and one made before the call never starts it or touches the source", async () => {
    const work = vi.fn(
      (_name: string, _input: unknown, signal?: AbortSignal) =>
        new Promise<string>((_resolve, reject) =>
          signal?.addEventListener("abort", () => reject(new DOMException("Cancelled", "AbortError"))),
        ),
    );
    const { handlers, state } = setup(work);
    const controller = new AbortController();
    const running = handlers.ocrImage(input(page), controller.signal);
    controller.abort();
    await expect(running).rejects.toMatchObject({ name: "AbortError" });
    expect(work).toHaveBeenCalledTimes(1);
    work.mockClear();
    await expect(handlers.ocrImage(input(page), AbortSignal.abort())).rejects.toMatchObject({ name: "AbortError" });
    expect(work).not.toHaveBeenCalled();
  });

  it("refuses an oversize or foreign payload before any worker call, decode or row write", async () => {
    const work = vi.fn(async () => "never");
    const { handlers, state } = setup(work);
    const huge = "A".repeat(MAX_IMAGE_BASE64 + 4);
    // The wire schema stops it before the handler is reached, and the handler holds the same line when called directly.
    expect(requests["sources.ocrImage"].input.safeParse(input(huge)).success).toBe(false);
    expect(requests["sources.ocrImage"].input.safeParse(input(page)).success).toBe(true);
    await expect(handlers.ocrImage(input(huge))).rejects.toMatchObject({ messageKey: "sources.tooBig" });
    // The text limit is exactly what a photo at the byte cap encodes to.
    expect(Buffer.alloc(MAX_IMAGE_BYTES).toString("base64").length).toBe(MAX_IMAGE_BASE64);
    await expect(handlers.ocrImage(input(Buffer.from("GIF89a not a png").toString("base64")))).rejects.toMatchObject({
      messageKey: "sources.imageUnsupported",
    });
    expect(work).not.toHaveBeenCalled();
    expect(state()).toEqual({ status: "needs-ocr", passages: 0 });
  });

  it("passes the missing-data refusal on by name", async () => {
    const work = vi.fn(async () => {
      throw new Error("ocr-data-missing");
    });
    const { handlers } = setup(work);
    await expect(handlers.ocrImage(input(page))).rejects.toMatchObject({ messageKey: "sources.ocrDataMissing" });
  });
});
