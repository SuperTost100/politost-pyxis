import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchPyxis } from "./app-under-test";
import { seedPlan } from "./seed";

test("route failure shows a plain recovery page without stack details", async () => {
  const userData = mkdtempSync(join(tmpdir(), "pyxis-route-error-"));
  const app = await launchPyxis({ userData });
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Salta" }).click();
    await expect(page).toHaveURL(/#\/exams$/);
    await page.evaluate(() => { window.location.hash = "/missing-route"; });
    await expect(page.getByRole("heading", { name: "Non è stato possibile aprire questa pagina" })).toBeVisible();
    // The message sits inside the shell's page column, with the sidebar around it.
    const shellColumn = await page.locator(".shell-page").boundingBox();
    const message = await page.getByRole("alert").boundingBox();
    expect(shellColumn).not.toBeNull();
    expect(message!.x).toBeGreaterThanOrEqual(shellColumn!.x);
    expect(message!.x + message!.width).toBeLessThanOrEqual(shellColumn!.x + shellColumn!.width);
    await expect(page.locator("pre")).toHaveCount(0);
    expect((await new AxeBuilder({ page }).setLegacyMode(true).analyze()).violations).toEqual([]);
    await page.screenshot({ path: ".shots/route-error-it.png" });
    await page.getByRole("button", { name: "Torna a Esami" }).click();
    await expect(page).toHaveURL(/#\/exams$/);
    await expect(page.getByRole("heading", { name: "Non è stato possibile aprire questa pagina" })).toHaveCount(0);
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
});

test("a failed plan build says so in the title and steps, shows its message under Details and retries", async () => {
  const userData = mkdtempSync(join(tmpdir(), "pyxis-error-state-"));
  const app = await launchPyxis({ userData });
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Salta" }).click();
    await expect(page).toHaveURL(/#\/exams$/);
    const reason = "invalid-output: the model returned text that is not a topic list";
    const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), { timeout: 10000 });
    const now = Date.now();
    seedPlan(db, { id: "b", title: "Chimica", status: "building", language: "it" });
    db.prepare(
      "INSERT INTO jobs(id,kind,params_json,state,progress,step_label,error,created_at,updated_at) VALUES('jb','plan-build',?,'failed',0.3,'wizard.stepTopics',?,?,?)",
    ).run(JSON.stringify({ planId: "b" }), reason, now, now);
    const step = db.prepare("INSERT INTO job_steps(id,job_id,name,position,label,state) VALUES(?,?,?,?,?,?)");
    step.run("s0", "jb", "sources", 0, "wizard.stepSources", "succeeded");
    step.run("s1", "jb", "topics", 1, "wizard.stepTopics", "failed");
    step.run("s2", "jb", "path", 2, "wizard.stepPath", "pending");
    db.close();

    await page.evaluate(() => { window.location.hash = "/plans/new?build=b"; });
    await expect(page.getByRole("heading", { name: "Non sono riuscito a preparare il piano" })).toBeVisible();
    await expect(page.getByText("Non sono riuscito a creare gli argomenti")).toBeVisible();
    await expect(page.getByText("Creo gli argomenti")).toHaveCount(0);
    const state = page.getByRole("alert");
    await expect(state).toContainText("Un passaggio si \u00e8 fermato");
    // The technical message stays hidden until the student asks for it.
    await expect(page.getByText(reason)).toHaveCount(0);
    const details = state.getByRole("button", { name: "Dettagli" });
    await details.click();
    await expect(details).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByText(reason)).toBeVisible();
    await details.click();
    await expect(page.getByText(reason)).toHaveCount(0);
    // The action retries the job: its failure is cleared, whatever the new run ends with.
    await state.getByRole("button", { name: "Riprova", exact: true }).click();
    await expect
      .poll(async () => (await page.evaluate(() => window.pyxis.invoke("plans.build", { planId: "b" }))) as { error: string | null })
      .not.toMatchObject({ error: reason });
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
});
