import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { writeFileAtomic } from "./atomic-write";
import { tempDir } from "./test-temp";

it("replaces a file for the owner only and leaves no temporary file", () => {
  const dir = tempDir("pyxis-atomic-");
  const file = join(dir, "state.json");
  writeFileSync(file, "old");
  writeFileAtomic(file, "new");
  expect(readFileSync(file, "utf8")).toBe("new");
  expect(readdirSync(dir)).toEqual(["state.json"]);
  if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
});

it("keeps the old contents and removes its temporary file when the replace fails", () => {
  const dir = tempDir("pyxis-atomic-");
  const folder = join(dir, "taken");
  mkdirSync(folder);
  writeFileSync(join(folder, "inside"), "kept");
  expect(() => writeFileAtomic(folder, "new")).toThrow();
  expect(readdirSync(dir)).toEqual(["taken"]);
  expect(readFileSync(join(folder, "inside"), "utf8")).toBe("kept");
});
