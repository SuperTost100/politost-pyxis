import AxeBuilder from "@axe-core/playwright";
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
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
const button = (page: Page, name: string | RegExp) =>
  page.getByRole("button", { name, exact: typeof name === "string" });

test("First setup: name, engines found, photos later, crash reports on by default, then the switch in Settings", async () => {
  // The stand-in CLIs are POSIX shell scripts. Windows still runs the selection policy in the unit tests.
  test.skip(process.platform === "win32", "stand-in CLIs are shell scripts");
  test.setTimeout(180000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-onb-"));
  const { bin, env } = fakeBins({ claude: true, codex: true });
  const app = await launch(userData, env);
  try {
    const page = await app.firstWindow();
    await page.emulateMedia({ reducedMotion: "reduce" });
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
    await expect(page.getByText(/^Pyxis usa Codex .* Claude Code/)).toBeVisible(
      {
        timeout: 30000,
      },
    );
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
    await button(page, "Vai agli esami").click();
    await expect(page).toHaveURL(/exams/);
    expect(await profile(page)).toMatchObject({
      displayName: "Ada",
      crashReports: true,
    });

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

test("First setup: a signed-out engine offers sign-in, no engine shows install help, and I'll do it later continues", async () => {
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
    await expect(button(page, "Accedi")).toBeVisible();
    await expect(page.getByText("Come si installa")).toBeVisible();
    await noAxeViolations(page);
    await app.close();

    const none = fakeBins({ claude: null, codex: null });
    app = await launch(userData, none.env);
    page = await app.firstWindow();
    await button(page, "Continua").click();
    await expect(page.getByText("Non ho trovato nessun motore.")).toBeVisible({
      timeout: 30000,
    });
    await expect(
      page.getByText(/Pyxis ha bisogno di un motore AI/),
    ).toBeVisible();
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
