import { mkdtempSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { putBlob, readBlob } from "./blobs";

describe("blobs", () => {
  it("stores one file for the same bytes", () => {
    const workspace = mkdtempSync(join(tmpdir(), "pyxis-blob-"));
    const bytes = new TextEncoder().encode("same-notes");
    const first = putBlob(workspace, bytes, "text/plain", "txt");
    const second = putBlob(workspace, bytes, "text/plain", "txt");
    expect(first).toBe(second);
    expect(first).toHaveLength(64);
    const folder = join(workspace, "blobs", first.slice(0, 2));
    const files = readdirSync(folder);
    expect(files).toEqual([first, `${first}.json`]);
    expect(statSync(join(folder, first)).size).toBe(bytes.byteLength);
    expect(readBlob(workspace, first).mime).toBe("text/plain");
    putBlob(workspace, bytes, "application/pdf", "pdf");
    expect(readBlob(workspace, first).mime).toBe("text/plain");
  });

  it("rejects a hash that is not 64 hex characters", () => {
    const workspace = mkdtempSync(join(tmpdir(), "pyxis-blob-"));
    expect(() => readBlob(workspace, "../etc/passwd")).toThrow(/bad-hash/);
  });
});
