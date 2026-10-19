import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { listImportable, MAX_FOLDER_DEPTH, MAX_FOLDER_FILES } from "./folder";
import { tempDir } from "../test-temp";

describe("folder import", () => {
  it("lists supported files and skips hidden ones", () => {
    const root = tempDir("pyxis-folder-");
    mkdirSync(join(root, "notes"));
    writeFileSync(join(root, "notes", "chapter.txt"), "testo");
    writeFileSync(join(root, "slide.pptx"), "x");
    writeFileSync(join(root, ".secret.pdf"), "no");
    writeFileSync(join(root, "photo.png"), "x");
    writeFileSync(join(root, "skip.exe"), "no");
    const listed = listImportable(root);
    expect(listed.files).toEqual([
      join(root, "notes", "chapter.txt"),
      join(root, "photo.png"),
      join(root, "slide.pptx"),
    ]);
    expect(listed).toMatchObject({ cappedFiles: false, cappedDepth: false });
  });

  // Writing a cap's worth of files took over 5 s on the hosted Windows runner.
  it("says when the file cap cut the list, and not when the folder holds exactly the cap", { timeout: 30_000 }, () => {
    const root = tempDir("pyxis-folder-cap-");
    for (let index = 0; index < MAX_FOLDER_FILES; index += 1) writeFileSync(join(root, `n${index}.txt`), "");
    expect(listImportable(root)).toMatchObject({ cappedFiles: false });
    writeFileSync(join(root, "one-more.txt"), "");
    const listed = listImportable(root);
    expect(listed.files).toHaveLength(MAX_FOLDER_FILES);
    expect(listed.cappedFiles).toBe(true);
  });

  it("stops after a number of entries, however few of them it could import, and says so", () => {
    const root = tempDir("pyxis-folder-entries-");
    writeFileSync(join(root, "notes.txt"), "");
    // A dependency folder holds thousands of files, none of them importable.
    mkdirSync(join(root, "node_modules"));
    for (let index = 0; index < 60; index += 1) writeFileSync(join(root, "node_modules", `m${index}.js`), "");
    expect(listImportable(root, 100)).toMatchObject({ cappedEntries: false, files: [join(root, "notes.txt")] });
    expect(listImportable(root, 30)).toMatchObject({ cappedEntries: true, cappedFiles: false });
    expect(listImportable(root, 62)).toMatchObject({ cappedEntries: false });
  });

  it("says when folders nested past the depth cap were not read", () => {
    const root = tempDir("pyxis-folder-depth-");
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

  // Windows has no chmod for folders, and root reads any folder.
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "skips a subfolder it cannot open and says so",
    () => {
      const root = tempDir("pyxis-folder-locked-");
      writeFileSync(join(root, "notes.txt"), "");
      const locked = join(root, "locked");
      mkdirSync(locked);
      writeFileSync(join(locked, "hidden.txt"), "");
      chmodSync(locked, 0o000);
      try {
        const listed = listImportable(root);
        expect(listed.files).toEqual([join(root, "notes.txt")]);
        expect(listed.unreadable).toBe(true);
      } finally {
        chmodSync(locked, 0o700);
      }
    },
  );
});
