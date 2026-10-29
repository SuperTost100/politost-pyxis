import { importPickedSource } from "./picked-source";
import { expect, test } from "@playwright/test";
import type { ElectronApplication, Page } from "@playwright/test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { manyPagePdf } from "../../src/core/sources/test-pdf";
import { launchPyxis } from "./app-under-test";
import { expectNoAxeViolations } from "./axe";
import { animationsSettled } from "./settled";
import { saveShot } from "./shots";

// Seeded responses only: the app runs its real jobs against recorded replies, no model is called.

// A hidden window never finishes a modal's leave animation, so every page here asks for reduced motion.
function launch(userData: string, replies: unknown) {
  const env = {
    PYXIS_E2E_PLAN_REPLIES: JSON.stringify(replies),
  };
  return launchPyxis({ userData, env });
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
  // Skipping saves the profile, then moves to Exams; wait so a reload or route change cannot land on setup.
  await expect(page).toHaveURL(/#\/exams$/);
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
    await page.emulateMedia({ reducedMotion: "reduce" });
    await skipOnboarding(page);
    await page.evaluate(() => {
      window.location.hash = "/plans/new";
    });
    await page.getByLabel("Nome dell'esame", { exact: true }).fill("Fisica generale");
    // The exam step: nothing is chosen for the student, who has no date yet.
    await expect(page.getByRole("button", { name: "Continua", exact: true })).toBeDisabled();
    await expect(
      page.getByText("Scegli la data, oppure Non ho ancora la data, per continuare."),
    ).toBeVisible();
    await page.getByRole("button", { name: "Non ho ancora la data", exact: true }).click();
    await expect(
      page.getByText("Nessuna data per ora. Puoi aggiungerla dopo nelle impostazioni dell'esame."),
    ).toBeVisible();
    await page.getByRole("button", { name: "Continua", exact: true }).click();
    // No material chosen: Continua leads to the guided flow.
    await page.getByRole("button", { name: "Continua", exact: true }).click();
    await expect(page.getByText("Esame senza materiale")).toBeVisible();
    await page.getByRole("button", { name: "1° anno" }).click();
    await page.getByRole("button", { name: "Continua", exact: true }).click();
    await page.getByLabel("Cinematica", { exact: true }).check();
    await page.getByRole("button", { name: "Continua", exact: true }).click();
    await page.getByRole("button", { name: "Continua", exact: true }).click();
    // The draft notice and the editable tree.
    await expect(page.getByText("generato da AI").first()).toBeVisible();
    const first = page.getByLabel("Nome dell'argomento").first();
    await first.fill("Cinematica rivista");
    await page.getByRole("button", { name: "Crea l'esame" }).click();
    await expect(
      page.getByRole("button", { name: "Apri l'esame", exact: true }),
    ).toBeVisible({ timeout: 30000 });
    await page.getByRole("button", { name: "Apri l'esame", exact: true }).click();
    // PLAN-11: the permanent notice sits on the plan.
    await expect(
      page.getByText("dalla conoscenza generale del modello", { exact: false }),
    ).toBeVisible();
    await expect(page.getByText("Nessuna data d'esame", { exact: false })).toBeVisible();

    const planId = await page.evaluate(async () => {
      const list = await window.pyxis.invoke("plans.list", {});
      return list[0]!.id;
    });
    const read = (id: string) =>
      page.evaluate((x) => window.pyxis.invoke("plans.read", { planId: x }), id);
    const plan = await read(planId);
    expect(plan!.status).toBe("draft");
    expect(plan!.examAt).toBeNull();
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
    expect(copy!.examAt).toBeNull();

    // The date can come later, from the plan's settings.
    const year = new Date().getFullYear() + 1;
    await page.getByRole("button", { name: "Impostazioni dell'esame" }).click();
    const settings = page.locator(".px-exam-settings");
    await expect(settings.getByLabel("Data dell'esame")).toHaveValue("");
    await settings.getByLabel("Data dell'esame").fill(`15/03/${year}`);
    await page.keyboard.press("Enter");
    const saveBar = page.getByRole("region", { name: "Modifiche da salvare" });
    await expect(saveBar).toContainText("1 modifica da salvare: le prove.");
    await saveBar.getByRole("button", { name: "Salva modifiche" }).click();
    await expect(saveBar).toHaveCount(0);
    expect(new Date((await read(planId))!.examAt!)).toEqual(new Date(year, 2, 15, 12));
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
    await page.emulateMedia({ reducedMotion: "reduce" });
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
    await page.emulateMedia({ reducedMotion: "reduce" });
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
    // Let the modal finish its entrance before measuring contrast.
    await animationsSettled(page);
    await expectNoAxeViolations(page);
    await saveShot(page, "m13-rebuild-review.png", { animations: "disabled" });
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
