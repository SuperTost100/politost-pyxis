import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { pyxisColors } from "./pyxis-theme";

const root = resolve(import.meta.dirname, "../../../../..");
const tokens = JSON.parse(
  readFileSync(
    resolve(root, "src/renderer/src/design-system/tokens/tokens.json"),
    "utf8",
  ),
) as {
  color: {
    tokens: Array<{ name: string; value: { dark: string; light: string } }>;
  };
};
const css = readFileSync(
  resolve(root, "src/renderer/src/design-system/tokens/tokens.css"),
  "utf8",
);

function camelToKebab(value: string): string {
  return value.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

function cssValue(block: string, name: string): string | undefined {
  const match = block.match(new RegExp(`--${name}:\\s*([^;]+);`));
  return match?.[1]?.trim().replace(/(\.\d*?)0+(?=\D|$)/g, "$1");
}

const darkBlock = css.slice(
  css.search(/:root,\s*\[data-theme="dark"\]/),
  css.search(/\[data-theme="light"\]/),
);
const lightBlock = css.slice(
  css.search(/\[data-theme="light"\]/),
  css.search(/:root\s*\{/),
);

function expectedCss(value: string): string {
  const ref = value.match(/^\{([a-z0-9-]+)\}$/);
  const raw = ref?.[1] ? `var(--${ref[1]})` : value;
  return raw.replace(/(\.\d*?)0+(?=\D|$)/g, "$1");
}

describe("design tokens stay in sync", () => {
  const byName = new Map(
    tokens.color.tokens.map((token) => [token.name, token.value]),
  );

  it("mirrors every theme colour into tokens.css", () => {
    for (const token of tokens.color.tokens) {
      if (
        typeof token.value.dark !== "string" ||
        typeof token.value.light !== "string"
      )
        continue;
      expect(cssValue(darkBlock, token.name), token.name).toBe(
        expectedCss(token.value.dark),
      );
      expect(cssValue(lightBlock, token.name), token.name).toBe(
        expectedCss(token.value.light),
      );
    }
  });

  it("mirrors pyxisColors into tokens.json", () => {
    for (const mode of ["dark", "light"] as const) {
      for (const [key, value] of Object.entries(pyxisColors[mode])) {
        const name = camelToKebab(key);
        expect(byName.get(name)?.[mode], `${mode} ${name}`).toBe(value);
      }
    }
  });
});
