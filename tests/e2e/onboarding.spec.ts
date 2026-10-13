import AxeBuilder from "@axe-core/playwright";
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Locator,
  type Page,
} from "@playwright/test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MAIN = join(
  process.cwd(),
  process.env.PYXIS_OUT ?? "out",
  "main/index.js",
);

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
  const env = {
    ...process.env,
    PYXIS_USER_DATA: userData,
    PYXIS_E2E: "1",
    ...extra,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  return electron.launch({ args: [MAIN], env });
}

async function noAxeViolations(page: Page) {
  // A dialog that is still fading in can measure as low contrast, so wait for finite animations to end first.
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document
            .getAnimations()
            .filter(
              (animation) =>
                animation.playState === "running" &&
                animation.effect?.getTiming().iterations !== Infinity,
            ).length,
      ),
    )
    .toBe(0);
  const found = (await new AxeBuilder({ page }).setLegacyMode(true).analyze())
    .violations;
  expect(
    found.map(
      (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`,
    ),
  ).toEqual([]);
}

const profile = (page: Page) =>
  page.evaluate(() => window.pyxis.invoke("profile.get", {})) as Promise<{
    displayName: string;
    crashReports: boolean;
  } | null>;
const button = (page: Page | Locator, name: string | RegExp) =>
  page.getByRole("button", { name, exact: typeof name === "string" });

test("First setup: welcome, name, engines found, photos later, crash reports on by default, ready, then the switch in Settings", async () => {
  // The stand-in CLIs are POSIX shell scripts. Windows still runs the selection policy in the unit tests.
  test.skip(process.platform === "win32", "stand-in CLIs are shell scripts");
  test.setTimeout(180000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-onb-"));
  const { bin, env } = fakeBins({ claude: true, codex: true });
  const app = await launch(userData, env);
  try {
    const page = await app.firstWindow();
    await page.emulateMedia({ reducedMotion: "reduce" });
    // Welcome: what Pyxis is, before any question.
    await expect(
      page.getByRole("heading", { name: "Ciao, sono Pyxis" }),
    ).toBeVisible();
    await expect(page.getByText(/Pyxis è gratis\./)).toBeVisible();
    await expect(page.getByText("Passo 1 di 4")).toHaveCount(0);
    await noAxeViolations(page);
    await button(page, "Inizia").click();
    await expect(page.getByRole("heading", { name: "Iniziamo" })).toBeVisible();
    await expect(page.getByText("Passo 1 di 4")).toBeVisible();
    await page.getByLabel("Nome", { exact: true }).fill("Ada");
    await noAxeViolations(page);
    await button(page, "Continua").click();

    // Engines: what was found, in plain words, and no model call anywhere.
    await expect(
      page.getByRole("heading", { name: "Collega un motore AI" }),
    ).toBeVisible();
    await expect(page.getByText("Passo 2 di 4")).toBeVisible();
    await expect(page.getByText("Ho trovato Claude Code e Codex.")).toBeVisible(
      {
        timeout: 30000,
      },
    );
    // One notice for both engines, here and not later in a task. Until it is confirmed Pyxis plans nothing with them.
    const notice = page.getByRole("region", {
      name: "Cosa esce da questo computer",
    });
    await expect(notice.getByText("Claude Code li invia a Anthropic.")).toBeVisible();
    await expect(notice.getByText("Codex li invia a OpenAI.")).toBeVisible();
    await expect(page.getByText(/^Pyxis usa Codex .* Claude Code/)).toHaveCount(0);
    await expect(button(page, "Continua")).toHaveCount(0);
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
    await noAxeViolations(page);
    await button(page, "Continua").click();

    // Photos: the same OCR consent card as Settings > Data. Later moves on without downloading.
    await expect(
      page.getByRole("heading", { name: "Foto e scansioni" }),
    ).toBeVisible();
    await expect(
      page.getByText("Leggere le scansioni richiede un download una tantum"),
    ).toBeVisible();
    await expect(page.getByText(/raw\.githubusercontent\.com/)).toBeVisible();
    await expect(button(page, /^Scarica [\d.,]+ MB$/)).toBeVisible();
    await noAxeViolations(page);
    await button(page, "Più tardi").click();
    expect(
      await page.evaluate(() =>
        window.pyxis.invoke("sources.ocrDataState", {}),
      ),
    ).toMatchObject({ consent: false, state: "missing" });

    // Crash reports: a real switch, already on.
    await expect(
      page.getByRole("heading", { name: "Segnalazioni di crash" }),
    ).toBeVisible();
    const crash = page.getByRole("switch", {
      name: "Invia segnalazioni di crash",
    });
    await expect(crash).toBeChecked();
    await expect(page.getByText(/^Acceso: /)).toBeVisible();
    await noAxeViolations(page);
    await button(page, "Continua").click();

    // Ready: the profile is saved and the next step is an exam.
    await expect(
      page.getByRole("heading", { name: "Tutto pronto" }),
    ).toBeVisible();
    expect(await profile(page)).toMatchObject({
      displayName: "Ada",
      crashReports: true,
    });
    await expect(button(page, "Crea il primo esame")).toBeVisible();
    await noAxeViolations(page);
    await button(page, "Vai agli esami").click();
    await expect(page).toHaveURL(/exams/);

    // The Settings switch shows the stored choice, saves each change and matches the setup wording.
    await page.evaluate(() => {
      location.hash = "/settings/privacy";
    });
    const saved = page.getByRole("switch", {
      name: "Invia segnalazioni di crash",
    });
    await expect(saved).toBeChecked();
    await noAxeViolations(page);
    await saved.click();
    await expect(saved).not.toBeChecked();
    await expect(
      page.getByText("Spento: nessun rapporto lascia questo computer."),
    ).toBeVisible();
    await expect
      .poll(async () => (await profile(page))?.crashReports)
      .toBe(false);
    await page.reload();
    await expect(
      page.getByRole("switch", { name: "Invia segnalazioni di crash" }),
    ).not.toBeChecked();
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
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
    await button(page, "Inizia").click();
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
    await button(page, "Inizia").click();
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
    await expect(button(page, "Configura")).toHaveCount(4);
    await noAxeViolations(page);
    // Nothing is ready, so the one primary action says what happens: carry on and sign in later.
    await button(page, "Lo farò dopo").click();
    await expect(
      page.getByRole("heading", { name: "Foto e scansioni" }),
    ).toBeVisible();
    await button(page, "Indietro").click();
    await expect(page.getByText("Passo 2 di 4")).toBeVisible();
    rmSync(none.bin, { recursive: true, force: true });
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
    rmSync(out.bin, { recursive: true, force: true });
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
    await button(page, "Inizia").click();
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
    rmSync(userData, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
  }
});

test("First setup: skipping leaves crash reports off, and the OCR download shows progress and can continue in the background", async () => {
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

    // A local proxy holds the connection open, so nothing reaches GitHub and the download stays in progress.
    const proxy: Server = createServer((socket) => {
      socket.on("error", () => undefined);
    });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
    const fresh = mkdtempSync(join(tmpdir(), "pyxis-onb-"));
    app = await launch(fresh, {
      ...engines.env,
      NODE_USE_ENV_PROXY: "1",
      HTTPS_PROXY: url,
      https_proxy: url,
    });
    try {
      const second = await app.firstWindow();
      await button(second, "Inizia").click();
      await button(second, "Continua").click();
      await button(second, "Lo farò dopo").click();
      await button(second, /^Scarica [\d.,]+ MB$/).click();
      await expect(
        second.getByRole("progressbar", {
          name: "Scarico i dati di lettura delle scansioni",
        }),
      ).toBeVisible();
      await expect(
        second.getByText("Il download continua anche se vai avanti."),
      ).toBeVisible();
      await button(second, "Annulla il download").click();
      await expect(
        second.getByText(/Il download è stato annullato/),
      ).toBeVisible();
      await button(second, "Più tardi").click();
      await expect(second.getByRole("switch")).toBeChecked();
    } finally {
      await app.close();
      proxy.close();
      rmSync(fresh, { recursive: true, force: true });
    }
  } finally {
    rmSync(skipped, { recursive: true, force: true });
    rmSync(engines.bin, { recursive: true, force: true });
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
    await expect(notice(page).getByText("Claude Code li invia a Anthropic.")).toBeVisible();
    await expect(notice(page).getByText("Codex li invia a OpenAI.")).toBeVisible();
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
    await page.waitForTimeout(2000);
    await expect(notice(page)).toHaveCount(0);
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
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
    rmSync(userData, { recursive: true, force: true });
  }
});
