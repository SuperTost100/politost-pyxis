import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";

const require = createRequire(import.meta.url);
const electronPath = require("electron") as string;
const root = join(import.meta.dirname, "..");
const shots = join(root, ".shots");
const userData = mkdtempSync(join(tmpdir(), "pyxis-shots-"));

const routes = [
  "#/exams",
  "#/exams/library",
  "#/exams/get",
  "#/ask",
  "#/settings",
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
      (globalThis as unknown as { location: { reload: () => void } }).location.reload();
    }, locale),
  ]);
}

async function openRoute(page: Page, hash: string): Promise<void> {
  await page.evaluate((next) => {
    (globalThis as unknown as { location: { hash: string } }).location.hash = next;
  }, hash);
  await page.waitForTimeout(200);
}

try {
  app = await electron.launch({
    executablePath: electronPath,
    args: [join(root, "out/main/index.js")],
    env: { ...process.env, PYXIS_USER_DATA: userData },
  });
  const page = await app.firstWindow();
  page.on("console", (msg) => {
    if (msg.type() === "error" || msg.type() === "warning") errors.push(msg.text());
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
    const jobs = page.getByRole("button", { name: /lavori in corso/i });
    await jobs.waitFor({ timeout: 3000 });
    await jobs.click();
    await page.waitForTimeout(200);
    await page.screenshot({ path: join(shots, "jobs-running-it-dark-1280.png") });
  }
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
