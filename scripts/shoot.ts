import { strToU8, zipSync } from "fflate";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  _electron as electron,
  type ElectronApplication,
  type Page,
} from "playwright";

const require = createRequire(import.meta.url);
const electronPath = require("electron") as string;
const root = join(import.meta.dirname, "..");
const shots = join(root, ".shots");
const userData = mkdtempSync(join(tmpdir(), "pyxis-shots-"));
const book = join(userData, "demo.ptsb");

writeFileSync(
  book,
  zipSync({
    "smartbook.json": strToU8(
      JSON.stringify({
        id: "demo",
        title: "Demo",
        access: "public",
        chapters: [{ id: "c1", number: 1, title: "Moti", file: "01.md" }],
      }),
    ),
    "chapters/01.md": strToU8(
      "## p1 | Energia\nIl vettore posizione descrive il punto.\n",
    ),
    "esercizi.md": strToU8(
      ':::exercise{id="e1" chapter="1"}\nQuanto vale il lavoro?\n:::solution\nW = F s.\n:::\n:::\n',
    ),
  }),
);

const routes = [
  "#/exams",
  "#/exams/library",
  "#/exams/get",
  "#/ask",
  "#/settings",
  ...[
    "profile",
    "subjects",
    "engines",
    "tutor",
    "reading",
    "appearance",
    "language",
    "data",
    "privacy",
    "updates",
    "about",
    "diagnostics",
  ].map((section) => `#/settings/${section}`),
  "#/dev/gallery",
  "#/plans/new",
  "#/tools/graph",
  "#/tools/python",
  "#/tools/whiteboard",
];
const errors: string[] = [];

mkdirSync(shots, { recursive: true });

let app: ElectronApplication | undefined;

async function setTheme(page: Page, source: "dark" | "light"): Promise<void> {
  await page.evaluate((value) => {
    const host = globalThis as unknown as {
      pyxis: { setAppearance: (next: string) => Promise<unknown> };
    };
    return host.pyxis.setAppearance(value);
  }, source);
}

async function setLocale(page: Page, locale: "it" | "en"): Promise<void> {
  await Promise.all([
    page.waitForEvent("load"),
    page.evaluate((lng) => {
      localStorage.setItem("pyxis.lang", lng);
      (
        globalThis as unknown as { location: { reload: () => void } }
      ).location.reload();
    }, locale),
  ]);
}

async function hashOf(page: Page): Promise<string> {
  return page.evaluate(
    () =>
      (globalThis as unknown as { location: { hash: string } }).location.hash,
  );
}

async function shootStudy(page: Page): Promise<void> {
  await setLocale(page, "it");
  await setTheme(page, "dark");
  await openRoute(page, "#/exams");
  await page.getByRole("button", { name: "Nuovo piano" }).click();
  await page.locator("#plan-title").fill("Fisica");
  for (let step = 0; step < 3; step++) {
    await page.getByRole("button", { name: "Continua", exact: true }).click();
  }
  // A source imported on the material step goes into the plan with no ticking.
  await addPlanSource(page);
  for (let step = 0; step < 2; step++) {
    await page.getByRole("button", { name: "Continua", exact: true }).click();
  }
  await page.getByRole("button", { name: "Crea il piano" }).click();
  await page.getByRole("button", { name: "Apri il piano" }).click();
  await page.locator("h1", { hasText: "Fisica" }).waitFor();
  const plan = await hashOf(page);
  const planId = plan.replace("#/plans/", "");
  // The path is a map of nodes, so the study pages are opened by route from the saved plan.
  const topic = await page.evaluate(async (id) => {
    const host = globalThis as unknown as {
      pyxis: {
        invoke: (
          channel: string,
          input: unknown,
        ) => Promise<{ topics: Array<{ id: string }> }>;
      };
    };
    return (await host.pyxis.invoke("plans.read", { planId: id })).topics[0]!
      .id;
  }, planId);
  const lesson = `#/plans/${planId}/lesson/${topic}`;
  const practice = `#/plans/${planId}/practice/${topic}`;
  const quiz = `#/plans/${planId}/quiz/${topic}`;
  const cards = `#/plans/${planId}/cards/${topic}`;
  const studyRoutes = [
    ["plan", plan],
    ["lesson", lesson],
    ["practice", practice],
    ["quiz", quiz],
    ["cards", cards],
    ["simulation", `#/plans/${planId}/simulation`],
    ["map", `#/plans/${planId}/map/${topic}`],
  ] as const;
  for (const theme of ["dark", "light"] as const) {
    for (const locale of ["it", "en"] as const) {
      await setLocale(page, locale);
      await setTheme(page, theme);
      for (const [name, hash] of studyRoutes) {
        await openRoute(page, hash);
        await waitStudy(page, name);
        await page.screenshot({
          path: join(shots, `${name}-${locale}-${theme}-1280.png`),
        });
      }
    }
  }
}

// Without material the wizard leaves for the guided flow, so the material step needs a source before Continue.
async function addPlanSource(page: Page): Promise<void> {
  await page
    .getByRole("button", { name: /^(Aggiungi fonti|Add sources)$/ })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: /^(Scegli i file|Choose files)$/ })
    .click();
  await page.getByText(/^1 (fonte nel piano|source in the plan)$/).waitFor();
  // The first import closes the dialog; a file that is already in the library leaves its result open.
  const done = page
    .getByRole("dialog")
    .getByRole("button", { name: /^(Fatto|Done)$/ });
  if (await done.isVisible()) await done.click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
}

async function waitStudy(page: Page, name: string): Promise<void> {
  if (name === "plan") {
    await page.locator(".px-plan-page .px-seg-wrap").waitFor();
  } else if (name === "lesson") {
    await page.getByText("vettore posizione").waitFor();
  } else if (name === "practice") {
    await page.getByText("Quanto vale il lavoro?").waitFor();
  } else if (name === "quiz") {
    await page.getByRole("button", { name: /^(Inizia|Start)$/ }).waitFor();
  } else if (name === "cards") {
    await page.getByRole("button", { name: /^(Gira|Flip)\b/ }).waitFor();
  } else if (name === "simulation") {
    await page.getByRole("button", { name: /^(Inizia|Start)$/ }).waitFor();
  } else if (name === "map") {
    // The first visit has no map yet; the recorded reply builds it on request.
    const create = page.getByRole("button", {
      name: /^(Crea mappe|Create maps)$/,
    });
    await create
      .or(page.locator(".react-flow__node").first())
      .first()
      .waitFor();
    if (await create.isVisible()) await create.click();
    await page.locator(".react-flow__node").first().waitFor();
  }
}

async function openRoute(page: Page, hash: string): Promise<void> {
  await page.evaluate((next) => {
    (globalThis as unknown as { location: { hash: string } }).location.hash =
      next;
  }, hash);
  await page.waitForTimeout(200);
}

try {
  app = await electron.launch({
    executablePath: electronPath,
    args: [join(root, "out/main/index.js")],
    env: {
      ...process.env,
      PYXIS_USER_DATA: userData,
      PYXIS_E2E: "1",
      PYXIS_E2E_FILE: book,
      // Recorded replies stand in for an engine, so the wizard can create the plan and no model is called.
      PYXIS_E2E_MAP_REPLIES: JSON.stringify({
        title: {
          title: "Moti",
          nodes: [
            "Moto",
            "Posizione",
            "Velocità",
            "Accelerazione",
            "Traiettoria",
            "Spostamento",
            "Tempo",
            "Sistema di riferimento",
          ].map((label, i) => ({
            id: `n${i}`,
            label,
            parent: i ? "n0" : null,
            sources: "{{allPassages}}",
          })),
          edges: Array.from({ length: 7 }, (_, i) => ({
            from: "n0",
            to: `n${i + 1}`,
            label: "comprende",
          })),
        },
      }),
      PYXIS_E2E_PLAN_REPLIES: JSON.stringify({
        markdown: {
          markdown: "## Energia\n\nIl vettore posizione descrive il punto.",
        },
        questions: {
          questions: Array.from({ length: 10 }, (_, i) => ({
            stem: `Quale grandezza descrive il moto ${i + 1}?`,
            options: ["Velocità", "Calore", "Massa", "Volume"],
            correct: 0,
            topicIndex: 0,
            passageIds: [],
            explanation: "La velocità descrive il moto.",
          })),
        },
      }),
    },
  });
  const page = await app.firstWindow();
  page.on("console", (msg) => {
    if (msg.type() === "error" || msg.type() === "warning")
      errors.push(msg.text());
  });
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.setViewportSize({ width: 1280, height: 832 });

  for (const theme of ["dark", "light"] as const) {
    await setTheme(page, theme);
    for (const locale of ["it", "en"] as const) {
      await setLocale(page, locale);
      await setTheme(page, theme);
      await openRoute(page, "#/onboarding");
      await page.screenshot({
        path: join(shots, `onboarding-${locale}-${theme}-1280.png`),
      });
    }
  }

  await page.getByRole("button", { name: /Salta|Skip/ }).click();

  for (const theme of ["dark", "light"] as const) {
    for (const locale of ["it", "en"] as const) {
      await setLocale(page, locale);
      await setTheme(page, theme);
      for (const route of routes) {
        await openRoute(page, route);
        const name = `${route.slice(2).replaceAll("/", "-")}-${locale}-${theme}-1280.png`;
        await page.screenshot({ path: join(shots, name) });
        if (route === "#/plans/new") {
          await page
            .locator("#plan-title")
            .fill(locale === "it" ? "Fisica" : "Physics");
          for (let step = 1; step < 6; step++) {
            if (step === 4) await addPlanSource(page);
            await page
              .getByRole("button", { name: /^(Continua|Continue)$/ })
              .click();
            await page.screenshot({
              path: join(
                shots,
                `wizard-step-${step + 1}-${locale}-${theme}-1280.png`,
              ),
            });
          }
        } else if (route === "#/exams/library") {
          await page
            .getByRole("button", { name: /^(Aggiungi fonti|Add sources)$/ })
            .click();
          await page.getByRole("dialog").waitFor();
          await page.screenshot({
            path: join(shots, `library-import-${locale}-${theme}-1280.png`),
          });
          await page.locator(".ant-modal-close").click();
        }
      }
    }
  }

  await page.setViewportSize({ width: 960, height: 640 });
  await setLocale(page, "it");
  await setTheme(page, "dark");
  await openRoute(page, "#/exams");
  await page.screenshot({ path: join(shots, "exams-it-dark-960.png") });

  await page.setViewportSize({ width: 1280, height: 832 });
  await openRoute(page, "#/dev/gallery");
  const start = page.getByRole("button", { name: "Avvia" });
  if ((await start.count()) > 0) {
    await start.click();
    const jobs = page.getByRole("button", { name: /attività/i });
    await jobs.waitFor({ timeout: 3000 });
    await jobs.click();
    await page.waitForTimeout(200);
    await page.screenshot({
      path: join(shots, "jobs-running-it-dark-1280.png"),
    });
  }

  await shootStudy(page);
} finally {
  await app?.close();
  rmSync(userData, { recursive: true, force: true });
}

const interesting = errors.filter(
  (line) =>
    line.includes("Content Security Policy") ||
    line.includes("Electron Security Warning") ||
    line.includes("Warning:"),
);
writeFileSync(join(shots, "console.txt"), errors.join("\n"));
if (interesting.length > 0) {
  console.error(interesting.join("\n"));
  process.exit(1);
}
