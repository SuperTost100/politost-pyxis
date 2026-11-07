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
import { saveShot } from "./shots";

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
// The visible primary buttons: each state of a step has exactly one.
const primaryButtons = (page: Page) => page.locator(".ant-btn-primary:visible");
// The AI step's cards, one per tool, found by the tool's name.
const card = (page: Page, name: string) =>
  page
    .getByRole("list", { name: "Le AI che Pyxis può usare" })
    .getByRole("listitem")
    .filter({ has: page.getByRole("heading", { name, exact: true }) });
const cardState = (page: Page, name: string) =>
  card(page, name).locator(".px-tool-state");
// The engine rows under Advanced, found by the engine's name alone (a row's models can name another vendor).
const engineRow = (page: Page, name: string) =>
  page
    .getByRole("list", { name: "Motori su questo computer" })
    .getByRole("listitem")
    .filter({
      has: page.locator(".px-engine-name", { hasText: new RegExp(`^${name}$`) }),
    });
const advanced = (page: Page) =>
  button(page, "Avanzate: modello sul computer o chiave API");
// What the AI step found, said once to screen readers.
const found = (page: Page, text: string) =>
  page.getByRole("status").filter({ hasText: text });
// Setup is closed: no sidebar, so no sections and no Settings, until it ends.
async function noNavigation(page: Page) {
  await expect(page.getByRole("navigation", { name: "Sezioni" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Impostazioni", exact: true })).toHaveCount(0);
}

test("First setup: you with crash reports off, the AI with its notice, the two ways to keep material, then the switch in Settings", async () => {
  // The stand-in CLIs are POSIX shell scripts. Windows still runs the selection policy in the unit tests.
  test.skip(process.platform === "win32", "stand-in CLIs are shell scripts");
  test.setTimeout(180000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-onb-"));
  const { bin, env } = fakeBins({ claude: true, codex: true });
  const app = await launch(userData, env);
  try {
    const page = await app.firstWindow();
    await page.emulateMedia({ reducedMotion: "reduce" });
    // Step 1: the name, what the student studies and the crash reports, on one screen.
    await expect(
      page.getByRole("heading", { name: "Ciao, come ti chiami e cosa studi?" }),
    ).toBeVisible();
    await expect(stepper(page).getByRole("listitem")).toHaveCount(3);
    await expect(currentStep(page)).toHaveText("Passo 1 di 3: 1 · Tu");
    await expect(page.getByText("Passo 1 di 3")).not.toBeInViewport();
    await expect(page.getByRole("radio", { name: "All'università" })).toBeChecked();
    // University asks for the degree course; school asks which school instead, starting at upper secondary.
    await expect(page.getByLabel("Corso di laurea", { exact: true })).toBeVisible();
    await page.getByRole("radio", { name: "A scuola" }).click();
    await expect(page.getByRole("radio", { name: "Superiore" })).toBeChecked();
    await expect(page.getByLabel("Corso di laurea", { exact: true })).toHaveCount(0);
    // The arrow keys move along the choice, as in any radio group.
    await page.getByRole("radio", { name: "A scuola" }).press("ArrowLeft");
    await expect(page.getByRole("radio", { name: "All'università" })).toBeChecked();
    await expect(page.getByRole("radio", { name: "All'università" })).toBeFocused();
    await noNavigation(page);
    // Crash reports are off until the student turns them on, and setup says where to change that later.
    await expect(
      page.getByRole("switch", { name: "Consenti segnalazioni di crash" }),
    ).not.toBeChecked();
    await expect(
      page.getByText("da Impostazioni, alla voce Privacy", { exact: false }),
    ).toBeVisible();
    await page.getByLabel("Nome", { exact: true }).fill("Ada");
    await page.getByLabel("Corso di laurea", { exact: true }).fill("Fisica");
    await noAxeViolations(page);
    await saveShot(page, "onboarding/1-you.png");
    await button(page, "Continua").click();

    // Step 2: the tools by the name of the account, what was found, and no model call anywhere.
    await expect(
      page.getByRole("heading", { name: "Claude e ChatGPT sono pronti" }),
    ).toBeVisible({ timeout: 30000 });
    await expect(currentStep(page)).toHaveText("Passo 2 di 3: 2 · L'AI");
    await expect(found(page, "Ho trovato Claude e ChatGPT.")).toHaveCount(1);
    // One notice for both engines, here and not later in a task. Until it is confirmed Pyxis plans nothing with them.
    const notice = page.getByRole("region", {
      name: "Cosa esce da questo computer",
    });
    await expect(notice.getByText("Claude li invia ad Anthropic.")).toBeVisible();
    await expect(notice.getByText("ChatGPT li invia ad OpenAI.")).toBeVisible();
    await expect(
      page.getByRole("list", { name: "Le AI che Pyxis può usare" }).getByRole("listitem"),
    ).toHaveCount(4);
    await expect(cardState(page, "Claude")).toHaveText("Collegato");
    await expect(cardState(page, "ChatGPT")).toHaveText("Collegato");
    // With one tool connected, the others are offered as a second.
    await expect(cardState(page, "Cursor")).toHaveText("Collega anche questa");
    await expect(card(page, "Gemini")).toContainText(
      "Gratis per gli studenti universitari",
    );
    await expect(button(page, "Continua")).toHaveCount(0);
    // One primary button per state: while the notice waits, it is "Ho capito".
    await expect(primaryButtons(page)).toHaveText(["Ho capito"]);
    // Which engines Pyxis may use, and the model each gets, wait under Advanced.
    await expect(advanced(page)).toHaveAttribute("aria-expanded", "false");
    await noAxeViolations(page);
    await saveShot(page, "onboarding/2-ai-notice.png");
    await notice.getByRole("button", { name: "Ho capito" }).click();
    await expect(notice).toHaveCount(0);
    await advanced(page).click();
    await expect(page.getByRole("radio", { name: /^Automatico/ })).toBeChecked();
    // The automatic plan shares the work: both ready engines get models.
    for (const name of ["Claude", "ChatGPT"])
      await expect(
        engineRow(page, name).locator(".px-engine-model"),
      ).not.toBeEmpty({ timeout: 30000 });
    await expect(primaryButtons(page)).toHaveText(["Continua"]);
    expect(
      (await page.evaluate(() => window.pyxis.invoke("engines.overview", {})))
        .filter((row) => row.id === "claude" || row.id === "codex")
        .map((row) => row.acknowledged),
    ).toEqual([true, true]);
    // No scan download is offered in setup: it comes up only when a scan is added.
    await expect(button(page, /^Scarica [\d.,]+ MB$/)).toHaveCount(0);
    await noAxeViolations(page);
    await saveShot(page, "onboarding/2-ai-ready.png");
    // A new step opens at its top, not at the offset the last one was scrolled to.
    await page.setViewportSize({ width: 1280, height: 420 });
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
    await button(page, "Continua").click();
    await expect(
      page.getByRole("heading", { name: "Come tieni il materiale per studiare?" }),
    ).toBeVisible();
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    await page.setViewportSize({ width: 1280, height: 800 });

    // Step 3: the profile is saved when the AI step ends, with crash reports off.
    await expect(currentStep(page)).toHaveText("Passo 3 di 3: 3 · Il materiale");
    expect(await profile(page)).toMatchObject({
      displayName: "Ada",
      educationLevel: "university",
      course: "Fisica",
      crashReports: false,
      gradeScale: null,
    });
    await noNavigation(page);
    // Folders are read in place, so the step says nothing in them changes. The free books are no longer offered here.
    await expect(
      page.getByText("Pyxis legge soltanto: non sposta, non rinomina e non cancella niente nelle tue cartelle."),
    ).toBeVisible();
    await expect(button(page, "Libri PoliTost gratuiti")).toHaveCount(0);
    // Two ways to keep material, no primary action yet, and "later" ends setup.
    await expect(button(page, "Una cartella con tutto lo studio")).toBeVisible();
    await expect(primaryButtons(page)).toHaveCount(0);
    await expect(button(page, "Lo faccio dopo")).toBeVisible();
    await noAxeViolations(page);
    await saveShot(page, "onboarding/3-material.png");

    // One folder per subject asks for the folders, and Back returns to the choice with the heading focused.
    await button(page, "Una cartella per ogni materia").click();
    await expect(
      page.getByRole("heading", { name: "Dove sono le cartelle delle materie?" }),
    ).toBeFocused();
    await expect(button(page, "Scegli le cartelle")).toBeVisible();
    await expect(page.getByText("Quando aggiungi un file, lo legge da solo.", { exact: false })).toBeVisible();
    await noAxeViolations(page);
    await button(page, "Indietro").click();
    await expect(
      page.getByRole("heading", { name: "Come tieni il materiale per studiare?" }),
    ).toBeFocused();
    await button(page, "Lo faccio dopo").click();
    await expect(page).toHaveURL(/#\/ask$/);
    await expect(
      page.getByRole("navigation", { name: "Sezioni" }),
    ).toBeVisible();
    await expect(page.locator(".px-side-me")).toBeVisible();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(/^(Buongiorno|Buon pomeriggio|Buonasera)/);
    // Nothing was linked or imported, and setup makes no exam.
    expect(await page.evaluate(() => window.pyxis.invoke("sources.list", {}))).toEqual([]);
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

test("First setup: each tool shows its real state, an expired sign-in is never connected, and the student's pick of engines is saved", async () => {
  test.skip(process.platform === "win32", "stand-in CLIs are shell scripts");
  test.setTimeout(180000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-onb-"));
  const { bin, env } = fakeBins({ claude: true, codex: false });
  // Cursor Agent says it is signed in, but its provider turns every call away with a 401, as Codex did after its token
  // expired. Antigravity is not installed.
  const agent = join(bin, "agent");
  writeFileSync(
    agent,
    `#!/bin/sh
case "$1" in
  --version) echo "2026.09.28-64d2043";;
  status) echo '{"isAuthenticated":true}';;
  about) echo '{}';;
  --list-models) printf 'gemini-3.8-flash - Gemini 3.8 Flash\\nclaude-sonnet-5-5 - Claude Sonnet 5.5\\n';;
  *) echo "Error: request failed with status 401 Unauthorized" >&2; exit 1;;
esac
`,
  );
  chmodSync(agent, 0o755);
  const app = await launch(userData, { ...env, CLI_FUNNEL_AGENT_BIN: agent });
  try {
    const page = await app.firstWindow();
    await page.emulateMedia({ reducedMotion: "reduce" });
    await button(page, "Continua").click();
    await expect(cardState(page, "Cursor")).toHaveText("Collegato", { timeout: 30000 });
    await expect(cardState(page, "Claude")).toHaveText("Collegato");
    await expect(cardState(page, "ChatGPT")).toHaveText("Serve l'accesso");
    await expect(cardState(page, "Gemini")).toHaveText("Collega anche questa");
    await page
      .getByRole("region", { name: "Cosa esce da questo computer" })
      .getByRole("button", { name: "Ho capito" })
      .click();
    await advanced(page).click();
    await expect(engineRow(page, "Cursor").locator(".px-engine-model")).not.toBeEmpty({
      timeout: 30000,
    });

    // The provider refuses a call: the card turns to an expired sign-in, offers Sign in, and the plan stops using it.
    const refused = await page.evaluate(() =>
      window.pyxis
        .invoke("engines.test", { provider: "agent" })
        .then(() => "answered", (err: { code?: string }) => err.code),
    );
    expect(refused).toBe("not-logged-in");
    await expect(cardState(page, "Cursor")).toHaveText("Accesso scaduto");
    await expect(engineRow(page, "Cursor")).toContainText("Accesso scaduto");
    await button(card(page, "Cursor"), "Cursor").click();
    await expect(button(card(page, "Cursor"), "Accedi con Cursor")).toBeVisible();
    await expect
      .poll(async () =>
        Object.values(
          await page.evaluate(() => window.pyxis.invoke("engines.features", {})),
        ).map((selection) => selection.provider),
      )
      .not.toContain("agent");
    await noAxeViolations(page);

    // "I choose" starts from the engines that are ready: Claude, which cannot be unticked while it is the only one.
    await page.getByRole("radio", { name: /^Scelgo io/ }).click();
    await expect(page.getByRole("radio", { name: /^Scelgo io/ })).toBeChecked();
    const box = (name: string) => page.getByRole("checkbox", { name: `Usa ${name}` });
    await expect(box("Claude")).toBeChecked();
    await expect(box("Claude")).toBeDisabled();
    await expect(box("ChatGPT")).not.toBeChecked();
    await box("ChatGPT").click();
    await expect(box("ChatGPT")).toBeChecked();
    await expect(box("Claude")).toBeEnabled();
    const choice = () =>
      page.evaluate(() => window.pyxis.invoke("engines.choice", {}));
    await expect.poll(choice).toEqual({ allowed: ["claude", "codex"] });
    await noAxeViolations(page);

    // The pick outlasts leaving the step, and opens Advanced by itself on the way back. Automatic puts every ready
    // engine back.
    await button(page, "Continua").click();
    await button(page, "Indietro").click();
    await expect(page.getByRole("radio", { name: /^Scelgo io/ })).toBeChecked({
      timeout: 30000,
    });
    await expect(box("ChatGPT")).toBeChecked();
    await page.getByRole("radio", { name: /^Automatico/ }).click();
    await expect.poll(choice).toEqual({ allowed: null });
  } finally {
    await app.close();
    removeTestFolder(userData);
    rmSync(bin, { recursive: true, force: true });
  }
});

test("First setup: a signed-out tool offers sign-in first, with none installed nothing is picked, and later continues", async () => {
  test.skip(process.platform === "win32", "stand-in CLIs are shell scripts");
  test.setTimeout(180000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-onb-"));
  const out = fakeBins({ claude: false, codex: null });
  let app = await launch(userData, out.env);
  try {
    let page = await app.firstWindow();
    await page.emulateMedia({ reducedMotion: "reduce" });
    await button(page, "Continua").click();
    await expect(
      found(page, "Ho trovato Claude, ma serve ancora l'accesso."),
    ).toHaveCount(1, { timeout: 30000 });
    await expect(
      page.getByRole("heading", { name: "Con quale AI vuoi studiare?" }),
    ).toBeVisible();
    // The installed tool is offered first: one sign-in left, and its button is the step's one primary action.
    const claude = card(page, "Claude");
    await expect(cardState(page, "Claude")).toHaveText("Serve l'accesso");
    await expect(button(claude, "Accedi con Claude")).toBeVisible();
    await expect(claude.getByText("Si apre la pagina di Anthropic.")).toBeVisible();
    await expect(primaryButtons(page)).toHaveText(["Accedi con Claude"]);
    await expect(button(page, "Lo faccio dopo")).toBeVisible();
    await noAxeViolations(page);
    await saveShot(page, "onboarding/2-ai-signed-out.png");
    await app.close();

    const none = fakeBins({ claude: null, codex: null });
    app = await launch(userData, none.env);
    page = await app.firstWindow();
    await page.emulateMedia({ reducedMotion: "reduce" });
    await button(page, "Continua").click();
    await expect(
      found(page, "Non ho trovato nessuna AI su questo computer."),
    ).toHaveCount(1, { timeout: 30000 });
    // Nothing is picked for the student: four cards, none connected, and the step's one primary action is "later".
    for (const name of ["Claude", "ChatGPT", "Gemini", "Cursor"])
      await expect(cardState(page, name)).toHaveText("Non collegato");
    await expect(button(page, "Installa e accedi")).toHaveCount(0);
    await expect(page.getByRole("region", { name: /^Configura / })).toHaveCount(0);
    await expect(primaryButtons(page)).toHaveText(["Lo faccio dopo"]);
    // Each card links to the plans, and each link names its tool for screen readers.
    await expect(
      button(page, /^Vedi i piani di (Claude|ChatGPT|Gemini|Cursor)$/),
    ).toHaveCount(4);
    // Picking ChatGPT offers Install and sign in, with the command it runs shown first, never a GitHub page.
    await button(card(page, "ChatGPT"), "ChatGPT").click();
    const chatgpt = page.getByRole("region", { name: "Configura ChatGPT" });
    await expect(
      chatgpt.getByText("curl -fsSL 'https://chatgpt.com/codex/install.sh' | bash"),
    ).toBeVisible();
    await expect(card(page, "ChatGPT").getByText("Si apre la pagina di OpenAI.")).toBeVisible();
    await expect(primaryButtons(page)).toHaveText(["Installa e accedi"]);
    await noAxeViolations(page);
    await saveShot(page, "onboarding/2-ai-picked.png");
    // Gemini signs in from a terminal, and says so before anything runs. One tool is set up at a time.
    await button(card(page, "Gemini"), "Gemini").click();
    await expect(page.getByRole("region", { name: /^Configura / })).toHaveCount(1);
    await expect(
      page
        .getByRole("region", { name: "Configura Gemini" })
        .getByText("antigravity.google/cli/install.sh", { exact: false }),
    ).toBeVisible();
    await expect(
      card(page, "Gemini").getByText("L'accesso si fa nel terminale: ti spiego io come."),
    ).toBeVisible();
    // An API key is added later in Settings, and Advanced says so.
    await advanced(page).click();
    await expect(
      page.getByText("Una chiave API la aggiungi dopo la configurazione", { exact: false }),
    ).toBeVisible();
    await noAxeViolations(page);
    // Nothing is ready, so the footer carries on and says it will be done later.
    await button(page, "Lo faccio dopo").click();
    await expect(
      page.getByRole("heading", { name: "Come tieni il materiale per studiare?" }),
    ).toBeVisible();
    await button(page, "Indietro").click();
    await expect(currentStep(page)).toHaveText("Passo 2 di 3: 2 · L'AI");
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
    const claude = card(page, "Claude");
    await expect(button(claude, "Accedi con Claude")).toBeVisible({
      timeout: 30000,
    });
    await button(claude, "Accedi con Claude").click();
    await button(claude, "Annulla").click();
    // Idle again means Cancel is gone. The button's name is matched loosely, as antd can keep a spinner icon in it
    // until the icon's exit transition ends.
    await expect(button(claude, "Annulla")).toHaveCount(0);
    const signIn = button(claude, /Accedi con Claude$/);
    await expect(signIn).toBeVisible();
    await expect(page.getByText("Accesso non completato.")).toHaveCount(0);
    // Starting again is not undone by the answer to the cancelled attempt.
    await signIn.click();
    await expect(button(claude, "Annulla")).toBeVisible();
    // The cancelled attempt's answer would undo this within moments; its absence has no signal, so this waits a fixed time.
    await page.waitForTimeout(500);
    await expect(button(claude, "Annulla")).toBeVisible();
    await expect(page.getByText(/Accesso non completato/)).toHaveCount(0);
  } finally {
    await app.close();
    removeTestFolder(userData);
    rmSync(bin, { recursive: true, force: true });
  }
});

test("First setup: Install and sign in runs the installer, shows its output, then signs in by itself", async () => {
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
    await expect(
      found(page, "Non ho trovato nessuna AI su questo computer."),
    ).toHaveCount(1, { timeout: 30000 });
    const claude = card(page, "Claude");
    await button(claude, "Claude").click();
    await button(claude, "Installa e accedi").click();
    await expect(claude.getByText("Installo Claude…")).toBeVisible();
    await expect(
      page.getByRole("region", { name: "Configura Claude" }).getByText(/Installing claude into/),
    ).toBeVisible();
    await expect(cardState(page, "Claude")).toHaveText("Collegato", {
      timeout: 30000,
    });
    await expect(page.getByRole("heading", { name: "Claude è pronto" })).toBeVisible();
    await expect(found(page, "Ho trovato Claude.")).toHaveCount(1);
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

test("First setup: skipping leaves crash reports off, and a new profile at school sets exams out of 100", async () => {
  test.setTimeout(180000);
  const skipped = mkdtempSync(join(tmpdir(), "pyxis-onb-"));
  const engines = fakeBins({ claude: null, codex: null });
  let app = await launch(skipped, engines.env);
  try {
    const page = await app.firstWindow();
    await button(page, "Salta").click();
    await expect(page).toHaveURL(/#\/ask$/);
    expect(await profile(page)).toMatchObject({
      displayName: "",
      crashReports: false,
    });
    await app.close();

    const fresh = mkdtempSync(join(tmpdir(), "pyxis-onb-"));
    app = await launch(fresh, engines.env);
    try {
      const second = await app.firstWindow();
      await second.getByRole("radio", { name: "A scuola" }).click();
      await expect(second.getByRole("radio", { name: "Superiore" })).toBeChecked();
      await expect(second.getByRole("switch")).not.toBeChecked();
      await button(second, "Continua").click();
      await button(second, "Lo faccio dopo").click();
      await expect(
        second.getByRole("heading", { name: "Come tieni il materiale per studiare?" }),
      ).toBeVisible();
      expect(await profile(second)).toMatchObject({
        educationLevel: "upper-secondary",
        crashReports: false,
      });
      // "Later" ends setup on Chiedi with the profile kept.
      await button(second, "Lo faccio dopo").click();
      await expect(second).toHaveURL(/#\/ask$/);
      // Exams are made from Esami now. Below university their goal keeps the scale out of 100.
      await second.evaluate(() => {
        location.hash = "/plans/new";
      });
      const goal = second.getByRole("slider", { name: /^Obiettivo .* su 100$/ });
      await expect(goal).toHaveAttribute("aria-valuemin", "50");
      await expect(goal).toHaveAttribute("aria-valuenow", "75");
    } finally {
      await app.close();
      rmSync(fresh, { recursive: true, force: true });
    }
  } finally {
    rmSync(skipped, { recursive: true, force: true });
    rmSync(engines.bin, { recursive: true, force: true });
  }
});

test("Run setup again: Settings reopens you and the AI filled in, without Skip, leaves engines alone and returns to Settings", async () => {
  test.skip(process.platform === "win32", "stand-in CLIs are shell scripts");
  test.setTimeout(180000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-onb-"));
  const { bin, env } = fakeBins({ claude: true, codex: true });
  const app = await launch(userData, env);
  try {
    const page = await app.firstWindow();
    await page.emulateMedia({ reducedMotion: "reduce" });

    // First setup: a name, school, a school name, and crash reports turned on.
    await page.getByLabel("Nome", { exact: true }).fill("Ada");
    await page.getByRole("radio", { name: "A scuola" }).click();
    await page.getByLabel(/^Nome della scuola/).fill("Liceo Volta");
    await page
      .getByRole("switch", { name: "Consenti segnalazioni di crash" })
      .click();
    await button(page, "Continua").click();
    await expect(found(page, "Ho trovato Claude e ChatGPT.")).toHaveCount(1, {
      timeout: 30000,
    });
    await page
      .getByRole("region", { name: "Cosa esce da questo computer" })
      .getByRole("button", { name: "Ho capito" })
      .click();
    await advanced(page).click();
    await expect(
      engineRow(page, "ChatGPT").locator(".px-engine-model"),
    ).not.toBeEmpty({ timeout: 30000 });
    await button(page, "Continua").click();
    await button(page, "Lo faccio dopo").click();
    await expect(page).toHaveURL(/#\/ask$/);
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
      page.getByRole("heading", { name: "Ciao, come ti chiami e cosa studi?" }),
    ).toBeVisible();
    await expect(currentStep(page)).toHaveText("Passo 1 di 2: 1 · Tu");
    await expect(button(page, "Salta")).toHaveCount(0);
    await button(page, "Annulla").click();
    await expect(page).toHaveURL(/#\/settings\/profile$/);
    await button(page, "Rifai la configurazione").click();

    // You: every answer is filled in, crash reports included.
    await expect(page.getByLabel("Nome", { exact: true })).toHaveValue("Ada");
    await expect(page.getByLabel(/^Nome della scuola/)).toHaveValue("Liceo Volta");
    await expect(page.getByRole("radio", { name: "A scuola" })).toBeChecked();
    await expect(page.getByRole("radio", { name: "Superiore" })).toBeChecked();
    await expect(
      page.getByRole("switch", { name: "Consenti segnalazioni di crash" }),
    ).toBeChecked();
    await noAxeViolations(page);
    await saveShot(page, "onboarding/1-you-again.png");
    await page.getByLabel("Nome", { exact: true }).fill("Ada L.");
    await button(page, "Continua").click();

    // The AI: shows what is set up and asks nothing. No launch notice appears.
    await expect(found(page, "Ho trovato Claude e ChatGPT.")).toHaveCount(1, {
      timeout: 30000,
    });
    for (const name of ["Claude", "ChatGPT"])
      await expect(cardState(page, name)).toHaveText("Collegato");
    await advanced(page).click();
    await expect(page.getByRole("radio", { name: /^Automatico/ })).toBeChecked();
    await expect(page.getByRole("dialog")).toHaveCount(0);
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
    await expect(page).toHaveURL(/#\/ask$/);
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
    await expect(page).toHaveURL(/#\/ask$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(/^(Buongiorno|Buon pomeriggio|Buonasera)/);
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
    await expect(page).toHaveURL(/#\/ask$/);
    await page.evaluate(() => {
      location.hash = "/settings/language";
    });
    await page.getByRole("radio", { name: "Italiano", exact: true }).check();
    await expect(page.locator("html")).toHaveAttribute("lang", "it");
    await app.close();

    app = await launch(userData, { PYXIS_E2E_SYSTEM_LANGUAGES: "en-US" });
    page = await app.firstWindow();
    await expect(page).toHaveURL(/#\/ask$/);
    await expect(page.locator("html")).toHaveAttribute("lang", "it");
    await app.close();
  } finally {
    removeTestFolder(userData);
  }
});
