import { expect, it } from "vitest";
import { decryptKeys } from "./decrypt-keys";

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
