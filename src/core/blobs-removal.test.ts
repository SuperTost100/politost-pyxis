import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { blobFs, putBlob, readBlob, removeBlob } from "./blobs";
import { openDatabase } from "./db/connection";
import { chatHandlers } from "./chat/handlers";
import { heldFilesFor } from "./chat/test-attach";
import { tempDir } from "./test-temp";
import type { AttachmentView } from "../shared/ipc";

const real = { ...blobFs };
afterEach(() => Object.assign(blobFs, real));

/**
 * Windows deletes a file that something still holds open by marking it for deletion: the name stays in its folder, but it
 * cannot be opened, read, renamed or replaced until the last handle closes. This makes `blobFs` behave so: `rm` marks a
 * name and keeps the file, and a marked name refuses what Windows refuses. `release` is the handle closing.
 */
function holdDeletion() {
  const marked = new Set<string>();
  const refused = (path: string) => Object.assign(new Error(`EPERM: operation not permitted, open '${path}'`), { code: "EPERM" });
  const guard = (path: unknown) => {
    if (marked.has(String(path))) throw refused(String(path));
  };
  Object.assign(blobFs, {
    rm: (path: string) => void marked.add(path),
    read: ((path: string, ...rest: unknown[]) => (guard(path), (real.read as (...args: unknown[]) => unknown)(path, ...rest))) as typeof real.read,
    write: (path: string, data: Uint8Array | string) => (guard(path), real.write(path, data)),
    rename: (from: string, to: string) => (guard(from), guard(to), real.rename(from, to)),
  });
  return {
    marked,
    release() {
      for (const path of marked) real.rm(path, { force: true });
      marked.clear();
    },
  };
}

describe("a blob deleted while the system still holds it", () => {
  it("is put again at once: the name a delete leaves behind is never the one the next put uses", () => {
    const workspace = tempDir("pyxis-blob-hold-");
    const bytes = new TextEncoder().encode("Il calore si trasmette per conduzione.");
    const sha = putBlob(workspace, bytes, "text/plain", "txt");
    const held = holdDeletion();
    removeBlob(workspace, sha);
    // The blob is stored again and reads back whole, though the earlier delete is not finished.
    expect(putBlob(workspace, bytes, "text/plain", "txt")).toBe(sha);
    expect(readFileSync(readBlob(workspace, sha).file)).toEqual(Buffer.from(bytes));
    held.release();
    expect(readFileSync(readBlob(workspace, sha).file)).toEqual(Buffer.from(bytes));
  });

  it("leaves the blob whole when the system refuses the delete once, so a later put finds it as it was", () => {
    const workspace = tempDir("pyxis-blob-busy-");
    const bytes = new TextEncoder().encode("abc");
    const sha = putBlob(workspace, bytes, "text/plain", "txt");
    let refusals = 1;
    Object.assign(blobFs, {
      rename: (from: string, to: string) => {
        if (refusals-- > 0) throw Object.assign(new Error(`EBUSY: resource busy or locked, rename '${from}'`), { code: "EBUSY" });
        real.rename(from, to);
      },
      rm: (path: string, options?: { force?: boolean }) => {
        if (refusals-- > 0) throw Object.assign(new Error(`EBUSY: resource busy or locked, unlink '${path}'`), { code: "EBUSY" });
        real.rm(path, options);
      },
    });
    expect(() => removeBlob(workspace, sha)).toThrow(/EBUSY/);
    const { file } = readBlob(workspace, sha);
    expect(readFileSync(file)).toEqual(Buffer.from(bytes));
    expect(putBlob(workspace, bytes, "text/plain", "txt")).toBe(sha);
  });

  it("leaves no name behind that a backup or a Free up space would not know: a removed blob's leftovers are temporary names", () => {
    const workspace = tempDir("pyxis-blob-left-");
    const sha = putBlob(workspace, new TextEncoder().encode("xyz"), "text/plain", "txt");
    const held = holdDeletion();
    removeBlob(workspace, sha);
    const folder = join(workspace, "blobs", sha.slice(0, 2));
    const names = readdirSync(folder);
    expect(names).toHaveLength(2);
    expect(names.filter((name) => !/^\.[a-f0-9]{64}(?:\.json)?\.[a-f0-9-]{36}\.tmp$/.test(name))).toEqual([]);
    held.release();
    expect(readdirSync(folder)).toEqual([]);
  });
});

describe("what a delete the system refuses leaves behind", () => {
  const refuse = () =>
    Object.assign(blobFs, {
      rm: (path: string) => {
        throw Object.assign(new Error(`EBUSY: resource busy or locked, unlink '${path}'`), { code: "EBUSY" });
      },
    });

  it("is the file under its temporary name, which the next start removes, and a stored file is never touched", () => {
    const workspace = tempDir("pyxis-blob-sweep-");
    const db = openDatabase(join(workspace, "pyxis.db"));
    try {
      const gone = putBlob(workspace, new TextEncoder().encode("da togliere"), "text/plain", "txt");
      const kept = putBlob(workspace, new TextEncoder().encode("da tenere"), "text/plain", "txt");
      refuse();
      removeBlob(workspace, gone);
      Object.assign(blobFs, real);
      const folder = (sha: string) => join(workspace, "blobs", sha.slice(0, 2));
      const temporary = readdirSync(folder(gone)).filter((name) => name.endsWith(".tmp"));
      // The delete failed outright: both files are still on disk, under temporary names, and nothing names them.
      expect(temporary).toHaveLength(2);
      // Names that are not the form `removeBlob` makes stay: a temporary name of another blob's folder, and a stray file.
      const stray = join(folder(gone), "notes.tmp");
      writeFileSync(stray, "x");
      const misplaced = join(folder(kept), `.${gone}.${"0".repeat(8)}-0000-0000-0000-${"0".repeat(12)}.tmp`);
      if (folder(kept) !== folder(gone)) writeFileSync(misplaced, "y");
      chatHandlers(db, workspace);
      expect(readdirSync(folder(gone)).filter((name) => /^\.[a-f0-9]{64}(?:\.json)?\.[a-f0-9-]{36}\.tmp$/.test(name))).toEqual([]);
      expect(existsSync(stray)).toBe(true);
      if (folder(kept) !== folder(gone)) expect(existsSync(misplaced)).toBe(true);
      // The stored file and its metadata are as they were.
      expect(readFileSync(readBlob(workspace, kept).file, "utf8")).toBe("da tenere");
    } finally {
      db.close();
    }
  });

  it("is nothing for an entry that is not a file: a directory where a blob should be stays in place, as it did before", () => {
    const workspace = tempDir("pyxis-blob-dir-");
    const sha = putBlob(workspace, new TextEncoder().encode("abc"), "text/plain", "txt");
    const file = readBlob(workspace, sha).file;
    // Make the blob's name a directory with something in it.
    rmSync(file);
    rmSync(`${file}.json`);
    mkdirSync(file);
    writeFileSync(join(file, "dentro.txt"), "non toccare");
    expect(() => removeBlob(workspace, sha)).toThrow();
    expect(readFileSync(join(file, "dentro.txt"), "utf8")).toBe("non toccare");
    expect(readdirSync(join(workspace, "blobs", sha.slice(0, 2)))).toEqual([sha]);
  });
});

describe("a file attached again right after it was taken off", () => {
  it("is read, although the system has not finished deleting the first copy", async () => {
    const workspace = tempDir("pyxis-reattach-");
    const db = openDatabase(join(workspace, "pyxis.db"));
    try {
      const events: AttachmentView[] = [];
      const files = heldFilesFor(db, workspace, { emit: (view) => events.push(view) });
      const path = join(workspace, "appunti.txt");
      writeFileSync(path, "La forza è massa per accelerazione.");
      const state = (id: string) => events.filter((event) => event.id === id).at(-1)?.state;
      const until = async (check: () => boolean) => {
        for (let i = 0; i < 600 && !check(); i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
        expect(check()).toBe(true);
      };
      const first = await files.held.attach(path);
      await until(() => state(first.id) === "ready");
      const held = holdDeletion();
      files.held.detach(first.id);
      const second = await files.held.attach(path);
      await until(() => ["ready", "failed"].includes(state(second.id) ?? ""));
      expect(events.filter((event) => event.id === second.id).at(-1)).toMatchObject({ state: "ready" });
      held.release();
    } finally {
      db.close();
    }
  });
});
