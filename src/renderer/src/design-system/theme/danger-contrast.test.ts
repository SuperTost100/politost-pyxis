import { theme } from "antd";
import { describe, expect, it } from "vitest";
import { pyxisTheme, type PyxisMode } from "./pyxis-theme";

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

describe("solid danger button contrast", () => {
  for (const mode of ["dark", "light"] as PyxisMode[]) {
    const config = pyxisTheme(mode);
    // The tokens Ant Design resolves for this theme: the fills it paints a solid danger button with.
    const resolved = theme.getDesignToken(config);
    const label = (config.components?.Button as { dangerColor: string }).dangerColor;
    for (const state of ["colorError", "colorErrorHover", "colorErrorActive"] as const) {
      it(`${state} keeps the label at 4.5:1 or more in the ${mode} theme`, () => {
        expect(contrast(resolved[state], label)).toBeGreaterThanOrEqual(4.5);
      });
    }
  }
});
