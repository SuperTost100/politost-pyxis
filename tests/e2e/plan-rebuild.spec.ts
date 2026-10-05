import { importPickedSource } from "./picked-source";
import AxeBuilder from "@axe-core/playwright";
import { _electron as electron, expect, test } from "@playwright/test";
import type { ElectronApplication, Page } from "@playwright/test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { manyPagePdf } from "../../src/core/sources/documents";

// Seeded responses only: the app runs its real jobs against recorded replies, no model is called.

function launch(userData: string, replies: unknown) {
  const env = {
    ...process.env,
    PYXIS_USER_DATA: userData,
    PYXIS_E2E: "1",
    PYXIS_E2E_PLAN_REPLIES: JSON.stringify(replies),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  return electron.launch({
    args: [join(process.cwd(), "out/main/index.js")],
    env,
  });
}

const intro = { markdown: "## Introduzione\n\nStudierai la fisica." };
const questions = (topics: number) => ({
  questions: Array.from({ length: 10 }, (_, i) => ({
    stem: `Domanda ${i + 1}?`,
    options: ["Uno", "Due", "Tre", "Quattro"],
    correct: 0,
    topicIndex: i % topics,
    passageIds: [],
    explanation: "Perché sì.",
  })),
});

async function skipOnboarding(page: Page) {
  await page.getByRole("button", { name: "Salta" }).click();
  await expect(
    page.getByRole("heading", { name: "Esami", exact: true }),
  ).toBeVisible();
}

test("PLAN-10 to PLAN-12 guided flow builds an editable draft plan whose general grounding survives export and import", async () => {
  const userData = mkdtempSync(join(tmpdir(), "pyxis-guided-"));
  const app = await launch(userData, {
    modules: {
      modules: [
        { title: "Cinematica", summary: "Il moto dei corpi" },
        { title: "Dinamica", summary: "Le forze" },
      ],
    },
    topics: {
      topics: [
        { title: "Cinematica del punto", summary: "Moto", subtopics: ["Velocità"] },
        { title: "Dinamica", summary: "Forze", subtopics: [] },
      ],
    },
    markdown: intro,
    questions: questions(2),
  });
  try {
    const page = await app.firstWindow();
    await skipOnboarding(page);
    await page.evaluate(() => {
      window.location.hash = "/plans/new";
    });
    await page.getByLabel("Titolo", { exact: true }).fill("Fisica generale");
    for (let i = 0; i < 3; i += 1)
      await page.getByRole("button", { name: "Continua", exact: true }).click();
    // No material chosen: Continua leads to the guided flow.
    await page.getByRole("button", { name: "Continua", exact: true }).click();
    await expect(page.getByText("Piano senza materiale")).toBeVisible();
    await page.getByRole("button", { name: "1° anno" }).click();
    await page.getByRole("button", { name: "Continua", exact: true }).click();
    await page.getByLabel("Cinematica", { exact: true }).check();
    await page.getByRole("button", { name: "Continua", exact: true }).click();
    await page.getByRole("button", { name: "Continua", exact: true }).click();
    // The draft notice and the editable tree.
    await expect(page.getByText("generato da AI").first()).toBeVisible();
    const first = page.getByLabel("Nome dell'argomento").first();
    await first.fill("Cinematica rivista");
    await page.getByRole("button", { name: "Crea il piano" }).click();
    await expect(
      page.getByRole("button", { name: "Apri il piano", exact: true }),
    ).toBeVisible({ timeout: 30000 });
    await page.getByRole("button", { name: "Apri il piano", exact: true }).click();
    // PLAN-11: the permanent notice sits on the plan.
    await expect(
      page.getByText("dalla conoscenza generale del modello", { exact: false }),
    ).toBeVisible();

    const planId = await page.evaluate(async () => {
      const list = await window.pyxis.invoke("plans.list", {});
      return list[0]!.id;
    });
    const read = (id: string) =>
      page.evaluate((x) => window.pyxis.invoke("plans.read", { planId: x }), id);
    const plan = await read(planId);
    expect(plan!.status).toBe("draft");
    expect(plan!.topics.map((t) => [t.title, t.grounding])).toEqual([
      ["Cinematica rivista", "general"],
      ["Dinamica", "general"],
    ]);

    // Export, then import as another plan: the grounding and the draft notice come along.
    const file = await page.evaluate(
      (x) => window.pyxis.invoke("plans.export", { planId: x }),
      planId,
    );
    expect(file.topics.map((t) => t.grounding)).toEqual(["general", "general"]);
    expect(file.educationLevel).toBeTruthy();
    const imported = await page.evaluate(
      (f) => window.pyxis.invoke("plans.import", f),
      file,
    );
    const copy = await read(imported.planId);
    expect(copy!.topics.map((t) => t.grounding)).toEqual(["general", "general"]);
    expect(copy!.status).toBe("draft");
    await page.evaluate((id) => {
      window.location.hash = `/plans/${id}`;
    }, imported.planId);
    await expect(
      page.getByText("dalla conoscenza generale del modello", { exact: false }),
    ).toBeVisible();
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
});

async function ready(page: Page, planId: string) {
  await expect
    .poll(
      async () =>
        (
          await page.evaluate(
            (id) => window.pyxis.invoke("plans.build", { planId: id }),
            planId,
          )
        )?.state,
      { timeout: 30000 },
    )
    .toBe("succeeded");
}

async function importSource(
  page: Page,
  app: ElectronApplication,
  dir: string,
  name: string,
  text: string,
) {
  const file = join(dir, `${name}.pdf`);
  writeFileSync(file, manyPagePdf(1, text));
  const source = (await importPickedSource(page, app, file)) as {
    sourceId: string;
  };
  await expect
    .poll(async () => {
      const rows = (await page.evaluate(() =>
        window.pyxis.invoke("sources.list", {}),
      )) as Array<{ id: string; status: string }>;
      return rows.find((row) => row.id === source.sourceId)?.status;
    })
    .toBe("ready");
  return source.sourceId;
}

test("PLAN-13 rebuild is reviewed, durable across restart, and applies exactly what was shown", async () => {
  const userData = mkdtempSync(join(tmpdir(), "pyxis-rebuild-"));
  const reply = (topics: unknown[]) => ({
    topics: { topics },
    markdown: intro,
    questions: {
      questions: Array.from({ length: 10 }, (_, i) => ({
        stem: `Domanda ${i + 1}?`,
        options: ["Uno", "Due", "Tre", "Quattro"],
        correct: 0,
        topicIndex: 0,
        passageIds: ["{{passage:0}}"],
        explanation: "Perché sì.",
      })),
    },
  });
  const moto = {
    title: "Moto",
    summary: "Velocità",
    subtopics: [],
    segmentIds: ["{{segment:0}}"],
  };
  let planId = "";
  let first = await launch(userData, reply([moto]));
  try {
    const page = await first.firstWindow();
    await skipOnboarding(page);
    const a = await importSource(
      page,
      first,
      userData,
      "a",
      "Velocity changes position over time",
    );
    const created = (await page.evaluate(
      (id) => window.pyxis.invoke("plans.create", { title: "Fisica", sourceIds: [id] }),
      a,
    )) as { planId: string };
    planId = created.planId;
    await ready(page, planId);
    const b = await importSource(
      page,
      first,
      userData,
      "b",
      "Energy is the capacity to do work",
    );
    await page.evaluate(
      ([id, source]) =>
        window.pyxis.invoke("plans.attachSources", {
          planId: id!,
          sourceIds: [source!],
        }),
      [planId, b],
    );
  } finally {
    await first.close();
  }

  // Second run: the recorded tree now has Moto and a new topic for the second source.
  first = await launch(
    userData,
    reply([
      moto,
      {
        title: "Energia",
        summary: "Lavoro",
        subtopics: [],
        segmentIds: ["{{segment:1}}"],
      },
    ]),
  );
  try {
    const page = await first.firstWindow();
    const before = (await page.evaluate(
      (id) => window.pyxis.invoke("plans.read", { planId: id }),
      planId,
    ))!;
    expect(before.topics.map((t) => t.title)).toEqual(["Moto"]);
    await page.evaluate((id) => {
      window.location.hash = `/plans/${id}/sources`;
    }, planId);
    await page
      .getByRole("button", { name: "Ricostruisci gli argomenti" })
      .click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText("Non cambia nulla finché non lo applichi")).toBeVisible();
    await dialog.getByRole("button", { name: "Confronta con le fonti" }).click();
    // The review appears once the durable job finished; closing and reopening keeps it.
    await expect(dialog.getByText("1 argomento mantenuto")).toBeVisible({
      timeout: 30000,
    });
    await expect(dialog.getByText("Energia", { exact: true })).toBeVisible();
    await expect(dialog.getByText("Nessun argomento viene archiviato.")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    expect(
      (await page.evaluate(
        (id) => window.pyxis.invoke("plans.read", { planId: id }),
        planId,
      ))!.topics,
    ).toHaveLength(1);
    await page
      .getByRole("button", { name: "Ricostruisci gli argomenti" })
      .click();
    await expect(dialog.getByText("Energia", { exact: true })).toBeVisible();
    await page.waitForTimeout(300); // Let the modal finish its entrance before measuring contrast.
    expect(
      (await new AxeBuilder({ page }).setLegacyMode(true).analyze()).violations,
    ).toEqual([]);
    await page.screenshot({ path: ".shots/m13-rebuild-review.png", animations: "disabled" });
    await dialog.getByRole("button", { name: "Applica le modifiche" }).click();
    await expect(dialog).toBeHidden();
    const after = (await page.evaluate(
      (id) => window.pyxis.invoke("plans.read", { planId: id }),
      planId,
    ))!;
    expect(after.topics.map((t) => t.title)).toEqual(["Moto", "Energia"]);
    expect(after.topics[0]!.id).toBe(before.topics[0]!.id);
  } finally {
    await first.close();
    rmSync(userData, { recursive: true, force: true });
  }
});
