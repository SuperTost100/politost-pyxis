import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { putBlob, readBlob } from "../core/blobs";
import { blobResponse } from "./blob-protocol";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "pyxis-blob-protocol-"));
  dirs.push(dir);
  return dir;
}

it("streams a stored file in parts with its type and size, so a large PDF is never read whole on the main thread", async () => {
  const root = workspace();
  const bytes = new Uint8Array(1024 * 1024).map((_, index) => index % 251);
  const sha = putBlob(root, bytes, "application/pdf", "pdf");
  const response = await blobResponse(root, `pyxis-blob://${sha}`);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("application/pdf");
  expect(response.headers.get("content-length")).toBe(String(bytes.length));
  const reader = response.body!.getReader();
  const parts: Uint8Array[] = [];
  for (;;) {
    const step = await reader.read();
    if (step.done) break;
    parts.push(step.value);
  }
  expect(parts.length).toBeGreaterThan(1);
  expect(Buffer.concat(parts).equals(Buffer.from(bytes))).toBe(true);
});

it("refuses a malformed hash, a missing blob and a link that leaves the blob folder", async () => {
  const root = workspace();
  expect((await blobResponse(root, "pyxis-blob://not-a-hash")).status).toBe(400);
  expect((await blobResponse(root, `pyxis-blob://${"a".repeat(64)}`)).status).toBe(404);
  const sha = putBlob(root, new Uint8Array([1, 2, 3]), "text/plain", "txt");
  const file = readBlob(root, sha).file;
  const outside = join(workspace(), "secret.txt");
  writeFileSync(outside, "secret");
  rmSync(file);
  mkdirSync(join(file, ".."), { recursive: true });
  symlinkSync(outside, file);
  expect((await blobResponse(root, `pyxis-blob://${sha}`)).status).toBe(403);
});
