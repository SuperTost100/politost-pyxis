import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { _electron as electron } from "playwright";

const require = createRequire(import.meta.url);
const electronPath = require("electron") as string;
const root = join(import.meta.dirname, "..");
const shots = join(root, ".shots");

const routes = ["#/exams", "#/ask", "#/settings", "#/dev/gallery"];
const errors: string[] = [];

mkdirSync(shots, { recursive: true });

const app = await electron.launch({
  executablePath: electronPath,
  args: [join(root, "out/main/index.js")],
});

const page = await app.firstWindow();
page.on("console", (msg) => {
  if (msg.type() === "error" || msg.type() === "warning")
    errors.push(msg.text());
});
page.on("pageerror", (error) => errors.push(String(error)));

await page.setViewportSize({ width: 1280, height: 832 });

for (const theme of ["dark", "light"] as const) {
  await page.evaluate((source) => {
    const host = globalThis as unknown as {
      pyxis: { setAppearance: (value: string) => Promise<unknown> };
    };
    return host.pyxis.setAppearance(source);
  }, theme);
  await page.waitForTimeout(250);
  for (const route of routes) {
    await page.evaluate((hash) => {
      (globalThis as unknown as { location: { hash: string } }).location.hash =
        hash;
    }, route);
    await page.waitForTimeout(200);
    const name = `${route.slice(2)}-${theme}-1280.png`;
    await page.screenshot({ path: join(shots, name) });
  }
}

await page.setViewportSize({ width: 960, height: 640 });
await page.evaluate(() => {
  const host = globalThis as unknown as {
    pyxis: { setAppearance: (value: string) => Promise<unknown> };
    location: { hash: string };
  };
  host.location.hash = "#/exams";
  return host.pyxis.setAppearance("dark");
});
await page.waitForTimeout(200);
await page.screenshot({ path: join(shots, "exams-dark-960.png") });

await page.setViewportSize({ width: 1280, height: 832 });
await page.evaluate(() => {
  (globalThis as unknown as { location: { hash: string } }).location.hash =
    "#/dev/gallery";
});
const start = page.getByRole("button", { name: "Avvia" });
if ((await start.count()) > 0) {
  await start.click();
  const jobs = page.getByRole("button", { name: /lavori in corso/i });
  await jobs.waitFor({ timeout: 3000 });
  await jobs.click();
  await page.waitForTimeout(200);
  await page.screenshot({ path: join(shots, "jobs-running-dark-1280.png") });
}

await app.close();

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
