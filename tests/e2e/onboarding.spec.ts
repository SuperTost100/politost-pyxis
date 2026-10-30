import {
  expect,
  test,
  type ElectronApplication,
  type Locator,
  type Page,
} from "@playwright/test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchPyxis } from "./app-under-test";
import { expectNoAxeViolations } from "./axe";
import { animationsSettled } from "./settled";
import { removeTestFolder } from "./cleanup";

// Stand-ins for the two engine CLIs. They report a version and a sign-in state, nothing more, so no model is called.
function fakeBins(options: { claude: boolean | null; codex: boolean | null }) {
  const bin = mkdtempSync(join(tmpdir(), "pyxis-onb-bin-"));
  const fake = (name: string, body: string) => {
    const path = join(bin, name);
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);
    return path;
  };
  const missing = join(bin, "not-installed");
  return {
    bin,
    env: {
      // Only the stand-ins exist: engines installed on this computer must not show up, so the search sees no user folders.
      HOME: bin,
      PATH: "/usr/bin:/bin",
      CLI_FUNNEL_NO_SHELL_PATH: "1",
      CLI_FUNNEL_CLAUDE_BIN:
        options.claude === null
          ? missing
          : fake(
              "claude",
              `case "$1" in --version) echo "2.1.0";; auth) echo '{"loggedIn":${options.claude},"authMethod":"claude.ai"}';; esac`,
            ),
      CLI_FUNNEL_CODEX_BIN:
        options.codex === null
          ? missing
          : fake(
              "codex",
              options.codex
                ? `case "$1" in --version) echo "codex-cli 0.150.0";; login) echo "Logged in using ChatGPT";; *) exit 1;; esac`
                : `case "$1" in --version) echo "codex-cli 0.150.0";; login) echo "Not logged in"; exit 1;; *) exit 1;; esac`,
            ),
    },
  };
}

async function launch(
  userData: string,
  extra: Record<string, string>,
): Promise<ElectronApplication> {
  return launchPyxis({ userData, env: extra });
}

async function noAxeViolations(page: Page) {
  // A dialog that is still fading in can measure as low contrast, so wait for finite animations to end first.
  await animationsSettled(page);
  await expectNoAxeViolations(page);
}

const profile = (page: Page) =>
  page.evaluate(() => window.pyxis.invoke("profile.get", {})) as Promise<{
    displayName: string;
    school: string;
    year: string;
    course: string;
    educationLevel: string;
    contentLanguage: string;
    crashReports: boolean;
    gradeScale: 30 | 100 | null;
  } | null>;
const button = (page: Page | Locator, name: string | RegExp) =>
  page.getByRole("button", { name, exact: typeof name === "string" });
// The stepper says where the student is once, to screen readers; the same text is not printed again on screen.
const stepper = (page: Page) => page.getByRole("list", { name: "Avanzamento" });
const currentStep = (page: Page) => page.locator("[aria-current=step]");
// Setup is closed: no section switch and no Settings button until it ends.
async function noNavigation(page: Page) {
  await expect(page.getByRole("radiogroup", { name: "Sezioni" })).toHaveCount(0);
  await expect(button(page, "Impostazioni")).toHaveCount(0);
}

test("First setup: about you, the engine with its notice and crash reports off, the exam with a goal out of 30, the material, then the switch in Settings", async () => {
  // The stand-in CLIs are POSIX shell scripts. Windows still runs the selection policy in the unit tests.
  test.skip(process.platform === "win32", "stand-in CLIs are shell scripts");
  test.setTimeout(180000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-onb-"));
  const { bin, env } = fakeBins({ claude: true, codex: true });
  const app = await launch(userData, env);
  try {
    const page = await app.firstWindow();
    await page.emulateMedia({ reducedMotion: "reduce" });
    // Step 1: what Pyxis is, and the profile, on one screen.
    await expect(
      page.getByRole("heading", { name: "Ciao, sono Pyxis" }),
    ).toBeVisible();
    await expect(stepper(page).getByRole("listitem")).toHaveCount(4);
    await expect(currentStep(page)).toHaveText("Passo 1 di 4: Su di te");
    await expect(page.getByText("Passo 1 di 4")).not.toBeInViewport();
    await expect(
      button(page, "Università").and(page.locator("[aria-pressed=true]")),
    ).toBeVisible();
    await noNavigation(page);
    await page.getByLabel("Come ti chiami? (facoltativo)", { exact: true }).fill("Ada");
    await noAxeViolations(page);
    await button(page, "Continua").click();

    // Step 2: what was found, in plain words, and no model call anywhere.
    await expect(
      page.getByRole("heading", { name: "Chi scrive le tue lezioni" }),
    ).toBeVisible();
    await expect(currentStep(page)).toHaveText("Passo 2 di 4: Motore AI");
    await expect(page.getByText("Ho trovato Claude Code e Codex.")).toBeVisible(
      {
        timeout: 30000,
      },
    );
    // One notice for both engines, here and not later in a task. Until it is confirmed Pyxis plans nothing with them.
    const notice = page.getByRole("region", {
      name: "Cosa esce da questo computer",
    });
    await expect(notice.getByText("Claude Code li invia ad Anthropic.")).toBeVisible();
    await expect(notice.getByText("Codex li invia ad OpenAI.")).toBeVisible();
    await expect(page.getByText(/^Pyxis usa Codex .* Claude Code/)).toHaveCount(0);
    await expect(button(page, "Continua")).toHaveCount(0);
    // Crash reports sit next to the notice, off until the student turns them on.
    const crash = page.getByRole("switch", {
      name: "Consenti segnalazioni di crash",
    });
    await expect(crash).not.toBeChecked();
    // Setup is the one place that says where to change the choice later.
    await expect(page.getByText("da Impostazioni, alla voce Privacy", { exact: false })).toBeVisible();
    await noAxeViolations(page);
    await notice.getByRole("button", { name: "Ho capito" }).click();
    await expect(notice).toHaveCount(0);
    await expect(page.getByText(/^Pyxis usa Codex .* Claude Code/)).toBeVisible(
      {
        timeout: 30000,
      },
    );
    // With engines ready the subscription question stays out of the way.
    await expect(page.getByText("Quale di questi paghi già?")).toHaveCount(0);
    await expect(button(page, "Configura un altro motore")).toBeVisible();
    expect(
      (await page.evaluate(() => window.pyxis.invoke("engines.overview", {})))
        .filter((row) => row.id === "claude" || row.id === "codex")
        .map((row) => row.acknowledged),
    ).toEqual([true, true]);
    // No scan download is offered in setup: it comes up only when a scan is added.
    await expect(button(page, /^Scarica [\d.,]+ MB$/)).toHaveCount(0);
    await noAxeViolations(page);
    // A new step opens at its top, not at the offset the last one was scrolled to.
    await page.setViewportSize({ width: 1280, height: 420 });
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
    await button(page, "Continua").click();
    await expect(page.getByRole("heading", { name: "Quale esame prepari?" })).toBeVisible();
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    await page.setViewportSize({ width: 1280, height: 800 });

    // Step 3: the profile is saved when the engine step ends, with crash reports off.
    await expect(
      page.getByRole("heading", { name: "Quale esame prepari?" }),
    ).toBeVisible();
    await expect(currentStep(page)).toHaveText("Passo 3 di 4: L'esame");
    expect(await profile(page)).toMatchObject({
      displayName: "Ada",
      educationLevel: "university",
      crashReports: false,
      gradeScale: null,
    });
    await noNavigation(page);
    // Nothing is chosen for the student: Continue waits for a name and a date, or no date yet.
    await expect(button(page, "Continua")).toBeDisabled();
    await page.getByLabel("Nome dell'esame", { exact: true }).fill("Analisi 1");
    await expect(button(page, "Continua")).toBeDisabled();
    await button(page, "Non ho ancora la data").click();
    await expect(page.getByText("Nessuna data per ora.", { exact: false })).toBeVisible();
    // At university the goal is out of 30, from 18 to 30.
    const goal = page.getByRole("slider", { name: /^Obiettivo .* su 30$/ });
    await expect(goal).toHaveAttribute("aria-valuemin", "18");
    await expect(goal).toHaveAttribute("aria-valuemax", "30");
    await expect(goal).toHaveAttribute("aria-valuenow", "23");
    await goal.focus();
    await page.keyboard.press("End");
    await expect(goal).toHaveAttribute("aria-valuenow", "30");
    await expect(button(page, "Nessun esame per ora")).toBeVisible();
    await noAxeViolations(page);
    await button(page, "Continua").click();

    // Step 4: the material. With nothing picked the main button continues to the guided flow.
    await expect(
      page.getByRole("heading", { name: "Da cosa studi?" }),
    ).toBeVisible();
    await expect(currentStep(page)).toHaveText("Passo 4 di 4: Materiale");
    await expect(button(page, "Libri PoliTost gratuiti")).toBeVisible();
    // The buttons sit in a drop zone, and the step's one primary button is Continue, not Add sources.
    await expect(page.locator(".px-wizard-drop").getByRole("button", { name: "Aggiungi fonti" })).toBeVisible();
    await expect(button(page, "Continua")).toHaveClass(/ant-btn-primary/);
    await expect(button(page, "Aggiungi fonti")).not.toHaveClass(/ant-btn-primary/);
    await expect(page.getByText("Lezioni in italiano, ordine scelto da Pyxis")).toBeVisible();
    await button(page, "Cambia").click();
    await expect(button(page, "English")).toBeVisible();
    await noAxeViolations(page);

    // Back to the exam, which a student without one yet skips: the exams list has the way to create one.
    await button(page, "Indietro").click();
    await expect(page.getByLabel("Nome dell'esame", { exact: true })).toHaveValue("Analisi 1");
    await button(page, "Nessun esame per ora").click();
    await expect(page).toHaveURL(/#\/exams$/);
    await expect(
      page.getByRole("radiogroup", { name: "Sezioni" }),
    ).toBeVisible();
    await expect(button(page, "Impostazioni")).toBeVisible();
    await expect(button(page, "Nuovo esame")).toBeVisible();
    expect(await page.evaluate(() => window.pyxis.invoke("plans.list", {}))).toEqual([]);

    // The Settings switch shows the stored choice, saves each change and matches the setup wording.
    await page.evaluate(() => {
      location.hash = "/settings/privacy";
    });
    const saved = page.getByRole("switch", {
      name: "Consenti segnalazioni di crash",
    });
    await expect(saved).not.toBeChecked();
    // Already on Privacy, the page does not send the student to Privacy.
    await expect(page.getByText("I rapporti vengono cancellati dopo 90 giorni")).toBeVisible();
    await expect(page.getByText("alla voce Privacy", { exact: false })).toHaveCount(0);
    await noAxeViolations(page);
    await saved.click();
    await expect(saved).toBeChecked();
    await expect
      .poll(async () => (await profile(page))?.crashReports)
      .toBe(true);
    await page.reload();
    await expect(
      page.getByRole("switch", { name: "Consenti segnalazioni di crash" }),
    ).toBeChecked();
  } finally {
    await app.close();
    removeTestFolder(userData);
    rmSync(bin, { recursive: true, force: true });
  }
});

test("First setup: a signed-out engine offers sign-in, no engine asks what the student pays for, and I'll do it later continues", async () => {
  test.skip(process.platform === "win32", "stand-in CLIs are shell scripts");
  test.setTimeout(180000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-onb-"));
  const out = fakeBins({ claude: false, codex: null });
  let app = await launch(userData, out.env);
  try {
    let page = await app.firstWindow();
    await button(page, "Continua").click();
    await expect(
      page.getByText("Ho trovato Claude Code, ma serve ancora l'accesso."),
    ).toBeVisible({ timeout: 30000 });
    // The installed engine is offered first: already installed, one sign-in left.
    const setup = page.getByRole("region", { name: "Configura Claude Code" });
    await expect(setup.getByText("Installato, versione 2.1.0.")).toBeVisible();
    await expect(button(setup, "Accedi con Claude")).toBeVisible();
    await expect(page.getByText("Quale di questi paghi già?")).toBeVisible();
    await noAxeViolations(page);
    await app.close();

    const none = fakeBins({ claude: null, codex: null });
    app = await launch(userData, none.env);
    page = await app.firstWindow();
    await button(page, "Continua").click();
    await expect(page.getByText("Non ho trovato nessun motore.")).toBeVisible({
      timeout: 30000,
    });
    // Nothing found: the student says what they pay for and gets that engine's setup, never a GitHub page.
    await expect(page.getByRole("region", { name: /^Configura / })).toHaveCount(
      0,
    );
    await button(page, /^ChatGPT Plus o Pro/).click();
    const codex = page.getByRole("region", { name: "Configura Codex" });
    await expect(
      codex.getByText(
        "curl -fsSL 'https://chatgpt.com/codex/install.sh' | bash",
      ),
    ).toBeVisible();
    await expect(button(codex, "Installa Codex")).toBeVisible();
    await expect(
      codex.getByText("Disponibile a installazione finita."),
    ).toBeVisible();
    await button(page, /^Nessuno di questi/).click();
    await expect(button(page, "Vedi le offerte per studenti")).toBeVisible();
    await expect(
      page.getByRole("region", { name: "Configura Antigravity" }),
    ).toBeVisible();
    await button(page, "Mostra tutti i motori").click();
    // Every engine Pyxis can install, each with its own Set up action.
    // Each action names its engine for screen readers.
    await expect(
      button(page, /^Configura (Claude Code|Codex|Cursor Agent|Antigravity)$/),
    ).toHaveCount(4);
    await noAxeViolations(page);
    // Nothing is ready, so the one primary action says what happens: carry on and sign in later.
    await button(page, "Lo farò dopo").click();
    await expect(
      page.getByRole("heading", { name: "Quale esame prepari?" }),
    ).toBeVisible();
    await button(page, "Indietro").click();
    await expect(currentStep(page)).toHaveText("Passo 2 di 4: Motore AI");
    rmSync(none.bin, { recursive: true, force: true });
  } finally {
    await app.close();
    removeTestFolder(userData);
    rmSync(out.bin, { recursive: true, force: true });
  }
});

test("First setup: cancelling a sign-in before its page opens is not a failure, and signing in again works", async () => {
  test.skip(process.platform === "win32", "stand-in CLIs are shell scripts");
  test.setTimeout(180000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-onb-"));
  const { bin, env } = fakeBins({ claude: false, codex: null });
  // The sign-in prints nothing and waits, as a CLI does before it has a page to show.
  writeFileSync(
    join(bin, "claude"),
    `#!/bin/sh\ncase "$1" in --version) echo "2.1.0";; auth) if [ "$2" = login ]; then exec sleep 60; fi; echo '{"loggedIn":false,"authMethod":"claude.ai"}';; esac\n`,
  );
  const app = await launch(userData, env);
  try {
    const page = await app.firstWindow();
    await button(page, "Continua").click();
    const setup = page.getByRole("region", { name: "Configura Claude Code" });
    await expect(button(setup, "Accedi con Claude")).toBeVisible({
      timeout: 30000,
    });
    await button(setup, "Accedi con Claude").click();
    await button(setup, "Annulla").click();
    // Idle again means Cancel is gone. The button's name is matched loosely: antd keeps its spinner icon, and so the
    // name "loading Accedi con Claude", until the icon's exit transition ends, which a hidden window on a slow macOS
    // runner can delay for seconds.
    await expect(button(setup, "Annulla")).toHaveCount(0);
    const signIn = button(setup, /Accedi con Claude$/);
    await expect(signIn).toBeVisible();
    await expect(setup.getByText("Accesso non completato.")).toHaveCount(0);
    // Starting again is not undone by the answer to the cancelled attempt.
    await signIn.click();
    await expect(button(setup, "Annulla")).toBeVisible();
    // The cancelled attempt's answer would undo this within moments; its absence has no signal, so this waits a fixed time.
    await page.waitForTimeout(500);
    await expect(button(setup, "Annulla")).toBeVisible();
    await expect(setup.getByText(/Accesso non completato/)).toHaveCount(0);
  } finally {
    await app.close();
    removeTestFolder(userData);
    rmSync(bin, { recursive: true, force: true });
  }
});

test("First setup: Install runs the installer, shows its output, then signs in by itself", async () => {
  test.skip(
    process.platform === "win32",
    "the installer stand-in is a shell script",
  );
  test.setTimeout(180000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-onb-"));
  const { bin, env } = fakeBins({ claude: null, codex: null });
  // Stands in for the vendor script: it prints progress and copies a signed-in claude to where the real installer puts it.
  const staged = join(bin, "staged-claude");
  writeFileSync(
    staged,
    `#!/bin/sh\ncase "$1" in --version) echo "2.1.0";; auth) echo '{"loggedIn":true,"authMethod":"claude.ai"}';; esac\n`,
  );
  chmodSync(staged, 0o755);
  const installer = join(bin, "installer.sh");
  writeFileSync(
    installer,
    [
      'echo "Installing $1 into $HOME/.local/bin"',
      'mkdir -p "$HOME/.local/bin"',
      `cp '${staged}' "$HOME/.local/bin/claude"`,
      "sleep 1",
      'echo "Done: claude 2.1.0"',
      "",
    ].join("\n"),
  );
  const app = await launch(userData, {
    ...env,
    PYXIS_E2E_INSTALLER: installer,
  });
  try {
    const page = await app.firstWindow();
    await button(page, "Continua").click();
    await expect(page.getByText("Non ho trovato nessun motore.")).toBeVisible({
      timeout: 30000,
    });
    await button(page, /^Claude Pro o Max/).click();
    const setup = page.getByRole("region", { name: "Configura Claude Code" });
    await button(setup, "Installa Claude Code").click();
    await expect(setup.getByText("Installo Claude Code…")).toBeVisible();
    await expect(setup.getByText(/Installing claude into/)).toBeVisible();
    await expect(setup.getByText("Installato, versione 2.1.0.")).toBeVisible({
      timeout: 30000,
    });
    await expect(setup.getByText("Accesso fatto.")).toBeVisible({
      timeout: 30000,
    });
    await expect(page.getByText("Ho trovato Claude Code.")).toBeVisible();
    // The new engine still needs its notice before Pyxis sends it anything.
    await expect(
      page.getByRole("region", { name: "Cosa esce da questo computer" }),
    ).toBeVisible();
    await noAxeViolations(page);
  } finally {
    await app.close();
    removeTestFolder(userData);
    rmSync(bin, { recursive: true, force: true });
  }
});

test("First setup: skipping leaves crash reports off, and a new profile below university sees goals out of 100", async () => {
  test.setTimeout(180000);
  const skipped = mkdtempSync(join(tmpdir(), "pyxis-onb-"));
  const engines = fakeBins({ claude: null, codex: null });
  let app = await launch(skipped, engines.env);
  try {
    const page = await app.firstWindow();
    await button(page, "Salta").click();
    await expect(page).toHaveURL(/exams/);
    expect(await profile(page)).toMatchObject({
      displayName: "",
      crashReports: false,
    });
    await app.close();

    const fresh = mkdtempSync(join(tmpdir(), "pyxis-onb-"));
    app = await launch(fresh, engines.env);
    try {
      const second = await app.firstWindow();
      await button(second, "Superiore").click();
      await button(second, "Continua").click();
      await expect(second.getByRole("switch")).not.toBeChecked();
      await button(second, "Lo farò dopo").click();
      await expect(
        second.getByRole("heading", { name: "Quale esame prepari?" }),
      ).toBeVisible();
      // Below university the goal keeps the scale out of 100.
      const goal = second.getByRole("slider", { name: /^Obiettivo .* su 100$/ });
      await expect(goal).toHaveAttribute("aria-valuemin", "50");
      await expect(goal).toHaveAttribute("aria-valuenow", "75");
      expect(await profile(second)).toMatchObject({
        educationLevel: "upper-secondary",
        crashReports: false,
      });
    } finally {
      await app.close();
      rmSync(fresh, { recursive: true, force: true });
    }
  } finally {
    rmSync(skipped, { recursive: true, force: true });
    rmSync(engines.bin, { recursive: true, force: true });
  }
});

test("Run setup again: Settings reopens the profile and engine steps filled in, without Skip, leaves engines alone and returns to Settings", async () => {
  test.skip(process.platform === "win32", "stand-in CLIs are shell scripts");
  test.setTimeout(180000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-onb-"));
  const { bin, env } = fakeBins({ claude: true, codex: true });
  const app = await launch(userData, env);
  try {
    const page = await app.firstWindow();
    await page.emulateMedia({ reducedMotion: "reduce" });

    // First setup: a name, a school, a level, and crash reports turned on.
    await page.getByLabel("Come ti chiami? (facoltativo)", { exact: true }).fill("Ada");
    await page.getByLabel("Scuola", { exact: true }).fill("Liceo Volta");
    await button(page, "Superiore").click();
    await button(page, "Continua").click();
    await expect(page.getByText("Ho trovato Claude Code e Codex.")).toBeVisible(
      { timeout: 30000 },
    );
    await page
      .getByRole("region", { name: "Cosa esce da questo computer" })
      .getByRole("button", { name: "Ho capito" })
      .click();
    await expect(page.getByText(/^Pyxis usa Codex .* Claude Code/)).toBeVisible(
      { timeout: 30000 },
    );
    await page
      .getByRole("switch", { name: "Consenti segnalazioni di crash" })
      .click();
    await button(page, "Continua").click();
    await button(page, "Nessun esame per ora").click();
    await expect(page).toHaveURL(/#\/exams$/);
    const stored = await profile(page);
    expect(stored).toMatchObject({
      displayName: "Ada",
      school: "Liceo Volta",
      educationLevel: "upper-secondary",
      crashReports: true,
    });
    const featuresBefore = await page.evaluate(() =>
      window.pyxis.invoke("engines.features", {}),
    );
    expect(Object.keys(featuresBefore).length).toBeGreaterThan(0);

    // Settings > Profile offers the rerun.
    await page.evaluate(() => {
      location.hash = "/settings/profile";
    });
    await expect(page.getByLabel("Nome", { exact: true })).toHaveValue("Ada");
    await noAxeViolations(page);
    await button(page, "Rifai la configurazione").click();
    await expect(page).toHaveURL(/#\/onboarding\?again=1$/);

    // The rerun has two steps and no Skip. Cancel leaves without saving.
    await expect(
      page.getByRole("heading", { name: "Ciao, sono Pyxis" }),
    ).toBeVisible();
    await expect(currentStep(page)).toHaveText("Passo 1 di 2: Su di te");
    await expect(button(page, "Salta")).toHaveCount(0);
    await button(page, "Annulla").click();
    await expect(page).toHaveURL(/#\/settings\/profile$/);
    await button(page, "Rifai la configurazione").click();

    // Profile: every answer is filled in.
    await expect(
      page.getByLabel("Come ti chiami? (facoltativo)", { exact: true }),
    ).toHaveValue("Ada");
    await expect(page.getByLabel("Scuola", { exact: true })).toHaveValue(
      "Liceo Volta",
    );
    await expect(
      button(page, "Superiore").and(
        page.locator("[aria-pressed=true]"),
      ),
    ).toBeVisible();
    await noAxeViolations(page);
    await page
      .getByLabel("Come ti chiami? (facoltativo)", { exact: true })
      .fill("Ada L.");
    await button(page, "Continua").click();

    // Engines: shows what is set up and asks nothing. No launch notice appears.
    await expect(page.getByText("Ho trovato Claude Code e Codex.")).toBeVisible(
      { timeout: 30000 },
    );
    await expect(page.getByText(/^Pyxis usa Codex .* Claude Code/)).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByText("Quale di questi paghi già?")).toHaveCount(0);
    // Crash reports show the stored choice (on), not the first-run default.
    await expect(
      page.getByRole("switch", { name: "Consenti segnalazioni di crash" }),
    ).toBeChecked();
    await noNavigation(page);
    await noAxeViolations(page);

    // The end saves and goes back to Settings > Profile.
    await button(page, "Salva e torna alle impostazioni").click();
    await expect(page).toHaveURL(/#\/settings\/profile$/);
    await expect(page.getByLabel("Nome", { exact: true })).toHaveValue(
      "Ada L.",
    );
    await expect(page.getByLabel("Scuola", { exact: true })).toHaveValue(
      "Liceo Volta",
    );
    expect(await profile(page)).toEqual({
      ...stored,
      displayName: "Ada L.",
    });
    // The engines the student already had are untouched.
    expect(
      await page.evaluate(() => window.pyxis.invoke("engines.features", {})),
    ).toEqual(featuresBefore);

    // The scale: Superiore shows out of 100. A pick holds until the study level changes, which brings that level's scale back.
    const pressed = (name: string) => button(page, name).and(page.locator("[aria-pressed=true]"));
    await expect(pressed("Su 100")).toBeVisible();
    await button(page, "Su 30").click();
    await expect(pressed("Su 30")).toBeVisible();
    await expect.poll(async () => (await profile(page))?.gradeScale).toBe(30);
    await button(page, "Tecnico").click();
    await expect(pressed("Su 100")).toBeVisible();
    await expect.poll(async () => (await profile(page))?.gradeScale).toBeNull();
    await expect(
      page.getByText(
        "Vale per voti, obiettivi e preparazione in tutta l'app. Se cambi livello di studio torna alla scala di quel livello: su 30 all'università, su 100 negli altri casi.",
        { exact: true },
      ),
    ).toBeVisible();
    await noAxeViolations(page);
  } finally {
    await app.close();
    removeTestFolder(userData);
    rmSync(bin, { recursive: true, force: true });
  }
});

const notice = (page: Page) =>
  page.getByRole("dialog", { name: "Cosa esce da questo computer" });

test("Engine notice: a profile with unacknowledged engines sees it once at launch, never during a chat", async () => {
  test.skip(process.platform === "win32", "stand-in CLIs are shell scripts");
  test.setTimeout(180000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-onb-"));
  const { bin, env } = fakeBins({ claude: true, codex: true });
  const reply = { PYXIS_E2E_REPLY: "Ecco la risposta [P1]." };
  let app = await launch(userData, { ...env, ...reply });
  try {
    let page = await app.firstWindow();
    // Skipping setup still shows the notice once on arrival: no task could use these engines without it.
    await button(page, "Salta").click();
    await expect(page).toHaveURL(/exams/);
    await expect(notice(page)).toBeVisible({ timeout: 30000 });
    await notice(page).getByRole("button", { name: "Non ora" }).click();
    await expect(notice(page)).toHaveCount(0);
    await app.close();

    // A launch with a profile (as after an upgrade from 0.2.0): one combined notice for both engines.
    app = await launch(userData, { ...env, ...reply });
    page = await app.firstWindow();
    await expect(notice(page)).toBeVisible({ timeout: 30000 });
    await expect(notice(page).getByText("Claude Code li invia ad Anthropic.")).toBeVisible();
    await expect(notice(page).getByText("Codex li invia ad OpenAI.")).toBeVisible();
    await noAxeViolations(page);
    await notice(page).getByRole("button", { name: "Non ora" }).click();
    await expect(notice(page)).toHaveCount(0);

    // With the notice declined, a chat runs without any dialog appearing.
    await page.evaluate(() => {
      location.hash = "/ask";
    });
    const box = page.getByRole("textbox", { name: "Messaggio" });
    await box.fill("Che cos'è la velocità?");
    await box.press("Enter");
    await expect(page.getByText("Ecco la risposta")).toBeVisible({ timeout: 30000 });
    await expect(page.getByRole("dialog")).toHaveCount(0);

    // Settings asks for it where the engines are enabled.
    await page.evaluate(() => {
      location.hash = "/settings/engines";
    });
    await expect(notice(page)).toBeVisible({ timeout: 30000 });
    await notice(page).getByRole("button", { name: "Ho capito" }).click();
    await expect(notice(page)).toHaveCount(0);
    expect(
      (await page.evaluate(() => window.pyxis.invoke("engines.overview", {})))
        .filter((row) => row.id === "claude" || row.id === "codex")
        .map((row) => row.acknowledged),
    ).toEqual([true, true]);
    await app.close();

    // Acknowledged once, never asked again.
    app = await launch(userData, { ...env, ...reply });
    page = await app.firstWindow();
    await expect(page).toHaveURL(/exams/);
    await expect(
      page.getByRole("heading", { name: "Esami", level: 1 }),
    ).toBeVisible();
    // The notice would open once the engine check ends. A notice that never opens has no signal, so this is a fixed wait.
    await page.waitForTimeout(2000);
    await expect(notice(page)).toHaveCount(0);
  } finally {
    await app.close();
    removeTestFolder(userData);
    rmSync(bin, { recursive: true, force: true });
  }
});

test("First setup: a new profile starts in the computer's language, and a choice in Settings outlasts it", async () => {
  test.setTimeout(180000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-onb-lang-"));
  try {
    // French comes first but Pyxis has no French copy, so the next language it speaks wins.
    let app = await launch(userData, {
      PYXIS_E2E_SYSTEM_LANGUAGES: "fr-FR,en-GB,it-IT",
    });
    let page = await app.firstWindow();
    await expect(button(page, "Skip")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.lang)).toBe("en");
    await button(page, "Skip").click();
    await expect(page).toHaveURL(/#\/exams$/);
    await page.evaluate(() => {
      location.hash = "/settings/language";
    });
    await button(page, "Italiano").click();
    await expect(page.locator("html")).toHaveAttribute("lang", "it");
    await app.close();

    app = await launch(userData, { PYXIS_E2E_SYSTEM_LANGUAGES: "en-US" });
    page = await app.firstWindow();
    await expect(page).toHaveURL(/#\/exams$/);
    await expect(page.locator("html")).toHaveAttribute("lang", "it");
    await app.close();
  } finally {
    removeTestFolder(userData);
  }
});
