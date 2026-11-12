import { describe, expect, it } from "vitest";
import { color, scrollbar } from "../tokens/tokens.json";

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

/** `over` laid on `under` at `share` (0 to 1) of its strength, as `color-mix(in srgb, over N%, transparent)` on a ground. */
function mix(over: string, under: string, share: number): string {
  const channels = (hex: string) => [16, 8, 0].map((shift) => (parseInt(hex.slice(1, 7), 16) >> shift) & 255);
  const [a, b] = [channels(over), channels(under)];
  return `#${a.map((c, i) => Math.round(c * share + b[i]! * (1 - share)).toString(16).padStart(2, "0")).join("")}`;
}

/** The share of ink in a scrollbar token, `color-mix(in srgb, var(--ink) N%, transparent)`. */
function inkShare(name: string): number {
  const token = scrollbar.tokens.find((entry) => entry.name === name);
  const share = token?.value.match(/^color-mix\(in srgb, var\(--ink\) (\d+)%, transparent\)$/)?.[1];
  if (!share) throw new Error(`tokens.json has no ink mix for ${name}`);
  return Number(share) / 100;
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
      // The thumb has a transparent track, so the ground is what it must stand out from when the pointer finds it.
      it(`the scrollbar thumb on hover on ${ground} is 3:1 or more in ${mode}`, () => {
        const base = value(ground, mode);
        const thumb = mix(value("ink", mode), base, inkShare("scrollbar-thumb-hover"));
        expect(contrast(thumb, base)).toBeGreaterThanOrEqual(3);
      });
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
    // A book cover's title on each subject colour, and the cover itself against the card it sits on.
    for (const cover of ["cover-1", "cover-2", "cover-3", "cover-4", "cover-5", "cover-6"]) {
      it(`the book title on ${cover} is 4.5:1 or more in ${mode}`, () => {
        expect(contrast(value("on-cover", mode), value(cover, mode))).toBeGreaterThanOrEqual(4.5);
      });
      it(`${cover} on surface is 3:1 or more in ${mode}`, () => {
        expect(contrast(value(cover, mode), value("surface", mode))).toBeGreaterThanOrEqual(3);
      });
    }
    // A kind's colour carries drawn marks in `on-cover` and must stand out from the card under it, also when the cover
    // is hovered or selected (surface-raised).
    for (const kind of ["kind-slides", "kind-exam", "kind-notes", "kind-exercises", "cover-none"]) {
      it(`the marks on ${kind} are 3:1 or more in ${mode}`, () => {
        expect(contrast(value("on-cover", mode), value(kind, mode))).toBeGreaterThanOrEqual(3);
      });
      for (const ground of ["surface", "surface-raised"])
        it(`${kind} on ${ground} is 3:1 or more in ${mode}`, () => {
          expect(contrast(value(kind, mode), value(ground, mode))).toBeGreaterThanOrEqual(3);
        });
    }
    // The state mark (reading, failed, missing, locked) is a `surface` disc ringed in `border-control`, on a cover's
    // corner: on every colour a corner can have, the disc or its ring stands out 3:1.
    for (const under of [
      "cover-1", "cover-2", "cover-3", "cover-4", "cover-5", "cover-6", "cover-none", "kind-slides", "kind-notes", "paper",
      "surface", "surface-raised",
    ]) {
      it(`the state mark reads on ${under} in ${mode}`, () => {
        const ground = value(under, mode);
        expect(
          Math.max(contrast(value("surface", mode), ground), contrast(value("border-control", mode), ground)),
        ).toBeGreaterThanOrEqual(3);
      });
    }
    for (const [name, soft] of [
      ["primary-text", "primary-soft"],
      ["ok", "ok-soft"],
      // The danger button's label on its hover fill.
      ["danger", "danger-soft"],
    ]) {
      it(`${name} on ${soft} is 4.5:1 or more in ${mode}`, () => {
        expect(
          contrast(value(name!, mode), value(soft!, mode)),
        ).toBeGreaterThanOrEqual(4.5);
      });
    }
  }
});
