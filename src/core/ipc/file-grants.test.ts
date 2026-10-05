import { afterEach, describe, expect, it } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { droppedFileGrant, FileGrants, pickedFileGrant } from "./file-grants";
import { SOURCE_EXTENSIONS } from "../../shared/source-types";
import { IMPORT_EXTENSIONS } from "../sources/folder";

const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pyxis-grants-"));
  roots.push(root);
  const folder = join(root, "selected");
  mkdirSync(folder);
  const chosen = join(folder, "chosen.txt");
  writeFileSync(chosen, "chosen");
  const secret = join(root, "secret.txt");
  writeFileSync(secret, "secret");
  return { root, folder, chosen, secret, grants: new FileGrants() };
}
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
describe("native picker file grants", () => {
  it("denies every unpicked path including workspace-looking paths", () => {
    const f = fixture();
    expect(() => f.grants.read(f.chosen)).toThrow("file-access-denied");
    expect(() => f.grants.file("chosen.txt")).toThrow("file-access-denied");
  });
  it("grants the selected file without granting its neighbours", () => {
    const f = fixture();
    f.grants.add(pickedFileGrant(f.chosen));
    expect(f.grants.read(f.chosen).toString()).toBe("chosen");
    expect(() => f.grants.read(f.secret)).toThrow("file-access-denied");
    expect(() => f.grants.directory(f.folder)).toThrow("file-access-denied");
  });
  it("grants nested files in a selected folder but not siblings or traversal", () => {
    const f = fixture();
    mkdirSync(join(f.folder, "chapter"));
    const nested = join(f.folder, "chapter", "lesson.txt");
    writeFileSync(nested, "lesson");
    f.grants.add(pickedFileGrant(f.folder));
    expect(f.grants.read(nested).toString()).toBe("lesson");
    expect(() => f.grants.read(join(f.folder, "..", "secret.txt"))).toThrow(
      "file-access-denied",
    );
  });
  it("refuses file and directory symlinks escaping a selected folder", () => {
    const f = fixture();
    f.grants.add(pickedFileGrant(f.folder));
    symlinkSync(f.secret, join(f.folder, "linked.txt"));
    symlinkSync(f.root, join(f.folder, "linked-dir"), "dir");
    expect(() => f.grants.read(join(f.folder, "linked.txt"))).toThrow(
      "file-access-denied",
    );
    expect(() =>
      f.grants.read(join(f.folder, "linked-dir", "secret.txt")),
    ).toThrow("file-access-denied");
  });
  it("refuses symlink aliases even when their target is inside the selected folder", () => {
    const f = fixture();
    f.grants.add(pickedFileGrant(f.folder));
    symlinkSync(f.chosen, join(f.folder, "alias.txt"));
    expect(() => f.grants.read(join(f.folder, "alias.txt"))).toThrow(
      "file-access-denied",
    );
  });
  it("revokes a selected file when its inode is replaced", () => {
    const f = fixture();
    f.grants.add(pickedFileGrant(f.chosen));
    renameSync(f.chosen, join(f.root, "original"));
    writeFileSync(f.chosen, "replacement");
    expect(() => f.grants.read(f.chosen)).toThrow("file-access-denied");
  });
  it("revokes a selected directory when its inode is replaced", () => {
    const f = fixture();
    f.grants.add(pickedFileGrant(f.folder));
    renameSync(f.folder, join(f.root, "original"));
    mkdirSync(f.folder);
    writeFileSync(f.chosen, "replacement");
    expect(() => f.grants.read(f.chosen)).toThrow("file-access-denied");
  });
  it("ignores vanished old grants when another picked file is still available", () => {
    const f = fixture();
    f.grants.add(pickedFileGrant(f.chosen));
    f.grants.add(pickedFileGrant(f.secret));
    rmSync(f.chosen);
    expect(f.grants.read(f.secret)).toEqual(readFileSync(f.secret));
  });
});

describe("SRC-07 dropped file grants", () => {
  const supported = new Set(SOURCE_EXTENSIONS.map((ext) => `.${ext}`));
  it("covers HEIC and HEIF in the picker, a drop and a folder scan alike", () => {
    expect(supported.has(".heic") && supported.has(".heif")).toBe(true);
    expect(IMPORT_EXTENSIONS).toEqual(supported);
  });
  it("grants one dropped file without its neighbours or its folder", () => {
    const f = fixture();
    const grant = droppedFileGrant(f.chosen, supported);
    f.grants.add(grant);
    expect(f.grants.read(f.chosen).toString()).toBe("chosen");
    expect(() => f.grants.read(f.secret)).toThrow("file-access-denied");
    expect(() => f.grants.directory(f.folder)).toThrow("file-access-denied");
  });
  it("refuses an empty path from a script-built File, a relative path and a folder", () => {
    const f = fixture();
    expect(() => droppedFileGrant("", supported)).toThrow("file-access-denied");
    expect(() => droppedFileGrant("chosen.txt", supported)).toThrow(
      "file-access-denied",
    );
    expect(() => droppedFileGrant(f.folder, supported)).toThrow(
      "file-access-denied",
    );
  });
  it("refuses a file type the library cannot import", () => {
    const f = fixture();
    const key = join(f.root, "id_ed25519");
    writeFileSync(key, "private");
    const script = join(f.root, "run.sh");
    writeFileSync(script, "echo");
    expect(() => droppedFileGrant(key, supported)).toThrow(
      "file-access-denied",
    );
    expect(() => droppedFileGrant(script, supported)).toThrow(
      "file-access-denied",
    );
  });
  it("refuses a supported-looking name that links to another file type", () => {
    const f = fixture();
    const link = join(f.root, "photo.png");
    symlinkSync(f.secret.replace("secret.txt", "selected"), link);
    writeFileSync(join(f.root, "target.sh"), "echo");
    const shLink = join(f.root, "notes.txt");
    symlinkSync(join(f.root, "target.sh"), shLink);
    expect(() => droppedFileGrant(link, supported)).toThrow();
    expect(() => droppedFileGrant(shLink, supported)).toThrow(
      "file-access-denied",
    );
  });
  it("does not let a grant for one dropped file open a replaced path", () => {
    const f = fixture();
    f.grants.add(droppedFileGrant(f.chosen, supported));
    renameSync(f.chosen, join(f.folder, "moved.txt"));
    symlinkSync(f.secret, f.chosen);
    expect(() => f.grants.read(f.chosen)).toThrow("file-access-denied");
  });
});

describe("bounded reads", () => {
  it("refuses a file over the cap from its size, and reads one exactly at it", () => {
    const f = fixture();
    f.grants.add(pickedFileGrant(f.chosen));
    expect(f.grants.read(f.chosen, 6).toString()).toBe("chosen");
    expect(() => f.grants.read(f.chosen, 5)).toThrow("attach-too-big");
  });
  it("stops a file that grows past the cap while it is read", () => {
    const f = fixture();
    f.grants.add(pickedFileGrant(f.chosen));
    // fstat says 6 bytes, then the file has more by the time it is read.
    const grants = f.grants as unknown as { file(path: string): string };
    const real = grants.file.bind(grants);
    let calls = 0;
    grants.file = (path: string) => {
      calls += 1;
      if (calls === 2) writeFileSync(f.chosen, "chosen and a lot more");
      return real(path);
    };
    expect(() => f.grants.read(f.chosen, 6)).toThrow("attach-too-big");
  });
});
