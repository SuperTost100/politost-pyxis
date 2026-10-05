import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { listImportable, MAX_FOLDER_DEPTH, MAX_FOLDER_FILES } from "./folder";

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
    expect(listed.files.map((file) => file.slice(root.length))).toEqual([
      "/notes/chapter.txt",
      "/photo.png",
      "/slide.pptx",
    ]);
    expect(listed).toMatchObject({ cappedFiles: false, cappedDepth: false });
  });

  it("says when the file cap cut the list, and not when the folder holds exactly the cap", () => {
    const root = mkdtempSync(join(tmpdir(), "pyxis-folder-cap-"));
    for (let index = 0; index < MAX_FOLDER_FILES; index += 1) writeFileSync(join(root, `n${index}.txt`), "");
    expect(listImportable(root)).toMatchObject({ cappedFiles: false });
    writeFileSync(join(root, "one-more.txt"), "");
    const listed = listImportable(root);
    expect(listed.files).toHaveLength(MAX_FOLDER_FILES);
    expect(listed.cappedFiles).toBe(true);
  });

  it("says when folders nested past the depth cap were not read", () => {
    const root = mkdtempSync(join(tmpdir(), "pyxis-folder-depth-"));
    let dir = root;
    // Files sit at depth 0 up to MAX_FOLDER_DEPTH. The next folder down is never opened.
    for (let depth = 0; depth <= MAX_FOLDER_DEPTH; depth += 1) {
      writeFileSync(join(dir, `at-${depth}.txt`), "");
      dir = join(dir, `d${depth}`);
      mkdirSync(dir);
    }
    writeFileSync(join(dir, "too-deep.txt"), "");
    const listed = listImportable(root);
    expect(listed.files).toHaveLength(MAX_FOLDER_DEPTH + 1);
    expect(listed.files.some((file) => file.endsWith("too-deep.txt"))).toBe(false);
    expect(listed.cappedDepth).toBe(true);
  });
});
