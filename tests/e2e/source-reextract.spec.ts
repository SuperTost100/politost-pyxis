import AxeBuilder from "@axe-core/playwright";
import { _electron as electron, expect, test, type Page } from "@playwright/test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { blobParts } from "../../src/shared/blob-path";
import { importPickedSource } from "./picked-source";

const MAIN = join(process.cwd(), process.env.PYXIS_OUT ?? "out", "main/index.js");

/** Reads the workspace database next to the running app; WAL lets a second reader see committed rows. */
function rows<T>(userData: string, sql: string, ...args: string[]): T[] {
  const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), { readOnly: true });
  try {
    return db.prepare(sql).all(...args) as T[];
  } finally {
    db.close();
  }
}

async function readAgain(page: Page, title: string, answer: "accept" | "dismiss") {
  const asked: string[] = [];
  page.once("dialog", (dialog) => {
    asked.push(dialog.message());
    void (answer === "accept" ? dialog.accept() : dialog.dismiss());
  });
  await page.getByRole("button", { name: `Azioni per ${title}` }).click();
  await page.getByRole("menuitem", { name: "Leggi di nuovo" }).click();
  await expect.poll(() => asked.length).toBe(1);
  return asked[0]!;
}

test("SRC-12 reading a source again asks first, keeps the old reading and its citations, and survives an empty result", async () => {
  test.setTimeout(120000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-reextract-"));
  const file = join(userData, "fisica.txt");
  writeFileSync(file, "La velocità descrive lo spostamento nel tempo.\n\nL'energia cinetica dipende dalla velocità.\n");
  // The recorded-reply seam also selects the fixture engine plan creation requires; no model is called.
  const env = { ...process.env, PYXIS_USER_DATA: userData, PYXIS_E2E: "1", PYXIS_E2E_PLAN_REPLIES: "{}" };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: [MAIN], env });
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Salta" }).click();
    const invoke = <T>(channel: string, input: object) =>
      page.evaluate(
        ([c, i]) =>
          window.pyxis.invoke(c as never, i as never).catch((error: unknown) => {
            throw new Error(JSON.stringify(error));
          }),
        [channel, input] as const,
      ) as Promise<T>;
    const { sourceId } = (await importPickedSource(page, app, file)) as { sourceId: string };
    await expect
      .poll(async () => (await invoke<Array<{ id: string; status: string }>>("sources.list", {})).find((row) => row.id === sourceId)?.status)
      .toBe("ready");
    await invoke("sources.rename", { sourceId, title: "La mia fisica" });
    const { planId } = await invoke<{ planId: string }>("plans.create", { title: "Fisica", sourceIds: [sourceId] });
    // A lesson cites the first reading's passage: after reading again it must still resolve, marked out of date.
    const [{ id: passageId }] = rows<{ id: string }>(userData, "SELECT id FROM passages WHERE source_id = ? ORDER BY created_at, rowid", sourceId);
    const seed = new DatabaseSync(join(userData, "workspace", "pyxis.db"));
    seed.prepare("INSERT INTO items(id,plan_id,kind,body_json,created_at) VALUES('cites-old',?,'lesson','{}',1)").run(planId);
    seed.prepare("INSERT INTO item_passages(item_id,passage_id) VALUES('cites-old',?)").run(passageId!);
    seed.close();
    const versions = () =>
      rows<{ version: number }>(userData, "SELECT version FROM source_documents WHERE source_id = ? ORDER BY version", sourceId).map((row) => row.version);
    const jobs = () => rows<{ state: string; error: string | null }>(userData, "SELECT state, error FROM jobs WHERE json_extract(params_json, '$.reextract') = 1 ORDER BY created_at, rowid");
    expect(versions()).toEqual([1]);

    await page.evaluate(() => {
      window.location.hash = "/exams/library";
    });
    await expect(page.getByRole("button", { name: "La mia fisica", exact: true })).toBeVisible();

    // Declining the plan-use confirmation starts nothing.
    const message = await readAgain(page, "La mia fisica", "dismiss");
    expect(message).toMatch(/1 piano usa questa fonte/);
    await page.waitForTimeout(500);
    expect(jobs()).toEqual([]);
    expect(versions()).toEqual([1]);

    // Accepting reads the stored original again as version 2 of the same source.
    await readAgain(page, "La mia fisica", "accept");
    await expect(page.getByText("La mia fisica viene riletta.")).toBeVisible();
    await expect.poll(() => jobs()).toEqual([{ state: "succeeded", error: null }]);
    expect(versions()).toEqual([1, 2]);
    const source = rows<{ title: string; status: string; kind: string }>(userData, "SELECT title, status, kind FROM sources WHERE id = ?", sourceId)[0];
    expect(source).toEqual({ title: "La mia fisica", status: "ready", kind: "text" });
    const passages = rows<{ id: string; version: number }>(
      userData,
      "SELECT p.id, d.version FROM passages p JOIN source_documents d ON d.id = p.document_id WHERE p.source_id = ?",
      sourceId,
    );
    // Old passages stay for citations; the new reading adds its own.
    expect(passages.some((row) => row.id === passageId && row.version === 1)).toBe(true);
    expect(passages.some((row) => row.version === 2)).toBe(true);
    expect(rows<{ stale: number }>(userData, "SELECT stale FROM item_passages WHERE item_id = 'cites-old'")).toEqual([{ stale: 1 }]);

    // An original that now reads as empty is refused: nothing is published and the earlier reading survives.
    const sha = rows<{ sha: string }>(userData, "SELECT blob_sha AS sha FROM sources WHERE id = ?", sourceId)[0]!.sha;
    const [folder, dir, name] = blobParts(sha);
    writeFileSync(join(userData, "workspace", folder, dir, name), "   \n\n");
    await readAgain(page, "La mia fisica", "accept");
    await expect.poll(() => jobs().at(-1)).toEqual({ state: "failed", error: "reextract-no-text" });
    expect(versions()).toEqual([1, 2]);
    expect(rows<{ status: string }>(userData, "SELECT status FROM sources WHERE id = ?", sourceId)).toEqual([{ status: "ready" }]);
    await page.getByRole("button", { name: /attività|background tasks|jobs running|1 attività/i }).first().click();
    await expect(page.getByText("Rileggendo il file non è uscito testo, quindi è rimasta la lettura precedente.")).toBeVisible();
    await page.waitForTimeout(300); // Let the popover finish its entrance before measuring contrast.
    mkdirSync(".shots", { recursive: true });
    await page.screenshot({ path: ".shots/source-reextract-no-text-it.png", animations: "disabled" });
    expect((await new AxeBuilder({ page }).setLegacyMode(true).analyze()).violations).toEqual([]);
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
});
