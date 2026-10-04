import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDatabase } from "../core/db/connection";
import { stageWorkspaceMove } from "./workspace-move";

const hooks = vi.hoisted(() => ({
  beforeRename: undefined as
    undefined | ((from: string, to: string) => Promise<void>),
}));
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return {
    ...fs,
    rename: async (from: string, to: string) => {
      await hooks.beforeRename?.(from, to);
      return fs.rename(from, to);
    },
  };
});

const roots: string[] = [];
afterEach(async () => {
  hooks.beforeRename = undefined;
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pyxis-workspace-move-"));
  roots.push(root);
  const old = join(root, "old");
  const target = join(root, "new");
  await mkdir(join(old, "blobs", "nested"), { recursive: true });
  await mkdir(join(old, "models"));
  await mkdir(join(old, "exports"));
  const db = openDatabase(join(old, "pyxis.db"));
  db.prepare(
    "INSERT INTO plans (id, title, status, created_at, updated_at) VALUES ('plan', 'Fisica', 'ready', 1, 1)",
  ).run();
  db.close();
  await writeFile(
    join(old, "blobs", "nested", "source"),
    Buffer.from([0, 128, 255, 10]),
  );
  await writeFile(
    join(old, "models", "weights.bin"),
    Buffer.alloc(130_001, 0x61),
  );
  return { root, old, target };
}

describe("workspace move", () => {
  it("preserves files added to the reserved destination when promotion fails", async () => {
    const { old, target, root } = await fixture();
    hooks.beforeRename = async (_from, to) => {
      if (basename(to) !== "new") return;
      await mkdir(to, { recursive: true });
      await writeFile(join(to, "other-writer.txt"), "keep me");
      throw new Error("promotion-refused");
    };
    await expect(stageWorkspaceMove(old, target)).rejects.toThrow(
      "promotion-refused",
    );
    expect(await readFile(join(target, "other-writer.txt"), "utf8")).toBe(
      "keep me",
    );
    expect(await readFile(join(old, "blobs", "nested", "source"))).toEqual(
      Buffer.from([0, 128, 255, 10]),
    );
    expect(
      (await readdir(root)).some((name) => name.startsWith(".pyxis-move-")),
    ).toBe(false);
  });

  it("checks and stages a complete copy, then deletes the old workspace only on commit", async () => {
    const { root, old, target } = await fixture();
    const before = await readFile(join(old, "pyxis.db"));
    const move = await stageWorkspaceMove(old, target);
    expect(await readFile(join(old, "pyxis.db"))).toEqual(before);
    expect(await readFile(join(target, "pyxis.db"))).toEqual(before);
    expect(await readFile(join(target, "blobs", "nested", "source"))).toEqual(
      Buffer.from([0, 128, 255, 10]),
    );
    expect(await readFile(join(target, "models", "weights.bin"))).toEqual(
      Buffer.alloc(130_001, 0x61),
    );
    expect(await readdir(join(target, "exports"))).toEqual([]);
    const db = openDatabase(join(move.path, "pyxis.db"));
    expect(db.prepare("SELECT title FROM plans").all()).toEqual([
      { title: "Fisica" },
    ]);
    db.close();
    expect(await move.commit()).toBe(true);
    expect(await readdir(root)).toEqual(["new"]);
    await expect(move.rollback()).rejects.toThrow(
      "workspace-move-already-committed",
    );
  });

  it("rolls back after a failed core startup, keeping the source bytes and removing staging", async () => {
    const { root, old, target } = await fixture();
    const before = await readFile(join(old, "pyxis.db"));
    const move = await stageWorkspaceMove(old, target);
    await move.rollback();
    await move.rollback();
    expect(await readdir(root)).toEqual(["old"]);
    expect(await readFile(join(old, "pyxis.db"))).toEqual(before);
    await expect(move.commit()).rejects.toThrow(
      "workspace-move-already-rolled-back",
    );
  });

  it("refuses overlapping paths and existing destinations without touching them", async () => {
    const { root, old, target } = await fixture();
    for (const invalid of [old, join(old, "nested"), root]) {
      await expect(stageWorkspaceMove(old, invalid)).rejects.toThrow(
        "workspace-move-path-overlap",
      );
    }
    await mkdir(target);
    await writeFile(join(target, "keep"), "existing");
    await expect(stageWorkspaceMove(old, target)).rejects.toThrow();
    expect(await readFile(join(target, "keep"), "utf8")).toBe("existing");
    expect((await readdir(root)).sort()).toEqual(["new", "old"]);
    await expect(stageWorkspaceMove(old, "relative")).rejects.toThrow(
      "workspace-move-path-invalid",
    );
  });

  it("rejects corrupt or foreign databases and keeps the original on validation failure", async () => {
    const { root, old, target } = await fixture();
    const corrupt = Buffer.from("not a SQLite file");
    await writeFile(join(old, "pyxis.db"), corrupt);
    await expect(stageWorkspaceMove(old, target)).rejects.toThrow();
    expect(await readFile(join(old, "pyxis.db"))).toEqual(corrupt);
    expect(await readdir(root)).toEqual(["old"]);
  });

  it("refuses file and directory symlinks during copying, including aliases into the source", async () => {
    const { root, old, target } = await fixture();
    await symlink(join(old, "models"), join(root, "alias"));
    await expect(
      stageWorkspaceMove(old, join(root, "alias", "new")),
    ).rejects.toThrow("workspace-move-path-overlap");
    await symlink(
      join(old, "models", "weights.bin"),
      join(old, "blobs", "linked"),
    );
    await expect(stageWorkspaceMove(old, target)).rejects.toThrow(
      "workspace-move-symlink",
    );
    expect((await readdir(root)).sort()).toEqual(["alias", "old"]);
    await rm(join(old, "blobs", "linked"));
    await symlink(join(old, "models"), join(old, "blobs", "directory-link"));
    await expect(stageWorkspaceMove(old, target)).rejects.toThrow(
      "workspace-move-symlink",
    );
    await expect(
      stageWorkspaceMove(join(root, "alias"), target),
    ).rejects.toThrow("workspace-move-source-invalid");
    expect((await readdir(root)).sort()).toEqual(["alias", "old"]);
  });

  it("refuses rollback when another folder replaces the copied workspace", async () => {
    const { old, target } = await fixture();
    const move = await stageWorkspaceMove(old, target);
    await rm(target, { recursive: true });
    await mkdir(target);
    await writeFile(join(target, "unrelated"), "keep");
    await expect(move.rollback()).rejects.toThrow(
      "workspace-move-path-changed",
    );
    expect(await readFile(join(target, "unrelated"), "utf8")).toBe("keep");
    expect(await move.recoveryPath()).toBe(await realpath(old));
  });

  it("keeps the complete new copy if the original disappears before rollback", async () => {
    const { old, target } = await fixture();
    const move = await stageWorkspaceMove(old, target);
    await rm(old, { recursive: true });
    await expect(move.rollback()).rejects.toThrow();
    expect(await move.recoveryPath()).toBe(await realpath(target));
    const db = openDatabase(join(target, "pyxis.db"));
    expect(db.prepare("SELECT title FROM plans").all()).toEqual([
      { title: "Fisica" },
    ]);
    db.close();
  });

  it("refuses foreign or corrupted recovery copies without deleting either folder", async () => {
    const { root, old, target } = await fixture();
    const move = await stageWorkspaceMove(old, target);
    await rm(old, { recursive: true });
    await rm(target, { recursive: true });
    await mkdir(target);
    const replacement = openDatabase(join(target, "pyxis.db"));
    replacement.close();
    await expect(move.recoveryPath()).rejects.toThrow(
      "workspace-move-recovery-unavailable",
    );
    expect(await readdir(root)).toEqual(["new"]);
    expect(await readFile(join(target, "pyxis.db"))).toBeDefined();
  });

  it("uses a valid copied workspace when the original SQLite file is damaged", async () => {
    const { old, target } = await fixture();
    const move = await stageWorkspaceMove(old, target);
    await writeFile(join(old, "pyxis.db"), "corrupt");
    expect(await move.recoveryPath()).toBe(await realpath(target));
    await writeFile(join(target, "pyxis.db"), "also corrupt");
    await expect(move.recoveryPath()).rejects.toThrow(
      "workspace-move-recovery-unavailable",
    );
    expect(await readFile(join(old, "pyxis.db"), "utf8")).toBe("corrupt");
    expect(await readFile(join(target, "pyxis.db"), "utf8")).toBe(
      "also corrupt",
    );
  });
});
