import { expect, test } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchPyxis } from "./app-under-test";
import { removeTestFolder } from "./cleanup";
import { fromChiediToExams } from "./doors";

// A reply that streams word by word (the recorded reply seam), cut inside its formulas: an inline one, a display one on
// lines of its own, one in \( \), one with a dollar sign written inside, and a chemical equation alone on a line. At no
// moment may a half-arrived formula show as raw source or in an error colour; each waits as a placeholder.
const REPLY = [
  "Con $m = 2\\ \\text{kg}$ e \\(k = 50\\ \\text{N/m}\\) l'equazione del moto è",
  "",
  "$$",
  "m\\ddot{x} + b\\dot{x} + kx = 0 \\quad\\Longrightarrow\\quad \\omega' = \\sqrt{\\omega_0^2 - \\gamma^2}",
  "$$",
  "",
  "La reazione è",
  "",
  "\\ce{C3H8 + 5O2 -> 3CO2 + 4H2O}",
  "",
  "e il costo totale è $C_{\\text{tot}} = 25\\ \\$ + C_{\\text{gas}}$ in tutto.",
].join("\n");

for (const theme of ["light", "dark"] as const) {
  test(`a reply that streams never shows half a formula as source or as an error (${theme})`, async () => {
    test.setTimeout(120_000);
    const userData = mkdtempSync(join(tmpdir(), "pyxis-formula-streaming-"));
    const app = await launchPyxis({
      userData,
      env: { PYXIS_E2E_REPLY: REPLY, PYXIS_E2E_REPLY_DELAY: "9000" },
    });
    try {
      const page = await app.firstWindow();
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.getByRole("button", { name: "Salta" }).click();
      await fromChiediToExams(page);
      await page.evaluate((theme) => window.pyxis.setAppearance(theme), theme);
      await page.evaluate(() => {
        location.hash = "/ask";
      });
      // From before the question is sent: what the reply's text ever showed, whichever frame the test could not see.
      await page.evaluate(() => {
        const seen = { pending: 0, red: 0, source: 0, dollars: 0, commands: 0 };
        (window as unknown as { __formulas: typeof seen }).__formulas = seen;
        const look = () => {
          const reply = [...document.querySelectorAll(".px-msg:not(.px-msg-user) .px-markdown")].pop();
          if (!reply) return;
          seen.pending = Math.max(seen.pending, reply.querySelectorAll(".px-formula-pending").length);
          seen.red += reply.querySelectorAll(".katex-error, [style*='cc0000']").length;
          seen.source += reply.querySelectorAll(".px-formula-source").length;
          const walker = document.createTreeWalker(reply, NodeFilter.SHOW_TEXT);
          for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            if ((node.parentElement as Element).closest(".katex, pre, code")) continue;
            const text = node.nodeValue ?? "";
            if (text.includes("$")) seen.dollars += 1;
            if (/\\[A-Za-z]{2,}/.test(text)) seen.commands += 1;
          }
        };
        new MutationObserver(look).observe(document.body, { childList: true, subtree: true, characterData: true });
      });
      const box = page.getByRole("textbox", { name: "Messaggio" });
      await box.fill("Scrivi l'equazione del moto.");
      await box.press("Enter");
      // The finished reply replaces the streamed one, with its foot.
      await expect(page.locator(".px-msg:not(.px-msg-user)").getByRole("button", { name: "Altre azioni" })).toBeVisible({
        timeout: 60_000,
      });
      const seen = await page.evaluate(
        () => (window as unknown as { __formulas: Record<string, number> }).__formulas,
      );
      expect(seen.pending, "a placeholder showed while a formula was half there").toBeGreaterThan(0);
      expect(seen, "never red, never raw source, never a `$` or a command as text").toMatchObject({
        red: 0,
        source: 0,
        dollars: 0,
        commands: 0,
      });
      // Finished: every formula is drawn, including the equation and the dollar sign inside a formula, and no placeholder is left.
      const reply = page.locator(".px-msg:not(.px-msg-user) .px-markdown").last();
      await expect(reply.locator(".px-formula-pending")).toHaveCount(0);
      await expect(reply.locator(".katex-error, .px-formula-source")).toHaveCount(0);
      await expect(reply.locator(".katex")).toHaveCount(5);
    } finally {
      await app.close();
      removeTestFolder(userData);
    }
  });
}
