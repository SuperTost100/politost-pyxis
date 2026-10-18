import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDatabase } from "../db/connection";
import { createRunner } from "../jobs/runner";
import { downloadEmbedding, embeddingConsent, indexVectors, setEmbeddingConsent } from "./embed";
import { sourceHandlers } from "./handlers";
import { sha256 } from "./quality";
import { retrieve } from "./retrieve";

const HASH = "ab".repeat(32);

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** A response that sends `chunks`, `gapMs` apart, then either ends or, with `stall`, sends nothing more until aborted. */
function trickle(chunks: number, gapMs: number, stall = false): typeof fetch {
  return (async (_url: string, init?: RequestInit) => {
    let sent = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    return new Response(
      new ReadableStream<Uint8Array>({
        start(stream) {
          init?.signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            stream.error(init.signal?.reason);
          });
        },
        pull(stream) {
          if (sent === chunks) {
            if (!stall) stream.close();
            return new Promise(() => {});
          }
          return new Promise<void>((resolve) => {
            timer = setTimeout(() => {
              sent += 1;
              stream.enqueue(new TextEncoder().encode("x"));
              resolve();
            }, sent === 0 ? 0 : gapMs);
          });
        },
      }),
    );
  }) as typeof fetch;
}

function fakeFetch(body: string, ok = true): typeof fetch {
  return (async () =>
    ({
      ok,
      status: ok ? 200 : 500,
      arrayBuffer: async () => new TextEncoder().encode(body).buffer,
      body: null,
      headers: { get: () => null },
    }) as unknown as Response) as typeof fetch;
}

describe("embedding download", () => {
  it("does nothing until the student agrees", async () => {
    const db = openDatabase(":memory:");
    expect(embeddingConsent(db)).toBe(false);
    const status = await downloadEmbedding({
      dir: tmpdir(),
      sha256: HASH,
      consent: false,
      fetchImpl: fakeFetch("nope"),
    });
    expect(status).toBe("declined");
    setEmbeddingConsent(db, true);
    expect(embeddingConsent(db)).toBe(true);
  });

  it("refuses a file whose hash does not match", async () => {
    await expect(
      downloadEmbedding({
        dir: tmpdir(),
        sha256: HASH,
        consent: true,
        fetchImpl: fakeFetch("not the model"),
      }),
    ).rejects.toThrow(/embed-hash/);
  });

  it("gives up on a download that stops sending, and lets a slow one that keeps sending finish", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pyxis-embed-"));
    dirs.push(dir);
    await expect(
      downloadEmbedding({ dir, sha256: HASH, consent: true, idleMs: 60, fetchImpl: trickle(2, 10, true) }),
    ).rejects.toThrow("embed-download");
    expect(existsSync(join(dir, "model_quantized.onnx"))).toBe(false);
    // Eight parts 40 ms apart take longer than the 60 ms idle limit in total, but never wait that long for one.
    const status = await downloadEmbedding({
      dir,
      sha256: sha256(new TextEncoder().encode("x".repeat(8))),
      consent: true,
      idleMs: 60,
      fetchImpl: trickle(8, 40),
    });
    expect(status).toBe("ready");
  });

  it("a connection that never answers fails as a download error, and a cancel stays a cancel", async () => {
    const hang = (async (_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)))) as typeof fetch;
    await expect(downloadEmbedding({ dir: tmpdir(), sha256: HASH, consent: true, idleMs: 30, fetchImpl: hang })).rejects.toThrow(
      "embed-download",
    );
    const controller = new AbortController();
    const cancelled = downloadEmbedding({ dir: tmpdir(), sha256: HASH, consent: true, fetchImpl: hang, signal: controller.signal });
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
  });

  it("turning local search off cancels the model download", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "pyxis-embed-consent-"));
    dirs.push(workspace);
    const db = openDatabase(":memory:");
    const runner = createRunner(db, () => {});
    const handlers = sourceHandlers(db, workspace, runner);
    const fetchSpy = vi.fn(trickle(1, 0, true));
    vi.stubGlobal("fetch", fetchSpy);
    const { jobId } = await handlers.embed({ consent: true });
    await expect.poll(() => fetchSpy.mock.calls.length).toBeGreaterThan(0);
    expect(await handlers.embed({ consent: false })).toEqual({ state: "off" });
    await expect.poll(() => db.prepare("SELECT state FROM jobs WHERE id = ?").get(jobId)).toEqual({ state: "cancelled" });
    expect(handlers.embedState()).toEqual({ consent: false, ready: false });
    db.close();
  });

  it("turning local search on again while the cancelled download is still stopping starts a new one", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "pyxis-embed-consent-"));
    dirs.push(workspace);
    const db = openDatabase(":memory:");
    const runner = createRunner(db, () => {});
    const handlers = sourceHandlers(db, workspace, runner);
    // The connection takes a moment to notice the cancel, so the job still says running right after it.
    const fetchSpy = vi.fn((async (_url: string, init?: RequestInit) =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(stream) {
            stream.enqueue(new Uint8Array(1));
            init?.signal?.addEventListener("abort", () => setTimeout(() => stream.error(init.signal?.reason), 100));
          },
        }),
      )) as typeof fetch);
    vi.stubGlobal("fetch", fetchSpy);
    const first = (await handlers.embed({ consent: true })).jobId!;
    await expect.poll(() => fetchSpy.mock.calls.length).toBe(1);
    await handlers.embed({ consent: false });
    const job = (id: string) => db.prepare("SELECT state FROM jobs WHERE id = ?").get(id);
    expect(job(first)).toEqual({ state: "running" });
    const second = (await handlers.embed({ consent: true })).jobId!;
    expect(second).not.toBe(first);
    await expect.poll(() => job(first)).toEqual({ state: "cancelled" });
    await expect.poll(() => fetchSpy.mock.calls.length).toBe(2);
    expect(job(second)).toEqual({ state: "running" });
    runner.cancel(second);
    await expect.poll(() => job(second)).toEqual({ state: "cancelled" });
    db.close();
  });

  it("writes the file when the hash matches and indexes passages", async () => {
    const body = "model-bytes";
    const dir = mkdtempSync(join(tmpdir(), "pyxis-embed-"));
    const status = await downloadEmbedding({
      dir,
      sha256: sha256(new TextEncoder().encode(body)),
      consent: true,
      fetchImpl: fakeFetch(body),
    });
    expect(status).toBe("ready");
    expect(readFileSync(join(dir, "model_quantized.onnx"), "utf8")).toBe(body);

    const db = openDatabase(":memory:");
    db.prepare(`INSERT INTO passages (id, text, created_at) VALUES ('p1', 'velocita', 1)`).run();
    const vector = new Float32Array(384);
    vector[2] = 1;
    expect(indexVectors(db, () => vector)).toBe(1);
    expect(indexVectors(db, () => vector)).toBe(0);
    const found = retrieve(db, "altro", { embed: () => vector });
    expect(found.usedVectors).toBe(true);
  });
});
