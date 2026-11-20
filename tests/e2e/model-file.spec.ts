import { expect, test, type Page } from "@playwright/test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchPyxis } from "./app-under-test";
import { removeTestFolder } from "./cleanup";
import { standInTools, useTools } from "./tools";

type Asked = { method?: string; url?: string; headers: IncomingHttpHeaders };

/** A local stand-in for raw.githubusercontent.com: it answers every request with `body` and keeps what it was asked. */
async function serve(body: string): Promise<{ server: Server; url: string; asked: Asked[] }> {
  const asked: Asked[] = [];
  const server = createServer((request, response) => {
    asked.push({ method: request.method, url: request.url, headers: request.headers });
    response.writeHead(200, { "content-type": "text/plain" });
    response.end(body);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/resources/model-roles.json`, asked };
}

/** The shipped file with Gemini's three roles on Gemini 3.1 Pro and a date that is later than any real one. */
function newerFile(): string {
  const file = JSON.parse(readFileSync(join(import.meta.dirname, "../../resources/model-roles.json"), "utf8"));
  file.updatedAt = "2099-01-01T00:00:00Z";
  for (const role of Object.values(file.tools.antigravity.roles) as Array<{ models: string[] }>) role.models = ["gemini-3.1-pro"];
  return JSON.stringify(file);
}

/** The provider and model each task runs on, once each. */
const modelsOfTasks = (page: Page) =>
  page.evaluate(async () => {
    const features = (await window.pyxis.invoke("engines.features", {})) as Record<string, { provider: string; model: string }>;
    return [...new Set(Object.values(features).map((selection) => `${selection.provider}/${selection.model}`))];
  });

async function run(
  env: Record<string, string>,
  expected: string[],
  checks?: (page: Page, userData: string) => Promise<void>,
) {
  const userData = mkdtempSync(join(tmpdir(), "pyxis-model-file-"));
  const tools = standInTools(["antigravity"]);
  // This spec adds one test seam: PYXIS_E2E_MODEL_FILE_URL names where the model file is read from. Without it the
  // run has no network for the file at all.
  const app = await launchPyxis({ userData, env: { ...tools.env, ...env } });
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Salta" }).click();
    await expect(page).toHaveURL(/#\/ask$/);
    await useTools(page, ["antigravity"]);
    await expect.poll(() => modelsOfTasks(page), { timeout: 30_000 }).toEqual(expected);
    await checks?.(page, userData);
  } finally {
    await app.close();
    removeTestFolder(userData);
    rmSync(tools.bin, { recursive: true, force: true });
  }
}

test.describe("the model file", () => {
  test.skip(process.platform === "win32", "stand-in tools are shell scripts");
  test.setTimeout(120_000);

  test("a newer file from the repository changes the model of each role, and the request carries nothing of the student", async () => {
    const { server, url, asked } = await serve(newerFile());
    try {
      await run({ PYXIS_E2E_MODEL_FILE_URL: url }, ["antigravity/gemini-3.1-pro"], async (page) => {
        await page.evaluate(() => {
          localStorage.setItem("pyxis.lang", "en");
          location.hash = "/settings/engines";
        });
        await page.reload();
        // The row names the model of each role from the newer file, and no other.
        const row = page.locator('.engines-tool[data-tool="antigravity"]');
        await expect(row.locator("[data-role]")).toHaveText(["Fast Gemini 3.1 Pro", "Balanced Gemini 3.1 Pro", "Strong Gemini 3.1 Pro"], { timeout: 30_000 });
        await expect(row).not.toContainText("Gemini 3.8 Flash");
      });
      expect(asked).toHaveLength(1);
      const [request] = asked;
      expect(request!.method).toBe("GET");
      expect(new URL(request!.url!, "http://x").search).toBe("");
      for (const header of ["cookie", "authorization", "referer", "origin", "x-github-api-version"])
        expect(request!.headers[header], header).toBeUndefined();
      expect(request!.headers["user-agent"] ?? "").not.toMatch(/pyxis|politost/i);
    } finally {
      server.close();
    }
  });

  test("a file that does not validate leaves the copy shipped with the app in use", async () => {
    const { server, url, asked } = await serve(JSON.stringify({ version: 1, updatedAt: "2099-01-01T00:00:00Z", tools: {} }));
    try {
      await run({ PYXIS_E2E_MODEL_FILE_URL: url }, ["antigravity/gemini-4-argon", "antigravity/gemini-3.8-flash"], async (page, userData) => {
        // The shipped selection is there before the download is read, so it proves nothing by itself. The sync writes
        // `checkedAt` once it has asked and judged the answer, rejected or not.
        const stored = () => {
          try {
            return JSON.parse(readFileSync(join(userData, "model-roles.json"), "utf8")) as { checkedAt?: number; file?: unknown };
          } catch {
            return undefined;
          }
        };
        await expect.poll(() => typeof stored()?.checkedAt, { timeout: 30_000 }).toBe("number");
        // A file that was rejected is not kept.
        expect(stored()!.file).toBeUndefined();
        await expect.poll(() => modelsOfTasks(page)).toEqual(["antigravity/gemini-4-argon", "antigravity/gemini-3.8-flash"]);
      });
      expect(asked).toHaveLength(1);
    } finally {
      server.close();
    }
  });

  test("with no seam the run has no network for the file, and the shipped copy is used", async () => {
    await run({}, ["antigravity/gemini-4-argon", "antigravity/gemini-3.8-flash"]);
  });
});
