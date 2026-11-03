import { describe, expect, it } from "vitest";
import { color } from "../tokens/tokens.json";

type Mode = "dark" | "light";

function value(name: string, mode: Mode): string {
  const token = color.tokens.find((entry) => entry.name === name);
  if (!token) throw new Error(`tokens.json has no colour ${name}`);
  const raw = token.value[mode];
  const ref = raw.match(/^\{([a-z0-9-]+)\}$/);
  return ref?.[1] ? value(ref[1], mode) : raw;
}

/** WCAG relative luminance of a #rrggbb colour. */
function luminance(hex: string): number {
  const n = parseInt(hex.slice(1, 7), 16);
  const [r, g, b] = [16, 8, 0]
    .map((shift) => ((n >> shift) & 255) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light! + 0.05) / (dark! + 0.05);
}

// Every surface text or a control can sit on.
const grounds = [
  "bg",
  "surface",
  "surface-raised",
  "surface-sunken",
  "surface-overlay",
];
// Text: 4.5:1 (WCAG 1.4.3). Controls, focus and the exam rings: 3:1 (WCAG 1.4.11).
const text = [
  "ink",
  "ink-muted",
  "ink-subtle",
  "primary-text",
  "mastery-text",
  "ok",
  "danger",
];
const controls = [
  "border-control",
  "focus-ring",
  "ring-prep",
  "ring-path",
  "ring-today",
];

describe("token contrast", () => {
  for (const mode of ["dark", "light"] as Mode[]) {
    for (const ground of grounds) {
      for (const name of text) {
        it(`${name} on ${ground} is 4.5:1 or more in ${mode}`, () => {
          expect(
            contrast(value(name, mode), value(ground, mode)),
          ).toBeGreaterThanOrEqual(4.5);
        });
      }
      for (const name of controls) {
        it(`${name} on ${ground} is 3:1 or more in ${mode}`, () => {
          expect(
            contrast(value(name, mode), value(ground, mode)),
          ).toBeGreaterThanOrEqual(3);
        });
      }
    }
    for (const fill of ["primary", "primary-hover", "primary-active"]) {
      it(`the primary button label on ${fill} is 4.5:1 or more in ${mode}`, () => {
        expect(
          contrast(value("on-primary", mode), value(fill, mode)),
        ).toBeGreaterThanOrEqual(4.5);
      });
    }
    for (const [name, soft] of [
      ["primary-text", "primary-soft"],
      ["ok", "ok-soft"],
    ]) {
      it(`${name} on ${soft} is 4.5:1 or more in ${mode}`, () => {
        expect(
          contrast(value(name!, mode), value(soft!, mode)),
        ).toBeGreaterThanOrEqual(4.5);
      });
    }
  }
});
