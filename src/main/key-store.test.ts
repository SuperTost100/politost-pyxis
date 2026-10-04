import { afterEach, expect, it } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeKeyStore } from "./key-store";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
it("atomically replaces ciphertext without retaining removed keys or temporary files", () => {
  const root = mkdtempSync(join(tmpdir(), "pyxis-keystore-"));
  roots.push(root);
  const path = join(root, "keys.json");
  writeKeyStore(path, {
    anthropic: "fixture-ciphertext-one",
    openai: "fixture-ciphertext-two",
  });
  writeKeyStore(path, { openai: "fixture-ciphertext-two" });
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
    openai: "fixture-ciphertext-two",
  });
  expect(readdirSync(root)).toEqual(["keys.json"]);
  if (process.platform !== "win32")
    expect(statSync(path).mode & 0o777).toBe(0o600);
});
it("cleans its private temporary directory when promotion fails", () => {
  const root = mkdtempSync(join(tmpdir(), "pyxis-keystore-"));
  roots.push(root);
  writeKeyStore(join(root, "keys.json"), { anthropic: "fixture-ciphertext" });
  expect(() => writeKeyStore(root, {})).toThrow();
  expect(readdirSync(root)).toEqual(["keys.json"]);
  expect(JSON.parse(readFileSync(join(root, "keys.json"), "utf8"))).toEqual({
    anthropic: "fixture-ciphertext",
  });
});
