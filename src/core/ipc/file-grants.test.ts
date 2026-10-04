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
import { FileGrants, pickedFileGrant } from "./file-grants";

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
