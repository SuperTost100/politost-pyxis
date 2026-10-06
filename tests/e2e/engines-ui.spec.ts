import AxeBuilder from "@axe-core/playwright";
import { _electron as electron, expect, test } from "@playwright/test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("ENG-10 engine details, add paths and secure key-storage notice in both themes and languages", async () => {
  test.setTimeout(180000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-engine-ui-"));
  const env = { ...process.env, PYXIS_USER_DATA: userData, PYXIS_E2E: "1" };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({
    args: [join(process.cwd(), "out/main/index.js")],
    env,
  });
  try {
    const page = await app.firstWindow();
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.getByRole("button", { name: "Salta" }).click();
    // Exercise both keyring states without entering, storing or sending any key.
    mkdirSync(".shots", { recursive: true });
    for (const language of ["en", "it"] as const)
      for (const theme of ["light", "dark"] as const)
        for (const canSave of [false, true]) {
          await app.evaluate(({ safeStorage }, enabled) => {
            safeStorage.isEncryptionAvailable = () => enabled;
            // Linux also refuses the plain-text fallback, which is what a runner without a keyring reports.
            if (process.platform === "linux")
              safeStorage.getSelectedStorageBackend = () =>
                enabled ? "gnome_libsecret" : "basic_text";
          }, canSave);
          await page.evaluate(
            async ({ language, theme }) => {
              localStorage.setItem("pyxis.lang", language);
              await window.pyxis.setAppearance(theme);
              location.hash = "/settings/engines";
            },
            { language, theme },
          );
          await page.reload();
          await expect(
            page.locator(".engines-list .px-engine").first(),
          ).toBeVisible({ timeout: 30000 });
          await expect(page.locator(".engines-feature-row")).toHaveCount(7);
          // CLI Funnel enforces text-only access for every offered engine, so none is disabled.
          for (const name of ["Cursor Agent", "Antigravity"])
            await expect(
              page.locator(".engines-list .engines-row", { hasText: name }),
            ).toHaveCount(1);
          await expect(page.locator(".engines-row.is-disabled")).toHaveCount(0);
          const details = page.getByRole("button", {
            name:
              language === "en"
                ? "Details for Claude Code"
                : "Dettagli di Claude Code",
          });
          await details.click();
          const drawer = page.getByRole("dialog", {
            name: "Claude Code",
            exact: true,
          });
          await expect(drawer).toBeVisible();
          await expect(
            drawer.getByRole("combobox", {
              name: language === "en" ? "Model" : "Modello",
            }),
          ).toBeVisible();
          const audit = await new AxeBuilder({ page })
            .setLegacyMode(true)
            .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
            .analyze();
          expect(audit.violations).toEqual([]);
          await page.screenshot({
            path: `.shots/m15-engine-details-${language}-${theme}.png`,
            fullPage: true,
          });
          await drawer
            .getByRole("button", { name: /Close|Chiudi/, exact: true })
            .click();
          await page
            .getByRole("button", {
              name: language === "en" ? "Add engine" : "Aggiungi motore",
            })
            .click();
          const modal = page.getByRole("dialog");
          await modal
            .getByRole("tab", {
              name: language === "en" ? "API key" : "Chiave API",
            })
            .click();
          if (canSave) {
            await expect(modal.locator("input[type=password]")).toBeVisible();
            await expect(modal.getByRole("combobox")).toBeVisible();
            await expect(modal.locator("button[type=submit]")).toBeDisabled();
            await modal.locator("input[type=password]").focus();
            await page.keyboard.press("Tab");
            await expect(
              modal.locator("input[type=password]"),
            ).not.toBeFocused();
          } else {
            await expect(modal.locator("input[type=password]")).toHaveCount(0);
            await expect(
              modal.getByText(
                language === "en"
                  ? /Secure key storage is unavailable/
                  : /archiviazione sicura delle chiavi non è disponibile/,
              ),
            ).toBeVisible();
          }
          const modalAudit = await new AxeBuilder({ page })
            .setLegacyMode(true)
            .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
            .analyze();
          expect(modalAudit.violations).toEqual([]);
          await page.screenshot({
            path: `.shots/m15-engine-add-${canSave ? "form-" : ""}${language}-${theme}.png`,
            fullPage: true,
          });
          await page.locator(".ant-modal-close").click();
        }
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
});
