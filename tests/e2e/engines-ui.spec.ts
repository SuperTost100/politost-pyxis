import AxeBuilder from "@axe-core/playwright";
import { _electron as electron, expect, test } from "@playwright/test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
    // Whatever engines this computer has, their notice is already confirmed, so no dialog covers the screen.
    await page.evaluate(() =>
      window.pyxis.invoke("engines.acknowledge", {
        providers: ["claude", "codex", "agent", "antigravity"],
      }),
    );
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
              localStorage.setItem("pyxis.engines.advanced", "1");
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
          // Every function starts automatic. Nothing is pinned on a fresh profile.
          await expect(
            page.getByRole("button", {
              name:
                language === "en"
                  ? "Back to automatic choice"
                  : "Torna alla scelta automatica",
            }),
          ).toBeDisabled();
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

test("Automatic engines: simple view names who does what, and advanced can pin and return to automatic", async () => {
  // The stand-in CLIs are POSIX shell scripts. Windows still runs the selection policy in the unit tests.
  test.skip(process.platform === "win32", "stand-in CLIs are shell scripts");
  test.setTimeout(180000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-engine-auto-"));
  const bin = mkdtempSync(join(tmpdir(), "pyxis-engine-bin-"));
  // Stand-ins for the two CLIs: they report a version and a signed-in account, nothing more.
  const fake = (name: string, body: string) => {
    const path = join(bin, name);
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);
    return path;
  };
  const env = {
    ...process.env,
    PYXIS_USER_DATA: userData,
    PYXIS_E2E: "1",
    // Only the two stand-ins exist: engines installed on this computer must not show up.
    HOME: bin,
    PATH: "/usr/bin:/bin",
    CLI_FUNNEL_NO_SHELL_PATH: "1",
    CLI_FUNNEL_CLAUDE_BIN: fake(
      "claude",
      `case "$1" in --version) echo "2.1.0";; auth) echo '{"loggedIn":true,"authMethod":"claude.ai"}';; esac`,
    ),
    CLI_FUNNEL_CODEX_BIN: fake(
      "codex",
      `case "$1" in --version) echo "codex-cli 0.150.0";; login) echo "Logged in using ChatGPT";; *) exit 1;; esac`,
    ),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({
    args: [join(process.cwd(), "out/main/index.js")],
    env,
  });
  try {
    const page = await app.firstWindow();
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.getByRole("button", { name: "Salta" }).click();
    // Skipping setup navigates to Exams on its own; wait for it so it cannot override the next route.
    await page.waitForFunction(() => location.hash.startsWith("#/exams"));
    await page.evaluate(() => {
      localStorage.setItem("pyxis.lang", "en");
      localStorage.removeItem("pyxis.engines.advanced");
      location.hash = "/settings/engines";
    });
    await page.reload();
    // Engines that are ready but not acknowledged get their notice here, and take no part in the plan before it.
    const notice = page.getByRole("dialog", { name: "What leaves this computer" });
    await expect(notice).toBeVisible({ timeout: 30000 });
    await expect(notice.getByText("Claude Code sends them to Anthropic.")).toBeVisible();
    await expect(page.locator(".engines-summary")).toHaveCount(0);
    await notice.getByRole("button", { name: "I understand" }).click();
    await expect(notice).toHaveCount(0);
    await expect(page.locator(".engines-summary")).toContainText(
      "Pyxis uses Codex for chat, maps and grading and Claude Code for plans, lessons and photos.",
      { timeout: 30000 },
    );
    await expect(page.locator(".engines-list .px-engine")).toHaveCount(2);
    await expect(page.locator(".engines-feature-row")).toHaveCount(0);
    await page.getByRole("switch", { name: "Advanced options" }).click();
    await expect(page.locator(".engines-feature-row")).toHaveCount(7);
    await expect(page.locator(".engines-list .px-engine")).toHaveCount(4);
    const chat = page
      .locator(".engines-feature-row")
      .filter({ has: page.locator('label[for="engine-chat"]') })
      .locator(".ant-select");
    await expect(chat).toContainText("Automatic");
    await expect(page.locator(".engines-auto-model").first()).toBeVisible();
    // Pin chat to a Claude model, then return everything to automatic.
    await page.getByRole("combobox", { name: "Chat" }).click();
    await page
      .locator(".ant-select-item-option")
      .filter({ hasText: /claude · /i })
      .first()
      .click();
    await expect(chat).not.toContainText("Automatic");
    const back = page.getByRole("button", {
      name: "Back to automatic choice",
    });
    await expect(back).toBeEnabled();
    await back.click();
    await expect(chat).toContainText("Automatic");
    await expect(back).toBeDisabled();
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
  }
});

test("Automatic engines: with all four CLIs ready, the summary gives each engine its own line", async () => {
  // The stand-in CLIs are POSIX shell scripts. Windows still runs the selection policy in the unit tests.
  test.skip(process.platform === "win32", "stand-in CLIs are shell scripts");
  test.setTimeout(180000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-engine-four-"));
  const bin = mkdtempSync(join(tmpdir(), "pyxis-engine-bin-"));
  const fake = (name: string, body: string) => {
    const path = join(bin, name);
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);
    return path;
  };
  const env = {
    ...process.env,
    PYXIS_USER_DATA: userData,
    PYXIS_E2E: "1",
    // Antigravity counts as signed in with a Gemini key and a model list.
    GEMINI_API_KEY: "test-key",
    CLI_FUNNEL_CLAUDE_BIN: fake(
      "claude",
      `case "$1" in --version) echo "2.1.0";; auth) echo '{"loggedIn":true,"authMethod":"claude.ai"}';; esac`,
    ),
    CLI_FUNNEL_CODEX_BIN: fake(
      "codex",
      `case "$1" in --version) echo "codex-cli 0.150.0";; login) echo "Logged in using ChatGPT";; *) exit 1;; esac`,
    ),
    CLI_FUNNEL_AGENT_BIN: fake(
      "agent",
      `case "$1" in
  --version) echo "2026.09.28-64d2043";;
  status) echo '{"isAuthenticated":true}';;
  about) echo '{}';;
  --list-models) printf 'gemini-3.8-flash - Gemini 3.8 Flash\\nclaude-sonnet-5-5 - Claude Sonnet 5.5\\nclaude-opus-5-5 - Claude Opus 5.5\\ngpt-5.6-sol - GPT-5.6 Sol\\n';;
esac`,
    ),
    CLI_FUNNEL_AGY_BIN: fake(
      "agy",
      `case "$1" in
  --version) echo "1.3.0";;
  models) printf 'gemini-3.8-flash\\tGemini 3.8 Flash\\ngemini-3.1-pro\\tGemini 3.1 Pro\\n';;
esac`,
    ),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({
    args: [join(process.cwd(), "out/main/index.js")],
    env,
  });
  try {
    const page = await app.firstWindow();
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.getByRole("button", { name: "Salta" }).click();
    await page.waitForFunction(() => location.hash.startsWith("#/exams"));
    await page.evaluate(() => {
      localStorage.setItem("pyxis.lang", "en");
      localStorage.removeItem("pyxis.engines.advanced");
      location.hash = "/settings/engines";
    });
    await page.reload();
    const notice = page.getByRole("dialog", { name: "What leaves this computer" });
    await expect(notice).toBeVisible({ timeout: 30000 });
    await notice.getByRole("button", { name: "I understand" }).click();
    const summary = page.locator(".engines-summary");
    await expect(summary).toContainText(
      "Pyxis splits the work across 4 engines:",
      { timeout: 30000 },
    );
    const lines = summary.locator(".engines-summary-split li");
    await expect(lines).toHaveCount(4);
    for (const name of ["Claude Code", "Codex", "Cursor Agent", "Antigravity"])
      await expect(lines.filter({ hasText: name })).toHaveCount(1);
    await expect(lines.filter({ hasText: "Antigravity" })).toContainText(
      "chat",
    );
    await page.screenshot({ path: ".shots/engines-four-en.png" });
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
  }
});
