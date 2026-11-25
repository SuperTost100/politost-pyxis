import { expect, test, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { launchPyxis } from "./app-under-test";
import { expectNoAxeViolations } from "./axe";
import { saveShot } from "./shots";
import { removeTestFolder } from "./cleanup";
import { standInTools } from "./tools";
import { clickSettled } from "./settled";

/** A connected tool's row in the list, by the id Pyxis knows the tool by. */
const tool = (page: Page, id: string) => page.locator(`.engines-tool[data-tool="${id}"]`);

/** Opens a tool's menu from its three dots and picks an item. */
async function choose(page: Page, name: string, item: string | RegExp) {
  await page.getByRole("button", { name: new RegExp(`^(Azioni su|Actions on) ${name}$`) }).click();
  await page
    .getByRole("region", { name: new RegExp(`^(Azioni su|Actions on) ${name}$`) })
    .getByRole("menuitem", { name: item })
    .click();
}

/** The words of the option a native picker shows. */
const picked = (select: Locator) => select.evaluate((node: HTMLSelectElement) => node.selectedOptions[0]?.label ?? "");

test("ENG-10 tool details, the key dialog and the secure key-storage notice in both themes and languages", async () => {
  // The stand-in tools are POSIX shell scripts. Windows runs the panel's rules in the unit tests.
  test.skip(process.platform === "win32", "stand-in tools are shell scripts");
  test.setTimeout(180000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-engine-ui-"));
  const tools = standInTools(["claude", "codex", "antigravity"]);
  const app = await launchPyxis({ userData, env: tools.env });
  try {
    const page = await app.firstWindow();
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.getByRole("button", { name: "Salta" }).click();
    // Skipping saves the profile, then moves to Chiedi; wait so a reload or route change cannot land on setup.
    await expect(page).toHaveURL(/#\/ask$/);
    // The tools' notice is already confirmed, so no dialog covers the screen.
    await page.evaluate(() =>
      window.pyxis.invoke("engines.acknowledge", {
        providers: ["claude", "codex", "antigravity"],
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
              localStorage.removeItem("pyxis.engines.advanced");
              await window.pyxis.setAppearance(theme);
              location.hash = "/settings/engines";
            },
            { language, theme },
          );
          await page.reload();
          await expect(page.locator(".engines-tools .engines-tool")).toHaveCount(3, { timeout: 30000 });
          // Every tool is connected, so nothing waits to be connected.
          await expect(
            page.getByRole("region", {
              name: language === "en" ? "To connect" : "Da collegare",
            }),
          ).toHaveCount(0);
          // Advanced is open until the student closes it, and the model of each kind of work is there under its heading.
          await expect(page.locator(".engines-advanced")).toHaveAttribute(
            "open",
            "",
          );
          await expect(
            page.getByRole("heading", {
              name:
                language === "en"
                  ? "Model for each kind of work"
                  : "Modello per tipo di lavoro",
            }),
          ).toBeVisible();
          await expect(page.locator(".engines-feature-row")).toHaveCount(8);
          // Each task has its own reasoning effort next to its model.
          await expect(
            page.getByRole("combobox", {
              name: language === "en" ? "Chat: Reasoning effort" : "Chat: Livello di ragionamento",
            }),
          ).toBeVisible();
          await expect(page.locator('[id^="engine-effort-"]')).toHaveCount(8);
          // A row reads by the tool's name and says its three roles, each with the model it runs.
          for (const [id, name] of [
            ["claude", "Claude"],
            ["codex", "ChatGPT"],
            ["antigravity", "Gemini"],
          ] as const) {
            await expect(
              tool(page, id).locator(".engines-tool-name"),
            ).toHaveText(name);
            await expect(
              tool(page, id).locator("[data-roles] [data-role]"),
              `${language}, ${name}`,
            ).toHaveCount(3);
          }
          // Every function starts automatic. Nothing is pinned on a fresh profile, so the page says so and offers no
          // control to undo what was never done.
          await expect(
            page.getByRole("button", {
              name:
                language === "en"
                  ? "Reset all to Automatic"
                  : "Riporta tutto su Automatico",
            }),
          ).toHaveCount(0);
          await expect(
            page.getByText(language === "en" ? "Everything automatic" : "Tutto automatico"),
          ).toBeVisible();
          // A tool's details open from its menu, on the dots as on a right-click.
          await choose(page, "Claude", language === "en" ? "Details" : "Dettagli");
          const details = page.getByRole("dialog", { name: "Claude", exact: true });
          await expect(details).toBeVisible();
          // The dialog names the program once, quietly, under the tool's name.
          await expect(details.getByText("Claude Code", { exact: true })).toBeVisible();
          await expect(
            details.getByRole("combobox", { name: language === "en" ? "Model" : "Modello" }),
          ).toBeVisible();
          await expectNoAxeViolations(page, { tags: ["wcag2a", "wcag2aa", "wcag21aa"] });
          await saveShot(page, `m15-engine-details-${language}-${theme}.png`, { fullPage: true });
          await details.getByRole("button", { name: /^(Close|Chiudi)$/ }).click();
          await expect(details).toHaveCount(0);
          // Each row's sign-out names its tool, so a screen reader can tell the buttons apart.
          await expect(
            page.getByRole("button", { name: language === "en" ? "Sign out of Claude" : "Scollega Claude" }),
          ).toHaveCount(1);
          // Antigravity has no sign-out command: its row offers no button that would fail, and its details say how to
          // sign out instead.
          await expect(
            page.getByRole("button", { name: language === "en" ? "Sign out of Gemini" : "Scollega Gemini" }),
          ).toHaveCount(0);
          await tool(page, "antigravity").locator(".engines-tool-name").click({ button: "right" });
          await clickSettled(
            page,
            page
              .getByRole("region", { name: /^(Azioni su|Actions on) Gemini$/ })
              .getByRole("menuitem", { name: language === "en" ? "Details" : "Dettagli" }),
          );
          const agy = page.getByRole("dialog", { name: "Gemini", exact: true });
          await expect(
            agy.getByText(language === "en" ? /no sign-out command/ : /non ha un comando per uscire/),
          ).toBeVisible();
          await clickSettled(page, agy.getByRole("button", { name: /^(Close|Chiudi)$/ }));
          await expect(agy).toHaveCount(0);

          // The API key has its row under Advanced.
          const add = page.getByRole("button", { name: language === "en" ? "Add a key" : "Aggiungi una chiave" });
          // macOS always has a Keychain, and asking it would bring up the password prompt, so the form shows unasked.
          const darwin = process.platform === "darwin";
          if (darwin)
            expect(
              await app.evaluate(() => (globalThis as { keyringProbes?: number }).keyringProbes),
            ).toBe(0);
          if (canSave || darwin) {
            await add.click();
            const modal = page.getByRole("dialog", { name: language === "en" ? "Add a key" : "Aggiungi una chiave" });
            await expect(modal.locator("input[type=password]")).toBeVisible();
            await expect(modal.getByRole("combobox")).toBeVisible();
            await expect(
              modal.getByRole("button", { name: language === "en" ? "Save and test" : "Salva e prova", exact: true }),
            ).toBeDisabled();
            await modal.locator("input[type=password]").focus();
            await page.keyboard.press("Tab");
            await expect(modal.locator("input[type=password]")).not.toBeFocused();
            await expectNoAxeViolations(page, { tags: ["wcag2a", "wcag2aa", "wcag21aa"] });
            await saveShot(page, `m15-engine-add-form-${language}-${theme}.png`, { fullPage: true });
            // The way out is the dialog's own Annulla, beside the key's button.
            await clickSettled(page, modal.getByRole("button", { name: /^(Cancel|Annulla)$/ }));
            await expect(modal).toHaveCount(0);
          } else {
            // Without a keyring the row says why no key can be saved, and offers no button that would fail.
            await expect(add).toHaveCount(0);
            await expect(
              page.getByText(
                language === "en"
                  ? /Secure key storage is unavailable/
                  : /archiviazione sicura delle chiavi non è disponibile/,
              ),
            ).toBeVisible();
            await expectNoAxeViolations(page, { tags: ["wcag2a", "wcag2aa", "wcag21aa"] });
            await saveShot(page, `m15-engine-add-${language}-${theme}.png`, { fullPage: true });
          }
        }
  } finally {
    await app.close();
    removeTestFolder(userData);
    rmSync(tools.bin, { recursive: true, force: true });
  }
});

test("Automatic engines: the page says it in one sentence, and Advanced can pin and return to automatic", async () => {
  // The stand-in CLIs are POSIX shell scripts. Windows still runs the selection policy in the unit tests.
  test.skip(process.platform === "win32", "stand-in CLIs are shell scripts");
  test.setTimeout(180000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-engine-auto-"));
  // Only the two stand-ins exist: engines installed on this computer must not show up.
  const tools = standInTools(["claude", "codex"]);
  const app = await launchPyxis({ userData, env: tools.env });
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
    const summary = page.locator(".engines-summary");
    await expect(summary).not.toContainText("ChatGPT");
    await clickSettled(page, notice.getByRole("button", { name: "I understand" }));
    await expect(notice).toHaveCount(0);
    // One plain sentence under the page's title, with the engines' names and no list of which does what.
    await expect(summary).toHaveText(
      "Pyxis picks the right tool for each job by itself, out of ChatGPT and Claude, and uses the cheapest model that is good enough.",
      { timeout: 30000 },
    );
    await expect(page.locator(".engines-tools .engines-tool")).toHaveCount(2);
    // The tools not on this computer wait under "To connect".
    const toConnect = page.getByRole("region", { name: "To connect" });
    for (const name of ["Gemini"])
      await expect(toConnect.getByRole("button", { name: `Install and sign in to ${name}` })).toBeVisible();
    // The model of each task waits under Advanced, and the week's tokens under debug mode.
    const advanced = page.locator(".engines-advanced");
    const week = page.getByRole("region", { name: "This week" });
    await expect(page.locator(".engines-feature-row")).toHaveCount(8);
    await expect(week).toHaveCount(0);
    await saveShot(page, "engines-simple-en.png", { fullPage: true });
    await page.getByRole("switch", { name: "Show technical details and debug" }).click();
    await expect(week).toBeVisible();
    await saveShot(page, "engines-debug-en.png", { fullPage: true });
    // Debug mode alone keeps the table, with Advanced closed.
    await advanced.locator("> summary").click();
    await expect(page.getByRole("switch", { name: "Show technical details and debug" })).toBeHidden();
    await expect(week).toBeVisible();
    await advanced.locator("> summary").click();
    // The kinds of work are under Advanced, which is open, with no section to open first.
    const chat = page.getByRole("combobox", { name: "Chat", exact: true });
    expect(await picked(chat)).toMatch(/^Automatic · today \S/);
    // Every task starts at its own reasoning level: medium for chat (Claude and ChatGPT run it in the balanced role), high for exams.
    const effortOf = (task: string) => page.getByRole("combobox", { name: `${task}: Reasoning effort` });
    await expect(effortOf("Chat")).toBeEnabled();
    expect(await picked(effortOf("Chat"))).toBe("Automatic · Medium");
    expect(await picked(effortOf("Exams"))).toBe("Automatic · High");
    // The student's pick is kept, and shows after a reload of the stored choices.
    await effortOf("Exams").selectOption({ label: "Maximum" });
    await expect.poll(() => picked(effortOf("Exams"))).toBe("Maximum");
    const stored = await page.evaluate(
      () => window.pyxis.invoke("engines.features", {}) as Promise<Record<string, { effort?: string; effortChoice?: string }>>,
    );
    expect(stored.plan).toMatchObject({ effort: "max", effortChoice: "max" });
    // Pin chat to a Claude model, then return everything to automatic. Models are named with their engine as the
    // student knows it, never with an internal id such as "claude".
    const groups = await chat
      .locator("optgroup")
      .evaluateAll((nodes) =>
        nodes.map((node) => (node as HTMLOptGroupElement).label),
      );
    expect(groups).toEqual(["Claude", "ChatGPT"]);
    const claudeModel = await chat
      .locator('optgroup[label="Claude"] option')
      .first()
      .textContent();
    expect(claudeModel).toBeTruthy();
    expect(await chat.locator("option").allTextContents()).not.toContainEqual(
      expect.stringMatching(/^(claude|codex|antigravity)[-:]/),
    );
    await chat.selectOption({ label: claudeModel! });
    await expect.poll(() => picked(chat)).toBe(claudeModel);
    // A pinned field is tinted, and the heading counts what is pinned.
    await expect(chat).toHaveClass(/is-pinned/);
    await expect(page.getByText("1 pinned by you")).toBeVisible();
    // The list says a task is set by hand, so the order alone does not explain where chat goes.
    await expect(
      page.getByText("1 feature is pinned by hand under Advanced."),
    ).toBeVisible();
    const back = page.getByRole("button", {
      name: "Reset all to Automatic",
    });
    await expect(back).toBeEnabled();
    await back.click();
    await expect.poll(() => picked(chat)).toMatch(/^Automatic · today \S/);
    await expect(chat).not.toHaveClass(/is-pinned/);
    await expect(page.getByText("Everything automatic")).toBeVisible();
    // Nothing is pinned any more: the statement stays and the button is gone, not disabled.
    await expect(back).toHaveCount(0);
    // Back to automatic also returns the efforts to the tasks' own levels.
    await expect.poll(() => picked(effortOf("Exams"))).toBe("Automatic · High");
  } finally {
    await app.close();
    removeTestFolder(userData);
    rmSync(tools.bin, { recursive: true, force: true });
  }
});

test("Automatic engines: with all three CLIs ready, the summary names each engine in one sentence", async () => {
  // The stand-in CLIs are POSIX shell scripts. Windows still runs the selection policy in the unit tests.
  test.skip(process.platform === "win32", "stand-in CLIs are shell scripts");
  test.setTimeout(180000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-engine-four-"));
  const tools = standInTools(["claude", "codex", "antigravity"]);
  const app = await launchPyxis({ userData, env: tools.env });
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
    await clickSettled(page, notice.getByRole("button", { name: "I understand" }));
    const summary = page.locator(".engines-summary");
    await expect(summary).toContainText("Pyxis picks the right tool for each job by itself, out of ", {
      timeout: 30000,
    });
    // Three engines still make one sentence that names each of them, with no line per engine.
    for (const name of ["Claude", "ChatGPT", "Gemini"])
      await expect(summary).toContainText(name);
    await expect(summary.locator("li")).toHaveCount(0);
    await expect(summary).not.toContainText("chat");
    await saveShot(page, "engines-three-en.png");
  } finally {
    await app.close();
    removeTestFolder(userData);
    rmSync(tools.bin, { recursive: true, force: true });
  }
});

test("A tool confirmed before the notice named the student's results gets the notice once more, which names them", async () => {
  // The stand-in CLIs are POSIX shell scripts. Windows still runs the notice's versions in the unit tests.
  test.skip(process.platform === "win32", "stand-in CLIs are shell scripts");
  test.setTimeout(180000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-engine-notice-results-"));
  const tools = standInTools(["claude"]);
  const app = await launchPyxis({ userData, env: tools.env });
  try {
    const page = await app.firstWindow();
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.getByRole("button", { name: "Salta" }).click();
    await expect(page).toHaveURL(/#\/ask$/);
    // Claude was confirmed with the notice of an earlier version, which stored `true`.
    const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), { timeout: 10000 });
    db.prepare("INSERT OR REPLACE INTO settings (key, value_json, updated_at) VALUES ('engine-disclosure:claude', 'true', 1)").run();
    db.close();
    await page.evaluate(() => {
      location.hash = "/settings/engines";
    });
    await page.reload();
    const notice = page.getByRole("dialog", { name: "Cosa esce da questo computer" });
    await expect(notice).toBeVisible({ timeout: 30000 });
    await expect(notice).toContainText("quando chiedi dei tuoi risultati, i voti dei quiz e lo stato degli argomenti di quell'esame");
    await expect(notice.getByText("Claude li invia ad Anthropic.")).toBeVisible();
    await saveShot(page, "engines-notice-results-it.png");
    await clickSettled(page, notice.getByRole("button", { name: "Ho capito" }));
    await expect(notice).toHaveCount(0);
    const stored = new DatabaseSync(join(userData, "workspace", "pyxis.db"), { timeout: 10000 });
    try {
      expect(stored.prepare("SELECT value_json FROM settings WHERE key = 'engine-disclosure:claude'").get()).toEqual({ value_json: "2" });
    } finally {
      stored.close();
    }
    // Confirmed, it does not come back.
    await page.reload();
    await expect(page.locator(".engines-tools .engines-tool")).toHaveCount(1, { timeout: 30000 });
    await expect(notice).toHaveCount(0);
  } finally {
    await app.close();
    removeTestFolder(userData);
    rmSync(tools.bin, { recursive: true, force: true });
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
    // Antigravity's own check keeps saying it has a key while its provider answers every call with 401.
    CLI_FUNNEL_AGY_BIN: fake(
      "agy",
      `case "$1" in
  --version) echo "1.5.13";;
  models) printf 'gemini-3.8-flash\\tGemini 3.8 Flash\\n';;
  *) echo "Error: request failed with status 401 Unauthorized" >&2; exit 1;;
esac`,
    ),
    GEMINI_API_KEY: "test-key",
  };
  const app = await launchPyxis({ userData, env });
  try {
    const page = await app.firstWindow();
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.getByRole("button", { name: "Salta" }).click();
    await expect(page).toHaveURL(/#\/ask$/);
    await page.evaluate(async () => {
      await window.pyxis.invoke("engines.acknowledge", {
        providers: ["claude", "antigravity"],
      });
      localStorage.setItem("pyxis.lang", "en");
      localStorage.removeItem("pyxis.engines.advanced");
      location.hash = "/settings/engines";
    });
    await page.reload();
    await expect(tool(page, "antigravity")).toContainText("Connected", { timeout: 30000 });
    await expect(page.locator(".engines-summary")).toContainText("Gemini", {
      timeout: 30000,
    });

    await choose(page, "Gemini", "Test");
    // The message names the engine and offers its sign-in here, instead of sending the student to the page they are on.
    await expect(
      page.getByText(
        "Gemini refused the sign-in, which has probably expired. Pyxis won't use it until you sign in again.",
      ),
    ).toBeVisible({ timeout: 30000 });
    await expect(page.getByText(/Settings, AI tools/)).toHaveCount(0);
    // The tool leaves the connected ones: it waits under "To connect", where its row says why and offers the sign-in.
    await expect(tool(page, "antigravity")).toHaveCount(0);
    const waiting = page.getByRole("region", { name: "To connect" }).locator("li", { hasText: "Gemini" });
    await expect(waiting).toContainText("Sign-in expired");
    await expect(waiting.getByRole("button", { name: "Sign in to Gemini" })).toBeVisible();
    await expect(page.locator(".engines-summary")).not.toContainText(
      "Gemini",
      { timeout: 30000 },
    );
    expect(
      Object.values(
        await page.evaluate(() => window.pyxis.invoke("engines.features", {})),
      ).map((selection) => selection.provider),
    ).not.toContain("antigravity");
    await expectNoAxeViolations(page, {
      tags: ["wcag2a", "wcag2aa", "wcag21aa"],
    });
    await saveShot(page, "engines-refused-en.png", { fullPage: true });
    await waiting.getByRole("button", { name: "Sign in to Gemini" }).click();
    await expect(
      page.getByRole("dialog", { name: "Set up Gemini" }),
    ).toBeVisible();
    await page.keyboard.press("Escape");

    // A task screen says the same: a chat pinned to Gemini names it and opens its sign-in, instead of pointing
    // at Settings in words.
    await page.evaluate(() =>
      window.pyxis.invoke("engines.setFeature", {
        feature: "chat",
        provider: "antigravity",
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
      "Gemini refused the sign-in, which has probably expired. Pyxis won't use it until you sign in again.",
    );
    await expect(named.first()).toBeVisible({ timeout: 30000 });
    await expect(page.getByText(/Sign in again in Settings, AI tools/)).toHaveCount(0);
    await expectNoAxeViolations(page, {
      tags: ["wcag2a", "wcag2aa", "wcag21aa"],
    });
    await page
      .getByRole("button", { name: "Sign in to Gemini" })
      .first()
      .click();
    await expect(page).toHaveURL(/#\/settings\/engines$/);
    await expect(
      page.getByRole("dialog", { name: "Set up Gemini" }),
    ).toBeVisible();
  } finally {
    await app.close();
    removeTestFolder(userData);
    rmSync(bin, { recursive: true, force: true });
  }
});

test("Settings: a model the subscription refuses keeps the engine, but the row says so and the plan moves to the next model of the role", async () => {
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
    // Claude Code signed in on a plan that leaves Haiku 5.5 out: that model is refused and every other one answers.
    CLI_FUNNEL_CLAUDE_BIN: fake(
      "claude",
      `case "$1" in
  --version) echo "2.1.0";;
  auth) echo '{"loggedIn":true,"authMethod":"claude.ai"}';;
  *)
    case "$*" in
      *claude-haiku-5-5*) echo "Claude Haiku 5.5 is not included in your subscription." >&2; exit 1;;
      *) read -r _; printf '%s\\n' '{"type":"system","subtype":"init","session_id":"stub-1"}' '{"type":"assistant","message":{"content":[{"type":"text","text":"ok"}]}}' '{"type":"result","subtype":"success","is_error":false,"result":"ok","session_id":"stub-1","usage":{"input_tokens":3,"output_tokens":1}}';;
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
      await window.pyxis.invoke("engines.acknowledge", { providers: ["claude"] });
      localStorage.setItem("pyxis.lang", "en");
      localStorage.removeItem("pyxis.engines.advanced");
      location.hash = "/settings/engines";
    });
    await page.reload();
    const row = tool(page, "claude");
    await expect(row).toContainText("Connected", { timeout: 30000 });
    // The row names the model of each role, never an id.
    await expect(row.locator("[data-role]")).toHaveText(["Fast Haiku 5.5", "Balanced Sonnet 5.5", "Strong Opus 5.5"], { timeout: 30000 });
    await expect(row).not.toContainText("claude-haiku");
    // One tool has nothing to be put in order with: no grip, and no place.
    await expect(row.getByRole("button", { name: "Reorder Claude" })).toHaveCount(0);

    await choose(page, "Claude", "Test");
    await expect(
      page.getByText("Your Claude subscription doesn't include the chosen model."),
    ).toBeVisible({ timeout: 30000 });
    await expect(row).toContainText("Ready, with limits");
    await expect(row).toContainText("Haiku 5.5 isn't in your subscription");
    // The plan moves the tasks Pyxis chose on the fast role to the next model of that role, and no other.
    const modelsOf = async () =>
      Object.fromEntries(
        Object.entries(await page.evaluate(() => window.pyxis.invoke("engines.features", {}))).map(([feature, selection]) => [feature, selection.model]),
      );
    await expect.poll(async () => (await modelsOf()).map).toBe("claude-haiku-4-5-20251001");
    expect((await modelsOf()).lesson).toBe("claude-sonnet-5-5");
    // The row's fast role shows the model the choice moved to.
    await expect(row.locator('[data-role="fast"]')).toContainText("Haiku 4.5");
    await expectNoAxeViolations(page, { tags: ["wcag2a", "wcag2aa", "wcag21aa"] });
    await saveShot(page, "engines-model-refused-en.png", { fullPage: true });
    // The next Prova skips the refused model, answers on the next one and names it as the engine lists it.
    await choose(page, "Claude", "Test");
    await expect(page.locator(".engines-result")).toContainText("Haiku 4.5", { timeout: 30000 });
    await expect(page.locator(".engines-result")).not.toContainText("claude-haiku");
  } finally {
    await app.close();
    removeTestFolder(userData);
    rmSync(bin, { recursive: true, force: true });
  }
});

test("Settings: a tool's row says its three roles with the model each one runs, and a tool still to connect says which models it would use", async () => {
  test.skip(process.platform === "win32", "stand-in CLIs are shell scripts");
  test.setTimeout(180000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-engine-roles-"));
  const tools = standInTools(["claude", "codex"]);
  const app = await launchPyxis({ userData, env: tools.env });
  try {
    const page = await app.firstWindow();
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.getByRole("button", { name: "Salta" }).click();
    await expect(page).toHaveURL(/#\/ask$/);
    await page.evaluate(() =>
      window.pyxis.invoke("engines.acknowledge", {
        providers: ["claude", "codex"],
      }),
    );
    for (const language of ["en", "it"] as const)
      for (const theme of ["light", "dark"] as const) {
        await page.evaluate(
          async ({ language, theme }) => {
            localStorage.setItem("pyxis.lang", language);
            localStorage.removeItem("pyxis.engines.advanced");
            await window.pyxis.setAppearance(theme);
            location.hash = "/settings/engines";
          },
          { language, theme },
        );
        await page.reload();
        await expect(page.locator(".engines-tools .engines-tool")).toHaveCount(
          2,
          { timeout: 30000 },
        );
        const words =
          language === "en"
            ? { fast: "Fast", mid: "Balanced", strong: "Strong" }
            : { fast: "Veloce", mid: "Equilibrato", strong: "Forte" };
        // Each row says its three roles with the model each one runs for this account, in the roles' order.
        const rolesOf = (id: string) =>
          tool(page, id).locator("[data-roles] [data-role]");
        await expect(rolesOf("claude")).toHaveText(
          [
            `${words.fast} Haiku 5.5`,
            `${words.mid} Sonnet 5.5`,
            `${words.strong} Opus 5.5`,
          ],
          { timeout: 30000 },
        );
        await expect(rolesOf("codex")).toHaveText([
          `${words.fast} GPT-6 Luna`,
          `${words.mid} GPT-6.1 Terra`,
          `${words.strong} GPT-6.1 Sol`,
        ]);
        // The role is in the quiet colour and the model in the normal one.
        const colours = await rolesOf("claude")
          .first()
          .evaluate((node) => ({
            role: getComputedStyle(node.querySelector(".engines-role")!).color,
            model: getComputedStyle(node.querySelector(".engines-role-model")!)
              .color,
          }));
        expect(colours.role).not.toBe(colours.model);
        // One line under the list says which role does what, true of both tools: the chat is balanced on Claude and ChatGPT,
        // so it is listed under balanced, and the rows add no line of their own about it. It says nothing about when the
        // list was updated.
        const note = page.locator(".engines-roles-note");
        await expect(note).toHaveText(
          language === "en"
            ? "Each tool uses only its maker's models, and Pyxis picks among three: fast for flashcards and maps, balanced for chat, lessons and grading, strong for the study plan."
            : "Ogni strumento usa solo i modelli di chi lo fa, e Pyxis sceglie tra tre: veloce per le flashcard e le mappe, equilibrato per la chat, le lezioni e la correzione, forte per il piano di studio.",
        );
        for (const id of ["claude", "codex"]) await expect(tool(page, id)).not.toContainText(/Qui «Chat»|Here “Chat”/);
        await expect(
          page.getByText(/last updated|aggiornato oggi|Elenco dei modelli/i),
        ).toHaveCount(0);
        // A tool still to connect says which models it would use.
        await expect(
          page
            .getByRole("region", {
              name: language === "en" ? "To connect" : "Da collegare",
            })
            .getByRole("listitem")
            .filter({ hasText: "Gemini" }),
        ).toContainText(
          language === "en"
            ? "Uses Gemini 3.8 Flash, Gemini 4 Hydrogen and Gemini 4 Carbon."
            : "Usa Gemini 3.8 Flash, Gemini 4 Hydrogen e Gemini 4 Carbon.",
        );
        // Under Advanced each kind of work names its role, and a pinned one is tinted until everything goes back.
        const chat = page.getByRole("combobox", { name: "Chat", exact: true });
        // The chat runs in the balanced role on Claude and ChatGPT, as the model file says, and the rows say it too.
        await expect(page.locator(".engines-feature-work small")).toHaveText([
          words.mid,
          words.fast,
          words.fast,
          words.mid,
          words.mid,
          words.strong,
          words.mid,
          words.mid,
        ]);
        expect(await picked(chat)).toMatch(
          language === "en" ? /^Automatic · today \S/ : /^Automatico · oggi \S/,
        );
        const groups = await chat
          .locator("optgroup")
          .evaluateAll((nodes) =>
            nodes.map((node) => (node as HTMLOptGroupElement).label),
          );
        expect(groups).toEqual(["Claude", "ChatGPT"]);
        // The list offers the models with the roles they fill, in the tool's own order.
        expect(
          await chat
            .locator('optgroup[label="Claude"] option')
            .allTextContents(),
        ).toEqual(
          expect.arrayContaining([
            `Haiku 5.5 · ${words.fast.toLowerCase()}`,
            `Sonnet 5.5 · ${words.mid.toLowerCase()}`,
            `Opus 5.5 · ${words.strong.toLowerCase()}`,
          ]),
        );
        const pinned = page.getByText(
          language === "en" ? "1 pinned by you" : "1 fissato da te",
        );
        await chat.selectOption({
          label: `Opus 5.5 · ${words.strong.toLowerCase()}`,
        });
        await expect(chat).toHaveClass(/is-pinned/);
        await expect(pinned).toBeVisible();
        // The label under "Chat" says it is pinned, not a role the pinned model does not have; the other kinds of work keep theirs.
        await expect(page.locator(".engines-feature-work small").first()).toHaveText(
          language === "en" ? "Pinned" : "Fissato",
        );
        await expect(page.locator(".engines-feature-work small").nth(1)).toHaveText(words.fast);
        await expectNoAxeViolations(page, {
          tags: ["wcag2a", "wcag2aa", "wcag21aa"],
        });
        await saveShot(page, `engines-roles-${language}-${theme}.png`, {
          fullPage: true,
        });
        // One control puts every kind of work back to automatic.
        await page
          .getByRole("button", {
            name:
              language === "en"
                ? "Reset all to Automatic"
                : "Riporta tutto su Automatico",
          })
          .click();
        await expect(chat).not.toHaveClass(/is-pinned/);
        await expect(
          page.getByText(
            language === "en" ? "Everything automatic" : "Tutto automatico",
          ),
        ).toBeVisible();
        // The role is back under "Chat", and there is no control left to press.
        await expect(page.locator(".engines-feature-work small").first()).toHaveText(words.mid);
        await expect(
          page.getByRole("button", {
            name: language === "en" ? "Reset all to Automatic" : "Riporta tutto su Automatico",
          }),
        ).toHaveCount(0);
      }
  } finally {
    await app.close();
    removeTestFolder(userData);
    rmSync(tools.bin, { recursive: true, force: true });
  }
});

test("Settings: the model field of each kind of work shows the whole model name at narrow widths and at large text", async () => {
  test.skip(process.platform === "win32", "stand-in CLIs are shell scripts");
  test.setTimeout(180000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-engine-fit-"));
  const tools = standInTools(["claude", "codex"]);
  const app = await launchPyxis({ userData, env: tools.env });
  try {
    const page = await app.firstWindow();
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.getByRole("button", { name: "Salta" }).click();
    await expect(page).toHaveURL(/#\/ask$/);
    await page.evaluate(() => window.pyxis.invoke("engines.acknowledge", { providers: ["claude", "codex"] }));
    for (const textSize of ["md", "lg"] as const)
      for (const width of [975, 1100, 1280]) {
        await page.evaluate(async (size) => {
          localStorage.setItem("pyxis.lang", "it");
          localStorage.removeItem("pyxis.engines.advanced");
          await window.pyxis.invoke("profile.save", { dyslexia: false, textSize: size });
          location.hash = "/settings/engines";
        }, textSize);
        await page.setViewportSize({ width, height: 900 });
        await page.reload();
        await expect(page.locator(".engines-feature-row")).toHaveCount(8, { timeout: 30000 });
        await expect(page.locator("#engine-chat option").first()).toContainText("Automatico · oggi", { timeout: 30000 });
        // The text of the selected option, as the browser draws it, fits inside the field it is in.
        const clipped = await page.locator(".engines-feature-row select[id^='engine-']:not([id^='engine-effort'])").evaluateAll((nodes) => {
          const canvas = document.createElement("canvas").getContext("2d")!;
          return nodes.flatMap((node) => {
            const select = node as HTMLSelectElement;
            const style = getComputedStyle(select);
            canvas.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
            const text = select.selectedOptions[0]?.label ?? "";
            // Padding on both sides and the arrow the browser draws at the end.
            const room = select.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - 24;
            return canvas.measureText(text).width > room ? [`${select.id}: "${text}" needs ${Math.ceil(canvas.measureText(text).width)} px of ${Math.floor(room)}`] : [];
          });
        });
        expect(clipped, `${textSize}, ${width} px`).toEqual([]);
      }
  } finally {
    await app.close();
    removeTestFolder(userData);
    rmSync(tools.bin, { recursive: true, force: true });
  }
});

test("Settings: a workspace whose only allowed tool was Cursor keeps Claude and ChatGPT unused until the student turns one on", async () => {
  test.skip(process.platform === "win32", "stand-in CLIs are shell scripts");
  test.setTimeout(180000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-engine-retired-"));
  const tools = standInTools(["claude", "codex"]);
  let app: ElectronApplication | undefined;
  try {
    // A first run makes the workspace; then the saved choice of tools is what an earlier build left: Cursor, alone.
    app = await launchPyxis({ userData, env: tools.env });
    let page = await app.firstWindow();
    await page.getByRole("button", { name: "Salta" }).click();
    await expect(page).toHaveURL(/#\/ask$/);
    await page.evaluate(() => window.pyxis.invoke("engines.acknowledge", { providers: ["claude", "codex"] }));
    await app.close();
    app = undefined;
    const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), { timeout: 10000 });
    db.prepare("INSERT OR REPLACE INTO settings(key,value_json,updated_at) VALUES('engines.allowed',?,?)").run(JSON.stringify(["agent"]), Date.now());
    db.prepare("INSERT OR REPLACE INTO settings(key,value_json,updated_at) VALUES('engines.order',?,?)").run(JSON.stringify(["agent"]), Date.now());
    db.close();

    app = await launchPyxis({ userData, env: tools.env });
    page = await app.firstWindow();
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.evaluate(() => {
      localStorage.setItem("pyxis.lang", "en");
      localStorage.removeItem("pyxis.engines.advanced");
      location.hash = "/settings/engines";
    });
    await page.reload();
    // Both tools are connected and neither is in use: nothing is planned, and the page says no tool is ready.
    await expect(page.locator(".engines-tools .engines-tool")).toHaveCount(2, { timeout: 30000 });
    await expect(page.locator(".engines-tool-state")).toHaveText(["Not in use", "Not in use"]);
    await expect(page.locator(".engines-summary")).toHaveText("No AI tool is ready.");
    expect(await page.evaluate(() => window.pyxis.invoke("engines.choice", {}))).toEqual({ allowed: [], order: null });
    expect(await page.evaluate(() => window.pyxis.invoke("engines.features", {}))).toEqual({});
    await saveShot(page, "engines-only-cursor-en.png", { fullPage: true });
    // The student turns Claude on: it is the only tool in use, and ChatGPT stays off.
    await choose(page, "Claude", "Use again");
    await expect(tool(page, "claude").locator(".engines-tool-state")).toHaveText("Connected");
    await expect(tool(page, "codex").locator(".engines-tool-state")).toHaveText("Not in use");
    expect(await page.evaluate(() => window.pyxis.invoke("engines.choice", {}))).toEqual({ allowed: ["claude"], order: null });
  } finally {
    // The app holds the workspace open: it closes before the folder is removed, whichever step failed.
    await app?.close();
    removeTestFolder(userData);
    rmSync(tools.bin, { recursive: true, force: true });
  }
});

test("Settings: an Antigravity program older than 1.5 is left out, and its row says it needs an update", async () => {
  test.skip(process.platform === "win32", "stand-in CLIs are shell scripts");
  test.setTimeout(180000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-engine-old-agy-"));
  const tools = standInTools(["claude", "antigravity"], "1.4.0");
  const app = await launchPyxis({ userData, env: tools.env });
  try {
    const page = await app.firstWindow();
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.getByRole("button", { name: "Salta" }).click();
    await expect(page).toHaveURL(/#\/ask$/);
    await page.evaluate(async () => {
      await window.pyxis.invoke("engines.acknowledge", { providers: ["claude", "antigravity"] });
      localStorage.setItem("pyxis.lang", "en");
      localStorage.removeItem("pyxis.engines.advanced");
      location.hash = "/settings/engines";
    });
    await page.reload();
    // Only Claude is connected; Gemini waits under "To connect" with the line that says why, and has no sign-in button.
    await expect(page.locator(".engines-tools .engines-tool")).toHaveCount(1, { timeout: 30000 });
    await expect(tool(page, "claude")).toBeVisible();
    const toConnect = page.locator(".px-ctl-row", { has: page.locator("#engines-connect-antigravity") });
    await expect(toConnect).toContainText("Gemini needs Antigravity 1.5 or newer. Update the program and Pyxis starts using it again.");
    await expect(toConnect).toContainText("Needs an update");
    await expect(toConnect.getByRole("button")).toHaveCount(0);
    // No task goes to it.
    const features = (await page.evaluate(() => window.pyxis.invoke("engines.autoConfigure", {}))) as {
      features: Record<string, { provider: string }>;
    };
    expect(Object.values(features.features).map((feature) => feature.provider)).not.toContain("antigravity");
    await saveShot(page, "engines-old-agy-en.png");
    // The same in Italian.
    await page.evaluate(() => localStorage.setItem("pyxis.lang", "it"));
    await page.reload();
    const row = page.locator(".px-ctl-row", { has: page.locator("#engines-connect-antigravity") });
    await expect(row).toContainText("Gemini richiede Antigravity 1.5 o successivo", { timeout: 30000 });
    await expect(row).toContainText("Da aggiornare");
  } finally {
    await app.close();
    removeTestFolder(userData);
    rmSync(tools.bin, { recursive: true, force: true });
  }
});

test("Settings: a tool signed in or out in a terminal while the page is open shows up on its own, with no click and no reload", async () => {
  test.skip(process.platform === "win32", "stand-in CLIs are shell scripts");
  test.setTimeout(180000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-engine-live-"));
  const bin = mkdtempSync(join(tmpdir(), "pyxis-engine-bin-"));
  // Claude Code's own check follows a file: the student signs in or out in a terminal, here by creating or removing it.
  const signedIn = join(bin, "signed-in");
  const claude = join(bin, "claude");
  writeFileSync(
    claude,
    `#!/bin/sh\ncase "$1" in --version) echo "2.1.0";; auth) if [ -f "${signedIn}" ]; then echo '{"loggedIn":true,"authMethod":"claude.ai"}'; else echo '{"loggedIn":false}'; fi;; *) exit 1;; esac\n`,
  );
  chmodSync(claude, 0o755);
  const env = { HOME: bin, PATH: "/usr/bin:/bin", CLI_FUNNEL_NO_SHELL_PATH: "1", CLI_FUNNEL_CLAUDE_BIN: claude };
  let app: ElectronApplication | undefined;
  try {
    app = await launchPyxis({ userData, env });
    const page = await app.firstWindow();
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.getByRole("button", { name: "Salta" }).click();
    await expect(page).toHaveURL(/#\/ask$/);
    await page.evaluate(async () => {
      await window.pyxis.invoke("engines.acknowledge", { providers: ["claude"] });
      localStorage.setItem("pyxis.lang", "en");
      location.hash = "/settings/engines";
    });
    await page.reload();
    // Nothing is signed in: the page says so.
    await expect(page.getByText("No tool is connected. Connect one below to start.")).toBeVisible({ timeout: 30000 });
    // The student signs in from a terminal. The window never loses focus and nothing is clicked.
    writeFileSync(signedIn, "");
    await expect(tool(page, "claude")).toBeVisible({ timeout: 45000 });
    await expect(tool(page, "claude").locator(".engines-tool-state")).toHaveText("Connected");
    // And out again: the row leaves the list on its own.
    rmSync(signedIn);
    await expect(page.locator(".engines-tools .engines-tool")).toHaveCount(0, { timeout: 45000 });
    await expect(page.getByText("No tool is connected. Connect one below to start.")).toBeVisible();
  } finally {
    await app?.close();
    removeTestFolder(userData);
    rmSync(bin, { recursive: true, force: true });
  }
});

test("Settings: the line under the list says what is true of every tool, with the chat's role told apart when the tools differ", async () => {
  test.skip(process.platform === "win32", "stand-in CLIs are shell scripts");
  test.setTimeout(180000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-engine-split-"));
  const tools = standInTools(["claude", "codex", "antigravity"]);
  let app: ElectronApplication | undefined;
  try {
    app = await launchPyxis({ userData, env: tools.env });
    const page = await app.firstWindow();
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.getByRole("button", { name: "Salta" }).click();
    await expect(page).toHaveURL(/#\/ask$/);
    await page.evaluate(() => window.pyxis.invoke("engines.acknowledge", { providers: ["claude", "codex", "antigravity"] }));
    for (const language of ["en", "it"] as const) {
      await page.evaluate((lang) => {
        localStorage.setItem("pyxis.lang", lang);
        location.hash = "/settings/engines";
      }, language);
      await page.reload();
      await expect(page.locator(".engines-tools .engines-tool")).toHaveCount(3, { timeout: 30000 });
      // The chat is balanced on Claude and ChatGPT and fast on Gemini: it is not listed under one role, it is said apart.
      await expect(page.locator(".engines-roles-note")).toHaveText(
        language === "en"
          ? "Each tool uses only its maker's models, and Pyxis picks among three: fast for flashcards and maps, balanced for lessons and grading, strong for the study plan. For chat: the balanced model of Claude and ChatGPT, the fast one of Gemini."
          : "Ogni strumento usa solo i modelli di chi lo fa, e Pyxis sceglie tra tre: veloce per le flashcard e le mappe, equilibrato per le lezioni e la correzione, forte per il piano di studio. Per la chat usa il modello equilibrato di Claude e ChatGPT, quello veloce di Gemini.",
        { timeout: 30000 },
      );
      // The word under "Chat" in Avanzate is the role on the tool that runs it today: the automatic choice gives the chat
      // to Gemini first, where it is the fast role, and the line under the list says the other tools run it balanced.
      const chatTool = await page.evaluate(async () => ((await window.pyxis.invoke("engines.features", {})) as Record<string, { provider: string }>).chat?.provider);
      expect(chatTool).toBe("antigravity");
      await expect(page.locator(".engines-feature-work small").first()).toHaveText(language === "en" ? "Fast" : "Veloce");
      await saveShot(page, `engines-roles-note-${language}.png`, { fullPage: true });
    }
  } finally {
    await app?.close();
    removeTestFolder(userData);
    rmSync(tools.bin, { recursive: true, force: true });
  }
});
