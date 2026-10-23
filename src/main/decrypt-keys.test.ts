import { expect, it } from "vitest";
import { canSaveKeys, decryptKeys, readStoredKeys } from "./decrypt-keys";

it("skips undecryptable saved keys without losing a usable other provider", () => {
  expect(
    decryptKeys({ anthropic: "YmFk", openai: "Z29vZA==" }, (cipher) => {
      if (cipher.toString() === "bad") throw new Error("foreign keychain");
      return "synthetic-key";
    }),
  ).toEqual({ openai: "synthetic-key" });
  expect(
    decryptKeys({ anthropic: 42, openai: "" }, () => {
      throw new Error();
    }),
  ).toEqual({});
});

it("reads the keychain only when a key is saved", () => {
  // On macOS both calls read the Keychain, which asks for the login password when it doesn't trust this build.
  const calls: string[] = [];
  const storage = {
    isEncryptionAvailable: () => (calls.push("available"), true),
    decryptString: (cipher: Buffer) => (
      calls.push("decrypt"),
      `plain-${cipher.toString()}`
    ),
  };
  expect(readStoredKeys({}, storage)).toEqual({});
  expect(readStoredKeys({ anthropic: "", openai: 42 }, storage)).toEqual({});
  expect(calls).toEqual([]);
  expect(readStoredKeys({ openai: "Z29vZA==" }, storage)).toEqual({
    openai: "plain-good",
  });
  expect(calls).toEqual(["available", "decrypt"]);
  expect(
    readStoredKeys(
      { openai: "Z29vZA==" },
      { ...storage, isEncryptionAvailable: () => false },
    ),
  ).toEqual({});
});

it("tells Settings a key can be saved on macOS without reading the keychain", () => {
  const touched = () => {
    throw new Error("keychain read");
  };
  expect(canSaveKeys("darwin", touched)).toBe(true);
  expect(canSaveKeys("win32", () => true)).toBe(true);
  expect(canSaveKeys("win32", () => false)).toBe(false);
  expect(canSaveKeys("linux", () => true, "gnome_libsecret")).toBe(true);
  expect(canSaveKeys("linux", () => true, "basic_text")).toBe(false);
});
