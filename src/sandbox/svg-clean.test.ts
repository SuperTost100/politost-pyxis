import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import figtree from "../renderer/src/design-system/fonts/Figtree-Variable.woff2?inline";
import { FONT_FAMILY } from "./svg-clean";

it("embeds the app's own Figtree file in the drawing script, and sets every drawing's text in it", () => {
  // The font the window carries is the one the app ships for its own text, byte for byte, as a data URL.
  expect(figtree.startsWith("data:font/woff2;base64,")).toBe(true);
  const bytes = Buffer.from(figtree.slice("data:font/woff2;base64,".length), "base64");
  expect(bytes.equals(readFileSync("src/renderer/src/design-system/fonts/Figtree-Variable.woff2"))).toBe(true);
  expect(FONT_FAMILY).toBe("Figtree, sans-serif");
});
