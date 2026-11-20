import { expect, test } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchPyxis } from "./app-under-test";
import { fromChiediToExams } from "./doors";
import { removeTestFolder } from "./cleanup";
import { saveShot } from "./shots";

const SIZES = [
  { width: 960, height: 640 },
  { width: 1280, height: 720 },
  { width: 1440, height: 900 },
] as const;

// Functions whose axis labels are long and negative: the default curve (-0.337) and ones that need more characters.
const FUNCTIONS = ["sin(x)/x", "0.001234*sin(x)/x - 0.00456", "-12345.6*x^2"];

test("the y-axis labels of the graph start inside the plot's box and end before its axis, at every size and for long negative values", async () => {
  test.setTimeout(180000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-graph-axis-"));
  const app = await launchPyxis({ userData });
  try {
    const page = await app.firstWindow();
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.getByRole("button", { name: "Salta" }).click();
    await fromChiediToExams(page);
    for (const size of SIZES) {
      await page.setViewportSize(size);
      await page.evaluate(() => {
        location.hash = "/tools/graph";
      });
      await page.reload();
      await expect(page.locator(".px-graph")).toBeVisible();
      for (const [index, source] of FUNCTIONS.entries()) {
        await page.getByRole("textbox", { name: "Funzione f" }).fill(source);
        // Wait until the plot has drawn the curve.
        await expect(page.locator(".px-graph-panel svg[role=img] polyline").first()).toBeVisible({ timeout: 30000 });
        const report = await page.locator(".px-graph-panel svg[role=img]").first().evaluate((node) => {
          const svg = node as SVGSVGElement;
          const frame = svg.getBoundingClientRect();
          // The y axis is the left edge of the horizontal grid lines: where the plot begins.
          const plotLeft = Math.min(...[...svg.querySelectorAll("line.px-graph-grid")].map((line) => line.getBoundingClientRect().left));
          const labels = [...svg.querySelectorAll("text")]
            .filter((text) => text.getAttribute("text-anchor") === "end")
            .map((text) => ({ text: text.textContent ?? "", box: text.getBoundingClientRect() }));
          return {
            frameLeft: frame.left,
            plotLeft,
            labels: labels.map((label) => ({ text: label.text, left: label.box.left, right: label.box.right })),
          };
        });
        expect(report.labels.length, `${size.width}x${size.height}, ${source}`).toBeGreaterThan(0);
        for (const label of report.labels) {
          const where = `${size.width}x${size.height}, ${source}: "${label.text}"`;
          // The first character is drawn: the label starts inside the svg, so a minus sign is never cut off.
          expect(label.left, `${where} starts left of the plot's box`).toBeGreaterThanOrEqual(report.frameLeft);
          // And it ends before the plot's own left edge, so it does not run over the curve.
          expect(label.right, `${where} runs into the plot`).toBeLessThanOrEqual(report.plotLeft + 0.5);
        }
        await saveShot(page, `graph-axis-${size.width}x${size.height}-${index === 0 ? "default" : `f${index}`}.png`);
      }
    }
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});
