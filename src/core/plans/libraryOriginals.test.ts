import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { putBlob } from "../blobs";
import { openDatabase } from "../db/connection";
import type { PlanFile } from "../../shared/plan-file";
import { withLibraryOriginals } from "./libraryOriginals";

describe("withLibraryOriginals", () => {
  it("embeds a matching library original and refuses a hash mismatch", () => {
    const workspace = mkdtempSync(join(tmpdir(), "pyxis-lib-"));
    const db = openDatabase(":memory:");
    const sha = putBlob(workspace, Buffer.from("hello"), "text/plain", "txt");
    db.prepare(
      "INSERT INTO sources (id, kind, title, blob_sha, status, created_at, updated_at) VALUES ('lib', 'file', 'Dispense', ?, 'ready', 1, 1)",
    ).run(sha);
    const file = {
      version: 2,
      title: "Fisica",
      topics: [],
      nodes: [],
      cards: [],
      sources: [{ id: "a", title: "Dispense", sha, bytes: 5 }],
    } as PlanFile;
    const out = withLibraryOriginals(db, workspace, {
      ...file,
      libraryFor: { "0": "lib" },
    });
    expect(out.sources![0]!.data).toBe("aGVsbG8=");
    expect(out).not.toHaveProperty("libraryFor");
    expect(() =>
      withLibraryOriginals(
        db,
        workspace,
        {
          ...file,
          sources: [{ ...file.sources![0]!, sha: "0".repeat(64) }],
          libraryFor: { "0": "lib" },
        },
      ),
    ).toThrow("plan-file");
    db.close();
    rmSync(workspace, { recursive: true, force: true });
  });
});
