import { theme } from "antd";
import { describe, expect, it } from "vitest";
import { pyxisColors, pyxisTheme, type PyxisMode } from "./pyxis-theme";

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

// Ant Design derives the link's hover and active colours from colorLink, and its dark algorithm darkens them below
// 4.5:1 on the cards. A link under the pointer must stay as readable as one at rest.
describe("link button contrast", () => {
  for (const mode of ["dark", "light"] as PyxisMode[]) {
    const resolved = theme.getDesignToken(pyxisTheme(mode));
    for (const state of ["colorLink", "colorLinkHover", "colorLinkActive"] as const) {
      for (const ground of ["bg", "surface", "surfaceOverlay"] as const) {
        it(`${state} on ${ground} is 4.5:1 or more in the ${mode} theme`, () => {
          expect(contrast(resolved[state], pyxisColors[mode][ground])).toBeGreaterThanOrEqual(4.5);
        });
      }
    }
  }
});
