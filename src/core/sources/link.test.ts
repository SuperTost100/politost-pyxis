import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import { articleFromHtml, fetchSnapshot } from "./link";
import { importLink } from "./intake";
import { searchPassages } from "./smartbook";

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
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  } as unknown as Response;
}

const publicHost = async () => ["93.184.216.34"];

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
      if (calls === 1) return asResponse("", 302, { location: "https://example.com/final" });
      expect(url).toBe("https://example.com/final");
      return asResponse(article, 200, { "content-type": "text/html" });
    }) as typeof fetch;
    const stored = await importLink(db, dir, "https://example.com/start", fetchImpl, publicHost);
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
        (async () => asResponse("<html><body><p>Hi</p></body></html>", 200)) as typeof fetch,
        publicHost,
      ),
    ).rejects.toThrow(/page-empty/);
  });

  it("refuses a link that points at the local network", async () => {
    await expect(fetchSnapshot("http://127.0.0.1/notes", fetch, publicHost)).rejects.toThrow(
      /link-scheme/,
    );
    await expect(
      fetchSnapshot("http://10.0.0.4/notes", fetch, async () => ["10.0.0.4"]),
    ).rejects.toThrow(/link-scheme/);
    await expect(
      fetchSnapshot("http://[::ffff:127.0.0.1]/notes", fetch, async () => ["::ffff:127.0.0.1"]),
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
    await expect(fetchSnapshot("file:///etc/passwd")).rejects.toThrow(/link-scheme/);
  });
});
