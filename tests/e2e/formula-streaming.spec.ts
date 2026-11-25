import { expect, test } from "@playwright/test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchPyxis } from "./app-under-test";
import { removeTestFolder } from "./cleanup";
import { fromChiediToExams } from "./doors";
import { saveShot } from "./shots";

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

// A Gemini answer from the walk of the dev.13 build: prices with a comma or a full stop after the dollar sign, and the
// app's check and figure blocks indented inside the numbered steps they belong to.
const LIST_REPLY = [
  "Costa 12 $ oppure 15 $, e l'area vale $x^2$. Due biglietti da 7 $ fanno 12 $.",
  "",
  "Costa 12 $ e lo sconto è del 10 %, quindi paghi $10{,}8$ euro.",
  "",
  "1. **Forze sul piano.** La componente lungo il piano è $mg\\sin\\theta = ma$.",
  "",
  "   ```check",
  '   {"kind":"equal","expr":"m*g*sin(theta)","claimed":"m*g*sin(theta)","vars":["m","g","theta"]}',
  "   ```",
  "",
  "2. **Accelerazione.** Quindi $a = g\\sin\\theta$.",
  "",
  "\t```pyxis-figure",
  '\t{"kind":"plot","caption":"La retta $y = x$","code":"plt.plot([0, 1], [0, 1])\\nplt.xlabel(\'x\')\\nplt.ylabel(\'y\')"}',
  "\t```",
  "",
  "3. **Risultato.** Con $\\theta = 30^\\circ$ si ha $a = g/2$.",
].join("\n");

test("prices stay text and a list keeps its check and figure blocks", async () => {
  test.skip(!existsSync(".tmp/pyodide/pyodide.js"), "Requires the pinned Pyodide runtime fixture in .tmp/pyodide.");
  // The check and the figure each load Python cold, which the app allows 60 s.
  test.setTimeout(240_000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-list-blocks-"));
  const { version } = JSON.parse(readFileSync("resources/pyodide-manifest.json", "utf8"));
  const pack = join(userData, "workspace/runtimes/pyodide", version);
  mkdirSync(pack, { recursive: true });
  cpSync(".tmp/pyodide", pack, { recursive: true });
  const app = await launchPyxis({ userData, env: { PYXIS_E2E_REPLY: LIST_REPLY, PYXIS_E2E_REPLY_DELAY: "3000" } });
  try {
    const page = await app.firstWindow();
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.getByRole("button", { name: "Salta" }).click();
    await fromChiediToExams(page);
    await page.evaluate(() => {
      location.hash = "/ask";
    });
    const box = page.getByRole("textbox", { name: "Messaggio" });
    await box.fill("Spiegami il piano inclinato.");
    await box.press("Enter");
    await expect(page.locator(".px-msg:not(.px-msg-user)").getByRole("button", { name: "Altre azioni" })).toBeVisible({
      timeout: 120_000,
    });
    // The answer's own text, not the figure caption's.
    const reply = page.locator(".px-msg:not(.px-msg-user)").last().locator(".px-markdown").first();
    // The prices are text and the formulas after them are formulas.
    await expect(reply.locator("p").first()).toHaveText(/^Costa 12 \$ oppure 15 \$, e l'area vale .*\. Due biglietti da 7 \$ fanno 12 \$\.$/);
    await expect(reply.locator("p").first().locator(".katex")).toHaveCount(1);
    await expect(reply.locator("p").nth(1)).toHaveText(/^Costa 12 \$ e lo sconto è del 10 %, quindi paghi .* euro\.$/);
    await expect(reply.locator("p").nth(1).locator(".katex annotation")).toHaveText("10{,}8");
    // One list of three steps, with bold and formulas drawn, the check beside its step and the figure in its own. The
    // grey check shows while the row under the answer, which counts it, is pressed or open.
    await expect(reply.locator("ol")).toHaveCount(1);
    await expect(reply.locator("ol > li")).toHaveCount(3);
    await expect(reply.locator("ol strong")).toHaveCount(3);
    await expect(reply.locator("ol > li p .katex")).toHaveCount(4);
    const check = reply.locator("ol > li").nth(0).locator(".px-check-badge.is-verified");
    await expect(check).toBeAttached({ timeout: 90_000 });
    await expect(check).toBeHidden();
    await page.locator(".px-msg:not(.px-msg-user)").last().locator(".px-sources-bar button").first().click();
    await expect(check).toBeVisible();
    await expect(reply.locator("ol > li").nth(1).locator("figure.px-figure img").first()).toBeVisible({ timeout: 90_000 });
    await expect(reply.locator("pre, code, .px-formula-source, .katex-error")).toHaveCount(0);
    // No block source or Markdown mark is left as text (the formulas carry their LaTeX in hidden annotations).
    await expect(reply).not.toContainText(/kind|```|\*\*/);
    await saveShot(reply, "formula-streaming/list-blocks.png", { animations: "disabled" });
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});
