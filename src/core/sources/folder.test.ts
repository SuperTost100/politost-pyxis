import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { listImportable } from "./folder";

describe("folder import", () => {
  it("lists supported files and skips hidden ones", () => {
    const root = mkdtempSync(join(tmpdir(), "pyxis-folder-"));
    mkdirSync(join(root, "notes"));
    writeFileSync(join(root, "notes", "chapter.txt"), "testo");
    writeFileSync(join(root, "slide.pptx"), "x");
    writeFileSync(join(root, ".secret.pdf"), "no");
    writeFileSync(join(root, "photo.png"), "x");
    writeFileSync(join(root, "skip.exe"), "no");
    const listed = listImportable(root);
    expect(listed.map((file) => file.slice(root.length))).toEqual([
      "/notes/chapter.txt",
      "/photo.png",
      "/slide.pptx",
    ]);
  });
});
