import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import { downloadEmbedding, embeddingConsent, indexVectors, setEmbeddingConsent } from "./embed";
import { sha256 } from "./quality";
import { retrieve } from "./retrieve";

const HASH = "ab".repeat(32);

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
