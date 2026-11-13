import { expect, test } from "@playwright/test";
import {
  chmodSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchPyxis } from "./app-under-test";
import { expectNoAxeViolations } from "./axe";
import { saveShot } from "./shots";
import { removeTestFolder } from "./cleanup";
import { fromChiediToExams } from "./doors";

test("ENG-10 engine details, add paths and secure key-storage notice in both themes and languages", async () => {
  test.setTimeout(180000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-engine-ui-"));
  const app = await launchPyxis({ userData });
  try {
    const page = await app.firstWindow();
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.getByRole("button", { name: "Salta" }).click();
    // Skipping saves the profile, then moves to Chiedi; wait so a reload or route change cannot land on setup.
    await fromChiediToExams(page);
    // Whatever engines this computer has, their notice is already confirmed, so no dialog covers the screen.
    await page.evaluate(() =>
      window.pyxis.invoke("engines.acknowledge", {
        providers: ["claude", "codex", "agent", "antigravity"],
      }),
    );
    // Exercise both keyring states without entering, storing or sending any key.
    for (const language of ["en", "it"] as const)
      for (const theme of ["light", "dark"] as const)
        for (const canSave of [false, true]) {
          await app.evaluate(({ safeStorage }, enabled) => {
            const probes = globalThis as { keyringProbes?: number };
            probes.keyringProbes = 0;
            safeStorage.isEncryptionAvailable = () => {
              probes.keyringProbes! += 1;
              return enabled;
            };
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
          await expect(page.locator(".engines-feature-row")).toHaveCount(8);
          // The engine for each function starts closed; it opens on its heading.
          const perFeature = page.locator(".engines-section");
          await expect(perFeature).not.toHaveAttribute("open");
          await perFeature.locator("summary").click();
          await expect(perFeature).toHaveAttribute("open", "");
          // Each task has its own reasoning effort next to its model.
          await expect(
            page.getByRole("combobox", {
              name:
                language === "en"
                  ? "Chat: Reasoning effort"
                  : "Chat: Livello di ragionamento",
            }),
          ).toBeVisible();
          await expect(page.locator('[id^="engine-effort-"]')).toHaveCount(8);
          // CLI Funnel enforces text-only access for every offered engine, so none is disabled.
          for (const name of ["Cursor", "Gemini"])
            await expect(
              page.locator(".engines-list .engines-row", { hasText: name }),
            ).toHaveCount(1);
          await expect(page.locator(".engines-row.is-disabled")).toHaveCount(0);
          // A row reads by the tool's name, and the program behind it shows once, as the detail under it: it is what the
          // student installs or signs in to.
          const gemini = page.locator(".engines-list .engines-row", { hasText: "Gemini" });
          await expect(gemini.locator(".px-engine-name")).toHaveText("Gemini");
          await expect(gemini.locator(".px-engine-model")).toHaveText("Antigravity");
          // Every function starts automatic. Nothing is pinned on a fresh profile.
          await expect(
            page.getByRole("button", {
              name:
                language === "en"
                  ? "Back to automatic choice"
                  : "Torna alla scelta automatica",
            }),
          ).toBeDisabled();
          // The row's visible words name the button; "Details for ..." is its description.
          const details = page.getByRole("button", { name: /^Claude/ });
          await details.click();
          const drawer = page.getByRole("dialog", {
            name: "Claude",
            exact: true,
          });
          await expect(drawer).toBeVisible();
          await expect(
            drawer.getByRole("combobox", {
              name: language === "en" ? "Model" : "Modello",
            }),
          ).toBeVisible();
          await expectNoAxeViolations(page, { tags: ["wcag2a", "wcag2aa", "wcag21aa"] });
          await saveShot(page, `m15-engine-details-${language}-${theme}.png`, { fullPage: true });
          await drawer
            .getByRole("button", { name: /Close|Chiudi/, exact: true })
            .click();
          // Each row's action names its engine, so a screen reader can tell the buttons apart.
          await expect(
            page.getByRole("button", {
              name: /^(Install|Test|Sign in|Installa|Prova|Accedi) Gemini$/,
            }),
          ).toHaveCount(1);
          // Antigravity has no sign-out command: the drawer says how to sign out instead of offering a button that fails.
          await page
            .getByRole("button", { name: /^Gemini/ })
            .click();
          const agy = page.getByRole("dialog", {
            name: "Gemini",
            exact: true,
          });
          await expect(
            agy.getByText(
              language === "en"
                ? /no sign-out command/
                : /non ha un comando per uscire/,
            ),
          ).toBeVisible();
          await expect(
            agy.getByRole("button", {
              name: language === "en" ? "Sign out" : "Esci dall'account",
            }),
          ).toHaveCount(0);
          await agy
            .getByRole("button", { name: /Close|Chiudi/, exact: true })
            .click();
          await page
            .getByRole("button", {
              name: language === "en" ? "Add AI tool" : "Aggiungi strumento AI",
            })
            .click();
          const modal = page.getByRole("dialog");
          await modal
            .getByRole("tab", {
              name: language === "en" ? "API key" : "Chiave API",
            })
            .click();
          // macOS always has a Keychain, and asking it would bring up the password prompt, so the form shows unasked.
          const darwin = process.platform === "darwin";
          if (darwin)
            expect(
              await app.evaluate(() => (globalThis as { keyringProbes?: number }).keyringProbes),
            ).toBe(0);
          if (canSave || darwin) {
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
          await expectNoAxeViolations(page, { tags: ["wcag2a", "wcag2aa", "wcag21aa"] });
          await saveShot(page, `m15-engine-add-${canSave ? "form-" : ""}${language}-${theme}.png`, { fullPage: true });
          await page.locator(".ant-modal-close").click();
        }
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});

test("Automatic engines: simple view says it in one sentence, and advanced can pin and return to automatic", async () => {
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
  const app = await launchPyxis({ userData, env });
  try {
    const page = await app.firstWindow();
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.getByRole("button", { name: "Salta" }).click();
    // Skipping saves the profile, then moves to Chiedi; wait so a reload or route change cannot land on setup.
    await expect(page).toHaveURL(/#\/ask$/);
    await page.evaluate(() => {
      localStorage.setItem("pyxis.lang", "en");
      localStorage.removeItem("pyxis.engines.advanced");
      location.hash = "/settings/engines";
    });
    await page.reload();
    // Engines that are ready but not acknowledged get their notice here, and take no part in the plan before it.
    const notice = page.getByRole("dialog", { name: "What leaves this computer" });
    await expect(notice).toBeVisible({ timeout: 30000 });
    await expect(notice.getByText("Claude sends them to Anthropic.")).toBeVisible();
    await expect(page.locator(".engines-summary")).toHaveCount(0);
    await notice.getByRole("button", { name: "I understand" }).click();
    await expect(notice).toHaveCount(0);
    // One plain sentence, with the engines' names and no list of which does what.
    await expect(page.locator(".engines-summary-body")).toHaveText(
      "Automatic choicePyxis picks the right tool for each job by itself, out of ChatGPT and Claude, and uses the cheapest model that is good enough.",
      { timeout: 30000 },
    );
    await expect(page.locator(".engines-list .px-engine")).toHaveCount(2);
    await expect(page.locator(".engines-feature-row")).toHaveCount(0);
    // Which engines Pyxis may use waits under Advanced options, and the week's tokens under debug mode.
    const choice = page.getByRole("radiogroup", { name: "Which AI tools Pyxis may use" });
    const week = page.getByRole("region", { name: "This week" });
    await expect(choice).toHaveCount(0);
    await expect(week).toHaveCount(0);
    await saveShot(page, "engines-simple-en.png", { fullPage: true });
    await page.getByRole("switch", { name: "Advanced options" }).click();
    await expect(page.locator(".engines-feature-row")).toHaveCount(8);
    await expect(choice).toBeVisible();
    await expect(choice.getByRole("radio", { name: /^Automatic/ })).toBeChecked();
    await expect(week).toHaveCount(0);
    await page.getByRole("switch", { name: "Show technical details and debug" }).click();
    await expect(week).toBeVisible();
    await saveShot(page, "engines-debug-en.png", { fullPage: true });
    // Debug mode alone keeps the table, with the advanced options closed.
    await page.getByRole("switch", { name: "Advanced options" }).click();
    await expect(choice).toHaveCount(0);
    await expect(week).toBeVisible();
    await page.getByRole("switch", { name: "Advanced options" }).click();
    // The table sits in a section that starts closed.
    await page.locator(".engines-section > summary").click();
    await expect(page.locator(".engines-list .px-engine")).toHaveCount(4);
    // Advanced options add no second primary button: Add engine is a secondary one.
    await expect(
      page.getByRole("button", { name: "Add AI tool" }),
    ).not.toHaveClass(/ant-btn-primary/);
    const chat = page
      .locator(".engines-feature-row")
      .filter({ has: page.locator('label[for="engine-chat"]') })
      .locator(".engines-feature-model .ant-select");
    await expect(chat).toContainText("Automatic");
    await expect(page.locator(".engines-auto-model").first()).toBeVisible();
    // Every task starts at its own reasoning level: low for chat, high for exams.
    const effortOf = (task: string) =>
      page.getByRole("combobox", { name: `${task}: Reasoning effort` });
    await expect(effortOf("Chat")).toBeEnabled();
    await expect(
      page.locator(".engines-feature-effort", { has: effortOf("Chat") }),
    ).toContainText("Automatic · Low");
    await expect(
      page.locator(".engines-feature-effort", { has: effortOf("Exams") }),
    ).toContainText("Automatic · High");
    // The student's pick is kept, and shows after a reload of the stored choices.
    await effortOf("Exams").click();
    await page
      .locator(".ant-select-item-option")
      .filter({ hasText: /^Maximum$/ })
      .click();
    await expect(
      page.locator(".engines-feature-effort", { has: effortOf("Exams") }),
    ).toContainText("Maximum");
    const stored = await page.evaluate(
      () => window.pyxis.invoke("engines.features", {}) as Promise<Record<string, { effort?: string; effortChoice?: string }>>,
    );
    expect(stored.plan).toMatchObject({ effort: "max", effortChoice: "max" });
    // Pin chat to a Claude model, then return everything to automatic.
    await page.getByRole("combobox", { name: "Chat", exact: true }).click();
    // Models are named with their engine as the student knows it, never with an internal id such as "claude".
    const options = page.locator(".ant-select-item-option");
    await expect(options.filter({ hasText: /^Claude · / }).first()).toBeVisible();
    await expect(options.filter({ hasText: /^(claude|codex|agent) · / })).toHaveCount(0);
    await options.filter({ hasText: /^Claude · / }).first().click();
    await expect(chat).not.toContainText("Automatic");
    const back = page.getByRole("button", {
      name: "Back to automatic choice",
    });
    await expect(back).toBeEnabled();
    await back.click();
    await expect(chat).toContainText("Automatic");
    await expect(back).toBeDisabled();
    // Back to automatic also returns the efforts to the tasks' own levels.
    await expect(
      page.locator(".engines-feature-effort", { has: effortOf("Exams") }),
    ).toContainText("Automatic · High");
  } finally {
    await app.close();
    removeTestFolder(userData);
    rmSync(bin, { recursive: true, force: true });
  }
});

test("Automatic engines: with all four CLIs ready, the summary names each engine in one sentence", async () => {
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
  const app = await launchPyxis({ userData, env });
  try {
    const page = await app.firstWindow();
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.getByRole("button", { name: "Salta" }).click();
    // Skipping saves the profile, then moves to Chiedi; wait so a reload or route change cannot land on setup.
    await expect(page).toHaveURL(/#\/ask$/);
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
    await expect(summary).toContainText("Pyxis picks the right tool for each job by itself, out of ", {
      timeout: 30000,
    });
    // Four engines still make one sentence that names each of them, with no line per engine.
    for (const name of ["Claude", "ChatGPT", "Cursor", "Gemini"])
      await expect(summary).toContainText(name);
    await expect(summary.locator("li")).toHaveCount(0);
    await expect(summary).not.toContainText("chat");
    await saveShot(page, "engines-four-en.png");
  } finally {
    await app.close();
    removeTestFolder(userData);
    rmSync(bin, { recursive: true, force: true });
  }
});

test("Settings: a test the provider refuses turns the engine to an expired sign-in, names it, offers sign-in and takes it out of the plan", async () => {
  // The stand-in CLIs are POSIX shell scripts. Windows still runs the readiness rules in the unit tests.
  test.skip(process.platform === "win32", "stand-in CLIs are shell scripts");
  test.setTimeout(180000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-engine-refused-"));
  const bin = mkdtempSync(join(tmpdir(), "pyxis-engine-bin-"));
  const fake = (name: string, body: string) => {
    const path = join(bin, name);
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);
    return path;
  };
  const env = {
    HOME: bin,
    PATH: "/usr/bin:/bin",
    CLI_FUNNEL_NO_SHELL_PATH: "1",
    CLI_FUNNEL_CLAUDE_BIN: fake(
      "claude",
      `case "$1" in --version) echo "2.1.0";; auth) echo '{"loggedIn":true,"authMethod":"claude.ai"}';; esac`,
    ),
    // Cursor Agent's own check keeps saying "signed in" while its provider answers every call with 401.
    CLI_FUNNEL_AGENT_BIN: fake(
      "agent",
      `case "$1" in
  --version) echo "2026.09.28-64d2043";;
  status) echo '{"isAuthenticated":true}';;
  about) echo '{}';;
  --list-models) printf 'gemini-3.8-flash - Gemini 3.8 Flash\\n';;
  *) echo "Error: request failed with status 401 Unauthorized" >&2; exit 1;;
esac`,
    ),
  };
  const app = await launchPyxis({ userData, env });
  try {
    const page = await app.firstWindow();
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.getByRole("button", { name: "Salta" }).click();
    await expect(page).toHaveURL(/#\/ask$/);
    await page.evaluate(async () => {
      await window.pyxis.invoke("engines.acknowledge", {
        providers: ["claude", "agent"],
      });
      localStorage.setItem("pyxis.lang", "en");
      localStorage.removeItem("pyxis.engines.advanced");
      location.hash = "/settings/engines";
    });
    await page.reload();
    const row = (name: string) =>
      page.locator(".engines-list .px-engine", { hasText: name });
    await expect(row("Cursor")).toContainText("Ready", { timeout: 30000 });
    await expect(page.locator(".engines-summary")).toContainText("Cursor", {
      timeout: 30000,
    });

    await page.getByRole("button", { name: "Test Cursor" }).click();
    // The message names the engine and offers its sign-in here, instead of sending the student to the page they are on.
    await expect(
      page.getByText(
        "Cursor refused the sign-in, which has probably expired. Pyxis won't use it until you sign in again.",
      ),
    ).toBeVisible({ timeout: 30000 });
    await expect(page.getByText(/Settings, AI tools/)).toHaveCount(0);
    await expect(row("Cursor")).toContainText("Sign-in expired");
    await expect(row("Cursor")).not.toContainText("Ready");
    await expect(page.locator(".engines-summary")).not.toContainText(
      "Cursor",
      { timeout: 30000 },
    );
    expect(
      Object.values(
        await page.evaluate(() => window.pyxis.invoke("engines.features", {})),
      ).map((selection) => selection.provider),
    ).not.toContain("agent");
    await expectNoAxeViolations(page, {
      tags: ["wcag2a", "wcag2aa", "wcag21aa"],
    });
    await saveShot(page, "engines-refused-en.png", { fullPage: true });
    await page.getByRole("button", { name: "Sign in to Cursor" }).click();
    await expect(
      page.getByRole("dialog", { name: "Set up Cursor" }),
    ).toBeVisible();
    await page.keyboard.press("Escape");

    // A task screen says the same: a chat pinned to Cursor Agent names it and opens its sign-in, instead of pointing
    // at Settings in words.
    await page.evaluate(() =>
      window.pyxis.invoke("engines.setFeature", {
        feature: "chat",
        provider: "agent",
        model: "gemini-3.8-flash",
      }),
    );
    await page.evaluate(() => {
      location.hash = "/ask";
    });
    const box = page.getByRole("textbox", { name: "Message" });
    await box.fill("What is a vector?");
    await box.press("Enter");
    const named = page.getByText(
      "Cursor refused the sign-in, which has probably expired. Pyxis won't use it until you sign in again.",
    );
    await expect(named.first()).toBeVisible({ timeout: 30000 });
    await expect(page.getByText(/Sign in again in Settings, AI tools/)).toHaveCount(0);
    await expectNoAxeViolations(page, {
      tags: ["wcag2a", "wcag2aa", "wcag21aa"],
    });
    await page
      .getByRole("button", { name: "Sign in to Cursor" })
      .first()
      .click();
    await expect(page).toHaveURL(/#\/settings\/engines$/);
    await expect(
      page.getByRole("dialog", { name: "Set up Cursor" }),
    ).toBeVisible();
  } finally {
    await app.close();
    removeTestFolder(userData);
    rmSync(bin, { recursive: true, force: true });
  }
});

test("Settings: a model the subscription refuses keeps the engine, but the row says so and the plan moves to the model the refusal names", async () => {
  test.skip(process.platform === "win32", "stand-in CLIs are shell scripts");
  test.setTimeout(180000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-engine-model-"));
  const bin = mkdtempSync(join(tmpdir(), "pyxis-engine-bin-"));
  const fake = (name: string, body: string) => {
    const path = join(bin, name);
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);
    return path;
  };
  const env = {
    HOME: bin,
    PATH: "/usr/bin:/bin",
    CLI_FUNNEL_NO_SHELL_PATH: "1",
    // Cursor Agent signed in on a plan whose weekly usage covers only Grok, as in the walkthrough.
    CLI_FUNNEL_AGENT_BIN: fake(
      "agent",
      `case "$1" in
  --version) echo "2026.10.22-27dcf5f";;
  status) echo '{"isAuthenticated":true}';;
  about) echo '{}';;
  --list-models) printf 'gemini-3.8-flash-low - Gemini 3.8 Flash Low\\ngemini-3.8-flash-high - Gemini 3.8 Flash High\\nclaude-opus-5-5-high - Claude Opus 5.5 1M High\\ngrok-4.7-low - Grok 4.7  Low\\ngrok-4.7-high - Grok 4.7  High\\n';;
  *)
    # Grok answers; every other model is outside the plan.
    case "$*" in
      *grok-4.7*) cat >/dev/null; printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"result":"ok"}';;
      *) echo "ActionRequiredError: Gemini 3.8 Flash is not included in your weekly usage Buy credits or switch to a Grok model to continue." >&2; exit 1;;
    esac;;
esac`,
    ),
  };
  const app = await launchPyxis({ userData, env });
  try {
    const page = await app.firstWindow();
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.getByRole("button", { name: "Salta" }).click();
    await expect(page).toHaveURL(/#\/ask$/);
    await page.evaluate(async () => {
      await window.pyxis.invoke("engines.acknowledge", { providers: ["agent"] });
      localStorage.setItem("pyxis.lang", "en");
      localStorage.removeItem("pyxis.engines.advanced");
      location.hash = "/settings/engines";
    });
    await page.reload();
    const row = page.locator(".engines-list .px-engine", { hasText: "Cursor" });
    await expect(row).toContainText("Ready", { timeout: 30000 });
    // The row names the models the plan gives the engine, never their ids.
    await expect(row).toContainText("Claude Opus 5.5", { timeout: 30000 });
    await expect(row).not.toContainText("claude-opus-5-5");

    await page.getByRole("button", { name: "Test Cursor" }).click();
    await expect(
      page.getByText("Your Cursor subscription doesn't include the chosen model."),
    ).toBeVisible({ timeout: 30000 });
    await expect(row).toContainText("Ready, with limits");
    await expect(row).toContainText("Gemini 3.8 Flash isn't in your subscription");
    // The refusal said to switch to a Grok model, so every task Pyxis chose moves there.
    await expect
      .poll(
        async () => [
          ...new Set(
            Object.values(
              await page.evaluate(() => window.pyxis.invoke("engines.features", {})),
            ).map((selection) => selection.model),
          ),
        ],
        { timeout: 30000 },
      )
      .toEqual(["grok-4.7"]);
    await expect(row).toContainText("Grok 4.7");
    await expectNoAxeViolations(page, { tags: ["wcag2a", "wcag2aa", "wcag21aa"] });
    await saveShot(page, "engines-model-refused-en.png", { fullPage: true });
    // The next Prova skips the refused model, answers on Grok and names it as the engine lists it.
    await page.getByRole("button", { name: "Test Cursor" }).click();
    await expect(page.locator(".engines-result")).toContainText("Grok 4.7", { timeout: 30000 });
    await expect(page.locator(".engines-result")).not.toContainText("grok-4.7");
  } finally {
    await app.close();
    removeTestFolder(userData);
    rmSync(bin, { recursive: true, force: true });
  }
});
