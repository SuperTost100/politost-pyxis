import { expect, test } from "@playwright/test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { launchPyxis } from "./app-under-test";
import { removeTestFolder } from "./cleanup";

test("debug mode: the switch in AI tools, Advanced, and each job's AI calls in Attività", async () => {
  test.setTimeout(120000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-debug-mode-"));
  const app = await launchPyxis({ userData });
  try {
    const page = await app.firstWindow();
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.getByRole("button", { name: "Salta" }).click();
    await expect(page).toHaveURL(/#\/ask$/);

    // Off by default, and the switch lives under Advanced.
    expect(await page.evaluate(() => window.pyxis.invoke("debug.get", {}))).toEqual({ on: false });
    await page.evaluate(() => {
      location.hash = "/settings/engines";
    });
    const debugSwitch = page.getByRole("switch", { name: "Mostra dettagli tecnici e debug" });
    await expect(page.getByRole("switch", { name: "Opzioni avanzate" })).toBeVisible();
    await expect(debugSwitch).toHaveCount(0);
    await page.getByRole("switch", { name: "Opzioni avanzate" }).click();
    await expect(debugSwitch).not.toBeChecked();
    await debugSwitch.click();
    await expect(debugSwitch).toBeChecked();
    expect(await page.evaluate(() => window.pyxis.invoke("debug.get", {}))).toEqual({ on: true });

    // A job that failed, so Attività lists it, with the log debug mode kept for it in the workspace.
    const jobId = "0190c8a2-0000-7000-8000-00000000d0b9";
    const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), { timeout: 10000 });
    db.prepare(
      "INSERT INTO jobs(id, kind, params_json, state, progress, step_label, error, created_at, updated_at) VALUES (?, 'demo', '{}', 'failed', 0, NULL, 'engine-failed', ?, ?)",
    ).run(jobId, Date.now(), Date.now());
    db.close();
    await page.reload();
    const folder = join(userData, "workspace", "logs", "jobs");
    mkdirSync(folder, { recursive: true });
    const at = new Date().toISOString();
    writeFileSync(
      join(folder, `${jobId}.jsonl`),
      [
        { type: "call", at, id: "c1", provider: "claude", model: "claude-sonnet-4-6", access: "subscription", kind: "lesson", prompt: "Scrivi la lezione sul moto." },
        { type: "event", at, id: "c1", event: { type: "raw", source: "stderr", data: "loading" } },
        { type: "end", at, id: "c1", ms: 2400, text: "Il moto è il cambiamento di posizione.", textLength: 38, finishReason: "stop" },
      ]
        .map((line) => JSON.stringify(line))
        .join("\n") + "\n",
    );

    // Attività shows the job's calls under "Technical details and debug": AI, model, access and time, then the request,
    // the reply and the engine's events.
    await page.getByRole("button", { name: /^Attività/ }).click();
    const details = page.locator(".px-jobs-debug").first();
    await details.locator("summary").click();
    await expect(details).toContainText("Claude");
    await expect(details).toContainText("abbonamento");
    await expect(details).toContainText("2,4 s");
    await details.getByText("Richiesta", { exact: true }).click();
    await expect(details).toContainText("Scrivi la lezione sul moto.");
    await details.getByText("Risposta", { exact: true }).click();
    await expect(details).toContainText("Il moto è il cambiamento di posizione.");
    await expect(details.getByText("1 evento del motore")).toBeVisible();

    // "Open the log" shows the job's file in the file manager.
    await app.evaluate(({ shell }) => {
      (globalThis as unknown as { shown: string[] }).shown = [];
      shell.showItemInFolder = (path: string) => {
        (globalThis as unknown as { shown: string[] }).shown.push(path);
      };
    });
    await details.getByRole("button", { name: "Apri il registro" }).click();
    await expect
      .poll(() => app.evaluate(() => (globalThis as unknown as { shown: string[] }).shown))
      .toEqual([join(folder, `${jobId}.jsonl`)]);
    // A job id that is not one never names a file.
    expect(await page.evaluate(() => window.pyxis.revealJobLog("../../pyxis.db"))).toBe(false);

    // Turned off, the details go.
    await page.keyboard.press("Escape");
    await debugSwitch.click();
    await expect(debugSwitch).not.toBeChecked();
    await page.getByRole("button", { name: /^Attività/ }).click();
    await expect(page.locator(".px-jobs-debug")).toHaveCount(0);
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});
