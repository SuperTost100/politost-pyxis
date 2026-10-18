import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDatabase } from "../db/connection";
import { articleFromHtml, fetchSnapshot } from "./link";
import { importLink } from "./intake";
import { searchPassages } from "./smartbook";
import { createRunner } from "../jobs/runner";
import { enqueueSourceData, registerSourceJobs } from "./jobs";
import { extractPlain } from "./documents";
import { sourceHandlers } from "./handlers";

type PinnedRequest = {
  dispatcher: {
    options: {
      connect: {
        lookup: (
          hostname: string,
          options: unknown,
          callback: (
            error: null,
            addresses: Array<{ address: string; family: number }>,
          ) => void,
        ) => void;
      };
    };
  };
  signal: AbortSignal;
};
const transport = vi.hoisted(() => ({
  calls: [] as PinnedRequest[],
  mode: "normal",
  cancelled: false,
}));
vi.mock("node:dns/promises", () => ({
  lookup: async () => [{ address: "93.184.216.34" }],
}));
vi.mock("undici", () => ({
  Agent: class {
    constructor(public options: unknown) {}
    async close() {
      if (transport.mode === "error-stream" && !transport.cancelled)
        await new Promise(() => {});
    }
  },
  fetch: async (_url: string, options: PinnedRequest) => {
    transport.calls.push(options);
    if (transport.mode === "wait")
      return new Promise<Response>((_, reject) =>
        options.signal.addEventListener(
          "abort",
          () => reject(options.signal.reason),
          { once: true },
        ),
      );
    if (transport.mode === "error-stream")
      return new Response(
        new ReadableStream({
          cancel() {
            transport.cancelled = true;
          },
        }),
        { status: 503 },
      );
    return asResponse(article, 200, { "content-type": "text/html" });
  },
}));

const article = `<!doctype html><html><head><title>Cinematica</title>
<script>SECRET_TOKEN alert(1)</script></head><body>
<article><h1>Cinematica</h1>
<p>${"La velocità è la derivata dello spazio rispetto al tempo. ".repeat(30)}</p>
</article></body></html>`;

function asResponse(
  body: string,
  status: number,
  headers: Record<string, string> = {},
): Response {
  const bytes = new TextEncoder().encode(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    body: null,
    arrayBuffer: async () =>
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  } as unknown as Response;
}

const publicHost = async () => ["93.184.216.34"];
afterEach(() => vi.restoreAllMocks());

describe("link import", () => {
  it("drops scripts and keeps the article", () => {
    const page = articleFromHtml(article, "https://example.com/c");
    expect(page.title).toBe("Cinematica");
    expect(page.markdown).toContain("velocità");
    expect(page.markdown).not.toContain("SECRET_TOKEN");
  });

  it("follows a few redirects and stores the snapshot", async () => {
    const db = openDatabase(":memory:");
    const dir = mkdtempSync(join(tmpdir(), "pyxis-link-"));
    let calls = 0;
    const fetchImpl = (async (url: string) => {
      calls += 1;
      if (calls === 1)
        return asResponse("", 302, { location: "https://example.com/final" });
      expect(url).toBe("https://example.com/final");
      return asResponse(article, 200, { "content-type": "text/html" });
    }) as typeof fetch;
    const stored = await importLink(
      db,
      dir,
      "https://example.com/start",
      fetchImpl,
      publicHost,
    );
    expect(stored.passages).toBeGreaterThan(0);
    expect(searchPassages(db, "velocità")[0]?.text).toContain("derivata");
    const row = db
      .prepare(`SELECT origin_url FROM sources WHERE id = ?`)
      .get(stored.sourceId) as { origin_url: string };
    expect(row.origin_url).toBe("https://example.com/final");
  });

  it("refuses a page that is almost empty", async () => {
    await expect(
      fetchSnapshot(
        "https://example.com/empty",
        (async () =>
          asResponse(
            "<html><body><p>Hi</p></body></html>",
            200,
          )) as typeof fetch,
        publicHost,
      ),
    ).rejects.toThrow(/page-empty/);
  });

  it("refuses a link that points at the local network", async () => {
    await expect(
      fetchSnapshot("http://127.0.0.1/notes", fetch, publicHost),
    ).rejects.toThrow(/link-scheme/);
    await expect(
      fetchSnapshot("http://10.0.0.4/notes", fetch, async () => ["10.0.0.4"]),
    ).rejects.toThrow(/link-scheme/);
    await expect(
      fetchSnapshot("http://[::ffff:127.0.0.1]/notes", fetch, async () => [
        "::ffff:127.0.0.1",
      ]),
    ).rejects.toThrow(/link-scheme/);
    await expect(
      fetchSnapshot("http://[fe90::1]/notes", fetch, async () => ["fe90::1"]),
    ).rejects.toThrow(/link-scheme/);
    await expect(
      fetchSnapshot("http://[ff02::1]/notes", fetch, async () => ["ff02::1"]),
    ).rejects.toThrow(/link-scheme/);
    await expect(
      fetchSnapshot("http://[fec0::1]/notes", fetch, async () => ["fec0::1"]),
    ).rejects.toThrow(/link-scheme/);
  });

  it("refuses a non-http link", async () => {
    await expect(fetchSnapshot("file:///etc/passwd")).rejects.toThrow(
      /link-scheme/,
    );
  });
});

it("link import jobs keep DNS pinning while composing cancellation", async () => {
  const db = openDatabase(":memory:");
  const dir = mkdtempSync(join(tmpdir(), "pyxis-link-job-"));
  transport.calls.length = 0;
  const unpinned = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(new Error("unpinned transport must not run"));
  const runner = createRunner(db, () => {});
  registerSourceJobs(db, dir, runner, async () => ({
    document: extractPlain("Source text", false),
  }));
  const result = enqueueSourceData(
    db,
    dir,
    runner,
    new Uint8Array(),
    ".md",
    "Link",
    "https://rebind.example/article",
  );
  await expect
    .poll(() =>
      db.prepare("SELECT state FROM jobs WHERE id = ?").get(result.jobId),
    )
    .toEqual({ state: "succeeded" });
  expect(transport.calls).toHaveLength(1);
  expect(unpinned).not.toHaveBeenCalled();
  const call = transport.calls[0]!;
  expect(call.signal).toBeInstanceOf(AbortSignal);
  const callback = vi.fn();
  call.dispatcher.options.connect.lookup(
    "rebind.example",
    { all: true },
    callback,
  );
  expect(callback).toHaveBeenCalledWith(null, [
    { address: "93.184.216.34", family: 4 },
  ]);
  call.dispatcher.options.connect.lookup("rebind.example", {}, callback);
  expect(callback).toHaveBeenLastCalledWith(null, "93.184.216.34", 4);
  db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

it("caller cancellation reaches the pinned transport during the request", async () => {
  const controller = new AbortController();
  const before = transport.calls.length;
  transport.mode = "wait";
  try {
    const request = fetchSnapshot(
      "https://example.com/article",
      undefined,
      publicHost,
      controller.signal,
    );
    await vi.waitFor(() =>
      expect(transport.calls.length).toBeGreaterThan(before),
    );
    const signal = transport.calls.at(-1)!.signal;
    expect(signal.aborted).toBe(false);
    controller.abort();
    await expect(request).rejects.toThrow("link-timeout");
    expect(signal.aborted).toBe(true);
  } finally {
    transport.mode = "normal";
  }
});

it("cancels an endless failed-response body before closing its pinned agent", async () => {
  transport.mode = "error-stream";
  transport.cancelled = false;
  try {
    await expect(
      fetchSnapshot("https://example.com/article", undefined, publicHost),
    ).rejects.toThrow("link-failed");
    expect(transport.cancelled).toBe(true);
  } finally {
    transport.mode = "normal";
  }
});

describe("link details", () => {
  function bytesResponse(bytes: Uint8Array, headers: Record<string, string>): Response {
    return {
      ok: true,
      status: 200,
      headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
      body: null,
      arrayBuffer: async () =>
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    } as unknown as Response;
  }
  // "velocità" in Latin-1: the à is the single byte 0xE0, which is not valid UTF-8.
  const latin1 = (text: string) => Uint8Array.from([...text].map((char) => char.charCodeAt(0)));
  const body = `<p>${"La velocità è la derivata dello spazio rispetto al tempo. ".repeat(10)}</p>`;

  it("names a PDF link after its file, decoded", async () => {
    const page = await fetchSnapshot(
      "https://example.com/corsi/Appunti%20di%20Fisica%20%C3%A8.pdf",
      (async () => bytesResponse(new Uint8Array([37, 80, 68, 70]), { "content-type": "application/pdf" })) as typeof fetch,
      publicHost,
    );
    expect(page.title).toBe("Appunti di Fisica è");
  });

  /** A PDF that arrives in `parts` pieces, `gapMs` apart, and stops sending after `stallAfter` of them. */
  const slowPdf = (parts: number, gapMs: number, stallAfter = parts) =>
    (async (_url: string, init: RequestInit) => {
      let sent = 0;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          init.signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            controller.error(new DOMException("The operation was aborted.", "AbortError"));
          });
        },
        pull(controller) {
          if (sent === parts) return controller.close();
          if (sent === stallAfter) return new Promise<void>(() => {});
          return new Promise<void>((resolve) => {
            timer = setTimeout(() => {
              sent += 1;
              controller.enqueue(new Uint8Array(1024).fill(37));
              resolve();
            }, gapMs);
          });
        },
      });
      return new Response(body, { headers: { "content-type": "application/pdf" } });
    }) as unknown as typeof fetch;

  it("waits for a slow download as long as data keeps arriving, and gives up when it stops", async () => {
    const page = await fetchSnapshot("https://example.com/slow.pdf", slowPdf(8, 40), publicHost, undefined, 120);
    expect(page.pdf?.byteLength).toBe(8 * 1024);
    const started = Date.now();
    await expect(
      fetchSnapshot("https://example.com/stalled.pdf", slowPdf(8, 10, 2), publicHost, undefined, 120),
    ).rejects.toThrow("link-timeout");
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("reads a page in the charset its header names", async () => {
    const page = await fetchSnapshot(
      "https://example.com/latin",
      (async () =>
        bytesResponse(latin1(`<html><head><title>Cinematica</title></head><body>${body}</body></html>`), {
          "content-type": "text/html; charset=ISO-8859-1",
        })) as typeof fetch,
      publicHost,
    );
    expect(page.markdown).toContain("velocità");
  });

  it("reads a page in the charset its meta tag names", async () => {
    const page = await fetchSnapshot(
      "https://example.com/latin",
      (async () =>
        bytesResponse(
          latin1(`<html><head><meta charset="windows-1252"><title>Cinematica</title></head><body>${body}</body></html>`),
          { "content-type": "text/html" },
        )) as typeof fetch,
      publicHost,
    );
    expect(page.markdown).toContain("velocità");
  });

  it("calls text that is not a web address a link it cannot save", async () => {
    await expect(fetchSnapshot("appunti di fisica")).rejects.toThrow(/link-scheme/);
    const db = openDatabase(":memory:");
    const dir = mkdtempSync(join(tmpdir(), "pyxis-link-invalid-"));
    try {
      const handlers = sourceHandlers(db, dir, createRunner(db, () => {}));
      await expect(handlers.link({ url: "appunti di fisica" })).rejects.toMatchObject({
        messageKey: "sources.linkScheme",
      });
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
