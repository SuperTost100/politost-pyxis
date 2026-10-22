import {
  expect,
  test,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFakeOllama } from "../../src/core/engine/fake-ollama";
import { launchPyxis } from "./app-under-test";

const GIB = 1024 ** 3;
// Screenshots for review go here when set. The checks run either way.
const shots = process.env.PYXIS_LOCAL_SHOTS;

const capable = {
  platform: "linux",
  ramBytes: 32 * GIB,
  freeDiskBytes: 400e9,
  complete: true,
  gpus: [
    {
      vendor: "amd",
      name: "1002:73BF",
      vramBytes: 17163091968,
      unified: false,
    },
  ],
};
const weak = {
  platform: "win32",
  ramBytes: 16 * GIB,
  freeDiskBytes: 120e9,
  complete: true,
  gpus: [
    {
      vendor: "intel",
      name: "Intel(R) UHD Graphics 620",
      vramBytes: GIB,
      unified: false,
    },
  ],
};

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function launch(
  userData: string,
  env: Record<string, string>,
): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await launchPyxis({
    userData,
    // No real Ollama, engine CLI or graphics card takes part.
    env: { CLI_FUNNEL_NO_SHELL_PATH: "1", ...env },
  });
  const page = await app.firstWindow();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.getByRole("button", { name: "Salta" }).click();
  await expect(page).toHaveURL(/#\/exams$/);
  return { app, page };
}

async function openEngines(
  page: Page,
  language: "en" | "it",
  theme: "light" | "dark",
): Promise<void> {
  await page.evaluate(
    async ({ language, theme }) => {
      localStorage.setItem("pyxis.lang", language);
      await window.pyxis.setAppearance(theme);
      location.hash = "/settings/engines";
    },
    { language, theme },
  );
  await page.reload();
}

async function shoot(page: Page, name: string, locator?: string) {
  if (!shots) return;
  mkdirSync(shots, { recursive: true });
  for (const width of [1280, 420]) {
    await page.setViewportSize({ width, height: 900 });
    if (locator) await page.locator(locator).first().scrollIntoViewIfNeeded();
    // Let the resized page finish painting before the picture.
    await page.waitForTimeout(400);
    await page.screenshot({
      path: join(shots, `${name}-${width}.png`),
      fullPage: false,
    });
  }
  await page.setViewportSize({ width: 1280, height: 900 });
}

test("LOCAL-01 a computer that cannot run a model gets no suggestion, and Settings explains why", async () => {
  test.setTimeout(120_000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-local-weak-"));
  const ollama = await startFakeOllama();
  const { app, page } = await launch(userData, {
    PYXIS_E2E_HARDWARE: JSON.stringify(weak),
    OLLAMA_HOST: ollama.url,
  });
  try {
    for (const theme of ["light", "dark"] as const) {
      await openEngines(page, "en", theme);
      const why = page.locator(".px-local-why");
      await expect(why).toBeVisible({ timeout: 30_000 });
      await expect(page.locator(".px-local")).toHaveCount(0);
      // Closed until the student looks for it.
      await expect(
        why.getByText(/needs an NVIDIA or AMD graphics card/),
      ).toBeHidden();
      await why.getByText("Run a model on this computer").click();
      await expect(
        why.getByText(
          /needs an NVIDIA or AMD graphics card with at least 6 GB/,
        ),
      ).toBeVisible();
      await expect(why.getByText(/16 GB of RAM/)).toBeVisible();
      await shoot(page, `cannot-run-${theme}`, ".px-local-why");
    }
    await openEngines(page, "it", "light");
    await page.locator(".px-local-why summary").click();
    await expect(
      page.getByText(/Con il solo processore è troppo lento/),
    ).toBeVisible();
    // Nothing was downloaded or asked of the model.
    expect(
      ollama.requests.filter(
        (r) => r.path === "/api/pull" || r.path === "/api/chat",
      ),
    ).toEqual([]);
  } finally {
    await app.close();
    await ollama.close();
    rmSync(userData, { recursive: true, force: true });
  }
});

test("LOCAL-02 a capable computer gets the suggestion, links to Ollama, downloads with progress and turns the model on after the check", async () => {
  test.setTimeout(180_000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-local-gpu-"));
  const port = await freePort();
  const { app, page } = await launch(userData, {
    PYXIS_E2E_HARDWARE: JSON.stringify(capable),
    OLLAMA_HOST: `127.0.0.1:${port}`,
  });
  const valid = JSON.stringify({
    question: "Where does photosynthesis take place?",
    options: ["Chloroplasts", "Mitochondria", "Nucleus", "Ribosomes"],
    answer: 0,
    explanation: "The passage says it happens in the chloroplasts.",
  });
  let ollama: Awaited<ReturnType<typeof startFakeOllama>> | undefined;
  try {
    await openEngines(page, "en", "light");
    const card = page.locator(".px-local");
    await expect(
      card.getByText("This computer can run a model by itself"),
    ).toBeVisible({ timeout: 30_000 });
    await expect(card.getByText(/Pyxis suggests Gemma 3 12B/)).toBeVisible();
    // Ollama is not running yet: the card links to its installer instead of bundling it.
    await expect(
      card.getByRole("button", { name: "Get Ollama" }),
    ).toBeVisible();
    await shoot(page, "suggest-no-ollama-light", ".px-local");

    ollama = await startFakeOllama({
      port,
      pull: { bytes: 8.1e9, steps: 80, delayMs: 100 },
      replies: [
        // About 40 tokens per second, a realistic speed for this card.
        {
          text: Array.from({ length: 80 }, () => "word").join(" "),
          tokens: 80,
          delayMs: 25,
        },
        { text: valid },
      ],
    });
    await card.getByRole("button", { name: "Check again" }).click();
    const download = card.getByRole("button", { name: "Download 8.1 GB" });
    await expect(download).toBeVisible({ timeout: 15_000 });
    for (const theme of ["light", "dark"] as const) {
      await openEngines(page, "en", theme);
      await expect(
        page
          .locator(".px-local")
          .getByRole("button", { name: "Download 8.1 GB" }),
      ).toBeVisible({ timeout: 15_000 });
      await shoot(page, `suggest-${theme}`, ".px-local");
    }
    await openEngines(page, "en", "light");
    await page
      .locator(".px-local")
      .getByRole("button", { name: "Download 8.1 GB" })
      .click();
    await expect(page.getByText("Downloading Gemma 3 12B")).toBeVisible();
    await expect(
      page.getByRole("status").filter({ hasText: /of 8\.1 GB, \d+%/ }),
    ).toBeVisible();
    await shoot(page, "downloading-light", ".px-local");
    await page.evaluate(() => window.pyxis.setAppearance("dark"));
    await shoot(page, "downloading-dark", ".px-local");
    await page.evaluate(() => window.pyxis.setAppearance("light"));

    await expect(
      page.getByText("Gemma 3 12B runs on this computer"),
    ).toBeVisible({ timeout: 60_000 });
    const use = page.getByRole("switch", { name: "Use the local model" });
    await expect(use).toBeChecked();
    for (const theme of ["light", "dark"] as const) {
      await openEngines(page, "en", theme);
      await expect(page.getByText(/tokens per second/)).toBeVisible({
        timeout: 15_000,
      });
      await shoot(page, `ready-${theme}`, ".px-local");
      await shoot(page, `disclosure-${theme}`, ".engines-panel > .px-notice");
    }
    // The summary names the local model once it has tasks.
    await expect(page.locator(".engines-summary")).toContainText("Ollama");
    // With only the local model, the disclosure says nothing leaves the computer.
    await expect(
      page.getByText(
        "Every task uses the model on this computer, so nothing leaves it.",
      ),
    ).toBeVisible();
    await openEngines(page, "it", "light");
    await expect(
      page.getByText("Gemma 3 12B gira su questo computer"),
    ).toBeVisible({ timeout: 15_000 });

    // With no CLI or key the local model takes every task, plans included, since it passed the format check.
    const plan = await page.evaluate(async () => {
      const result = (await window.pyxis.invoke(
        "engines.autoConfigure",
        {},
      )) as {
        features: Record<string, { provider: string; model: string }>;
      };
      return result.features.plan;
    });
    expect(plan).toMatchObject({ provider: "ollama", model: "gemma3:12b" });
    const chats = ollama.requests.filter((r) => r.path === "/api/chat");
    expect(chats).toHaveLength(2);
    expect(chats[1]!.body).toMatchObject({
      format: { type: "object" },
      options: { num_ctx: 16384 },
    });

    // Off hands the tasks back.
    await page.getByRole("switch", { name: "Usa il modello locale" }).click();
    await expect(
      page.getByRole("switch", { name: "Usa il modello locale" }),
    ).not.toBeChecked();
    const features = await page.evaluate(() =>
      window.pyxis.invoke("engines.features", {}),
    );
    expect(
      Object.values(features as Record<string, { provider: string }>).map(
        (f) => f.provider,
      ),
    ).not.toContain("ollama");
  } finally {
    await app.close();
    await ollama?.close();
    rmSync(userData, { recursive: true, force: true });
  }
});
