import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { openCopies } from "./open-copies";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

function setup(remove?: (path: string) => void) {
  const base = mkdtempSync(join(tmpdir(), "pyxis-open-copies-"));
  dirs.push(base);
  const blob = join(base, "blob");
  writeFileSync(blob, "contenuto del PDF");
  const root = join(base, "open-copies");
  return { root, blob, copies: openCopies(root, remove) };
}

it("copies a stored file under its own name, in a folder of the app's, and lists it", async () => {
  const t = setup();
  const path = await t.copies.make("book", SHA_A, t.blob, "Fisica I.pdf");
  expect(path).toBe(join(t.root, "book", SHA_A, "Fisica I.pdf"));
  expect(readFileSync(path!, "utf8")).toBe("contenuto del PDF");
  expect(t.copies.list()).toEqual([{ sourceId: "book", sha: SHA_A }]);
  // Opened again, the same copy is written over, not a second one made.
  await t.copies.make("book", SHA_A, t.blob, "Fisica I.pdf");
  expect(readdirSync(join(t.root, "book"))).toEqual([SHA_A]);
});

it("refuses a name or an id that would leave the folder", async () => {
  const t = setup();
  expect(await t.copies.make("../book", SHA_A, t.blob, "a.pdf")).toBeNull();
  expect(await t.copies.make("book", "../x", t.blob, "a.pdf")).toBeNull();
  expect(await t.copies.make("book", SHA_A, t.blob, "../a.pdf")).toBeNull();
  expect(await t.copies.make("book", SHA_A, t.blob, "..")).toBeNull();
  expect(existsSync(t.root)).toBe(false);
});

it("lets go of a replaced file's copy when the new one is made", async () => {
  const t = setup();
  await t.copies.make("book", SHA_A, t.blob, "Fisica I.pdf");
  await t.copies.make("book", SHA_B, t.blob, "Fisica I.docx");
  expect(t.copies.list()).toEqual([{ sourceId: "book", sha: SHA_B }]);
});

it("removes the copies core no longer has as a Library file, and keeps the others", async () => {
  const t = setup();
  await t.copies.make("book", SHA_A, t.blob, "Fisica I.pdf");
  await t.copies.make("notes", SHA_B, t.blob, "Appunti.pdf");
  const left = await t.copies.prune(async (copy) => copy.sourceId === "notes");
  expect(left).toBe(0);
  expect(t.copies.list()).toEqual([{ sourceId: "notes", sha: SHA_B }]);
  expect(existsSync(join(t.root, "book"))).toBe(false);
});

it("removes every copy, and leaves one an app still holds for the next try", async () => {
  let held = true;
  const t = setup((path) => {
    if (held && path.includes("notes")) throw Object.assign(new Error("busy"), { code: "EBUSY" });
    rmSync(path, { recursive: true, force: true });
  });
  await t.copies.make("book", SHA_A, t.blob, "Fisica I.pdf");
  await t.copies.make("notes", SHA_B, t.blob, "Appunti.pdf");
  expect(t.copies.removeAll()).toBe(1);
  expect(t.copies.list()).toEqual([{ sourceId: "notes", sha: SHA_B }]);
  // At the next start the app let go of it.
  held = false;
  expect(t.copies.removeAll()).toBe(0);
  expect(t.copies.list()).toEqual([]);
});

it("finds what an earlier run left, without a record of its own", async () => {
  const t = setup();
  await openCopies(t.root).make("book", SHA_A, t.blob, "Fisica I.pdf");
  expect(openCopies(t.root).list()).toEqual([{ sourceId: "book", sha: SHA_A }]);
  // Anything else in the folder is not a copy and is removed with them.
  writeFileSync(join(t.root, "stray.txt"), "x");
  expect(openCopies(t.root).removeAll()).toBe(0);
  expect(readdirSync(t.root)).toEqual([]);
});
