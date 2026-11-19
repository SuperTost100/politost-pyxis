import { expect, test, type Locator, type Page } from "@playwright/test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
  const tools = standInTools(["claude", "codex", "agent", "antigravity"]);
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
              localStorage.removeItem("pyxis.engines.advanced");
              await window.pyxis.setAppearance(theme);
              location.hash = "/settings/engines";
            },
            { language, theme },
          );
          await page.reload();
          await expect(page.locator(".engines-tools .engines-tool")).toHaveCount(4, { timeout: 30000 });
          // Every tool is connected, so nothing waits to be connected.
          await expect(page.getByRole("region", { name: language === "en" ? "To connect" : "Da collegare" })).toHaveCount(0);
          // Advanced is open until the student closes it. The model of each task starts closed inside it and opens on
          // its heading.
          await expect(page.locator(".engines-advanced")).toHaveAttribute("open", "");
          await expect(page.locator(".engines-feature-row")).toHaveCount(8);
          const perFeature = page.locator(".engines-section");
          await expect(perFeature).not.toHaveAttribute("open");
          await perFeature.locator("summary").click();
          await expect(perFeature).toHaveAttribute("open", "");
          // Each task has its own reasoning effort next to its model.
          await expect(
            page.getByRole("combobox", {
              name: language === "en" ? "Chat: Reasoning effort" : "Chat: Livello di ragionamento",
            }),
          ).toBeVisible();
          await expect(page.locator('[id^="engine-effort-"]')).toHaveCount(8);
          // A row reads by the tool's name, and the program behind it shows once, as the detail under it: it is what the
          // student installed and signed in to.
          for (const [id, name, program] of [
            ["claude", "Claude", "Claude Code"],
            ["codex", "ChatGPT", "Codex"],
            ["agent", "Cursor", "Cursor Agent"],
            ["antigravity", "Gemini", "Antigravity"],
          ] as const) {
            await expect(tool(page, id).locator(".engines-tool-name")).toHaveText(name);
            await expect(tool(page, id).locator(".px-ctl-description"), `${language}, ${name}`).toContainText(program);
            expect(
              (await tool(page, id).innerText()).split(program).length - 1,
              `${language}, ${name}: the program shows once`,
            ).toBe(1);
          }
          // Every function starts automatic. Nothing is pinned on a fresh profile.
          await expect(
            page.getByRole("button", {
              name: language === "en" ? "Back to automatic choice" : "Torna alla scelta automatica",
            }),
          ).toBeDisabled();
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
    for (const name of ["Cursor", "Gemini"])
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
    // The table sits in a section that starts closed.
    await page.locator(".engines-section > summary").click();
    const chat = page.getByRole("combobox", { name: "Chat", exact: true });
    expect(await picked(chat)).toBe("Automatic");
    await expect(page.locator(".engines-auto-model").first()).toBeVisible();
    // Every task starts at its own reasoning level: low for chat, high for exams.
    const effortOf = (task: string) => page.getByRole("combobox", { name: `${task}: Reasoning effort` });
    await expect(effortOf("Chat")).toBeEnabled();
    expect(await picked(effortOf("Chat"))).toBe("Automatic · Low");
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
    const labels = await chat.locator("option").allTextContents();
    const claudeModel = labels.find((label) => label.startsWith("Claude · "));
    expect(claudeModel).toBeTruthy();
    expect(labels.filter((label) => /^(claude|codex|agent) · /.test(label))).toEqual([]);
    await chat.selectOption({ label: claudeModel! });
    await expect.poll(() => picked(chat)).toBe(claudeModel);
    // The list says a task is set by hand, so the order alone does not explain where chat goes.
    await expect(page.getByText("1 feature is pinned by hand under Advanced.")).toBeVisible();
    const back = page.getByRole("button", { name: "Back to automatic choice" });
    await expect(back).toBeEnabled();
    await back.click();
    await expect.poll(() => picked(chat)).toBe("Automatic");
    await expect(back).toBeDisabled();
    // Back to automatic also returns the efforts to the tasks' own levels.
    await expect.poll(() => picked(effortOf("Exams"))).toBe("Automatic · High");
  } finally {
    await app.close();
    removeTestFolder(userData);
    rmSync(tools.bin, { recursive: true, force: true });
  }
});

test("Automatic engines: with all four CLIs ready, the summary names each engine in one sentence", async () => {
  // The stand-in CLIs are POSIX shell scripts. Windows still runs the selection policy in the unit tests.
  test.skip(process.platform === "win32", "stand-in CLIs are shell scripts");
  test.setTimeout(180000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-engine-four-"));
  const tools = standInTools(["claude", "codex", "agent", "antigravity"]);
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
    // Four engines still make one sentence that names each of them, with no line per engine.
    for (const name of ["Claude", "ChatGPT", "Cursor", "Gemini"])
      await expect(summary).toContainText(name);
    await expect(summary.locator("li")).toHaveCount(0);
    await expect(summary).not.toContainText("chat");
    await saveShot(page, "engines-four-en.png");
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
    // Cursor Agent's own check keeps saying "signed in" while its provider answers every call with 401.
    CLI_FUNNEL_AGENT_BIN: fake(
      "agent",
      `case "$1" in
  --version) echo "2026.09.28-64d2043";;
  status) echo '{"isAuthenticated":true}';;
  about) echo '{}';;
  --list-models) printf 'grok-4.7-low - Grok 4.7  Low\\ngemini-3.8-flash - Gemini 3.8 Flash\\n';;
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
    await expect(tool(page, "agent")).toContainText("Connected", { timeout: 30000 });
    await expect(page.locator(".engines-summary")).toContainText("Cursor", {
      timeout: 30000,
    });

    await choose(page, "Cursor", "Test");
    // The message names the engine and offers its sign-in here, instead of sending the student to the page they are on.
    await expect(
      page.getByText(
        "Cursor refused the sign-in, which has probably expired. Pyxis won't use it until you sign in again.",
      ),
    ).toBeVisible({ timeout: 30000 });
    await expect(page.getByText(/Settings, AI tools/)).toHaveCount(0);
    // The tool leaves the connected ones: it waits under "To connect", where its row says why and offers the sign-in.
    await expect(tool(page, "agent")).toHaveCount(0);
    const waiting = page.getByRole("region", { name: "To connect" }).locator("li", { hasText: "Cursor" });
    await expect(waiting).toContainText("Sign-in expired");
    await expect(waiting.getByRole("button", { name: "Sign in to Cursor" })).toBeVisible();
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
    await waiting.getByRole("button", { name: "Sign in to Cursor" }).click();
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
        model: "grok-4.7",
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
    // Cursor Agent signed in on a plan that lists models of several makers, but whose weekly usage covers one Grok
    // model only. Pyxis runs only Cursor's Grok models, so the others never reach the row or a task.
    CLI_FUNNEL_AGENT_BIN: fake(
      "agent",
      `case "$1" in
  --version) echo "2026.10.22-27dcf5f";;
  status) echo '{"isAuthenticated":true}';;
  about) echo '{}';;
  --list-models) printf 'gemini-3.8-flash-low - Gemini 3.8 Flash Low\\ngemini-3.8-flash-high - Gemini 3.8 Flash High\\nclaude-opus-5-5-high - Claude Opus 5.5 1M High\\ngrok-4.7-low - Grok 4.7  Low\\ngrok-4.7-high - Grok 4.7  High\\ncursor-grok-4.6-low - Grok 4.6 Low\\ncursor-grok-4.6-high - Grok 4.6\\n';;
  *)
    # Grok 4.6 answers; Grok 4.7 is outside the plan.
    case "$*" in
      *cursor-grok-4.6*) cat >/dev/null; printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"result":"ok"}';;
      *) echo "ActionRequiredError: Grok 4.7 is not included in your weekly usage Buy credits or switch to a Grok model to continue." >&2; exit 1;;
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
    const row = tool(page, "agent");
    await expect(row).toContainText("Connected", { timeout: 30000 });
    // The row names the models the plan gives the engine, never their ids, and only Cursor's own kind.
    await expect(row).toContainText("Grok 4.7", { timeout: 30000 });
    await expect(row).not.toContainText("grok-4.7");
    await expect(row).not.toContainText("Claude");
    await expect(row).not.toContainText("Gemini");
    // A tool with models in its row still names its program, once.
    await expect(row.locator(".px-ctl-description")).toContainText("Cursor Agent");
    expect((await row.innerText()).split("Cursor Agent").length - 1).toBe(1);
    // One tool has nothing to be put in order with: no grip, and no place.
    await expect(row.getByRole("button", { name: "Reorder Cursor" })).toHaveCount(0);

    await choose(page, "Cursor", "Test");
    await expect(
      page.getByText("Your Cursor subscription doesn't include the chosen model."),
    ).toBeVisible({ timeout: 30000 });
    await expect(row).toContainText("Ready, with limits");
    await expect(row).toContainText("Grok 4.7 isn't in your subscription");
    // The plan moves every task Pyxis chose to the next Grok model of the model file.
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
      .toEqual(["cursor-grok-4.6"]);
    await expect(row).toContainText("Grok 4.6");
    await expectNoAxeViolations(page, { tags: ["wcag2a", "wcag2aa", "wcag21aa"] });
    await saveShot(page, "engines-model-refused-en.png", { fullPage: true });
    // The next Prova skips the refused model, answers on Grok and names it as the engine lists it.
    await choose(page, "Cursor", "Test");
    await expect(page.locator(".engines-result")).toContainText("Grok 4.6", { timeout: 30000 });
    await expect(page.locator(".engines-result")).not.toContainText("cursor-grok-4.6");
  } finally {
    await app.close();
    removeTestFolder(userData);
    rmSync(bin, { recursive: true, force: true });
  }
});
