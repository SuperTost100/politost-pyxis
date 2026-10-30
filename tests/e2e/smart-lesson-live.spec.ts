import { expect, test } from "@playwright/test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { importPickedSource } from "./picked-source";
import { launchPyxis } from "./app-under-test";
import { makeBook } from "./book";
import { expectNoAxeViolations } from "./axe";
import { saveShot } from "./shots";
import { removeTestFolder } from "./cleanup";

const block = (kind: string, body: unknown) =>
  ["```pyxis-" + kind, JSON.stringify(body), "```"].join("\n");

const checkOne = block("check", {
  question: "Che cosa vale la forza totale a velocità costante?",
  options: ["È nulla", "Spinge nel verso del moto", "Cresce col tempo"],
  answer: 0,
  explanation: "Velocità costante vuol dire accelerazione nulla.",
});
const checkTwo = block("check", {
  question: "Quale legge lega forza, massa e accelerazione?",
  options: [
    "La seconda legge di Newton",
    "La legge di Ohm",
    "La legge di Boyle",
  ],
  answer: 0,
  explanation: "$F = ma$.",
});
const recap = block("recap", {
  questions: [
    { question: "Unità della forza?", options: ["Newton", "Joule"], answer: 0 },
    {
      question: "Raddoppi la forza: l'accelerazione…",
      options: ["raddoppia", "si dimezza"],
      answer: 0,
    },
  ],
});
const head = [
  "## Prima idea",
  "",
  "Una forza cambia il moto.",
  "",
  checkOne,
  "",
].join("\n");
const lesson = [
  head,
  "## Seconda idea",
  "",
  "Forza, massa e accelerazione.",
  "",
  checkTwo,
  "",
  recap,
].join("\n");
// What the reader gets before the lesson ends: one closed check and the start of the next block.
const streamed = `${head}\n## Seconda idea\n\nForza, massa e accelerazione.\n\n\`\`\`pyxis-check\n{"question": "Qual`;

test("a quick check can be answered while the lesson is still being written, and counts once it is saved", async () => {
  test.setTimeout(180000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-live-"));
  const hold = join(userData, "release");
  const book = join(userData, "fisica.ptsb");
  writeFileSync(
    book,
    makeBook({
      id: "live",
      chapters: [{ title: "Forze", text: "## p1 | Forza\nLa forza cambia lo stato di moto.\n" }],
    }),
  );
  const replies = {
    markdown: { markdown: lesson, streamed, hold },
    questions: {
      questions: Array.from({ length: 10 }, (_, i) => ({
        stem: `Che cosa cambia una forza ${i + 1}?`,
        options: ["Il moto", "Il colore", "La massa", "Il volume"],
        correct: 0,
        topicIndex: 0,
        passageIds: ["{{passage:0}}"],
        explanation: "Una forza cambia il moto.",
      })),
    },
  };
  const env = {
    PYXIS_E2E_PLAN_REPLIES: JSON.stringify(replies),
    // Each model call waits first, so there is a moment where a lesson is being written and no text has arrived.
    PYXIS_E2E_PLAN_DELAY: "1500",
  };
  const app = await launchPyxis({ userData, env });
  try {
    const page = await app.firstWindow();
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.getByRole("button", { name: "Salta" }).click();
    await expect(page).toHaveURL(/#\/exams$/);
    const { sourceId } = (await importPickedSource(page, app, book)) as {
      sourceId: string;
    };
    await expect
      .poll(
        async () =>
          (
            (await page.evaluate(() =>
              window.pyxis.invoke("sources.list", {}),
            )) as Array<{
              id: string;
              status: string;
            }>
          ).find((row) => row.id === sourceId)?.status,
      )
      .toBe("ready");
    const { planId } = (await page.evaluate(
      (sourceId) =>
        window.pyxis.invoke("plans.create", {
          title: "Fisica 1",
          sourceIds: [sourceId],
          language: "it",
        }),
      sourceId,
    )) as { planId: string };
    await expect
      .poll(
        async () =>
          (
            (await page.evaluate(
              (planId) => window.pyxis.invoke("plans.build", { planId }),
              planId,
            )) as {
              state: string;
            } | null
          )?.state,
        { timeout: 60000 },
      )
      .toBe("succeeded");
    const topicId = (
      (await page.evaluate(
        (planId) => window.pyxis.invoke("plans.read", { planId }),
        planId,
      )) as {
        topics: Array<{ id: string }>;
      }
    ).topics[0]!.id;
    const answerEvents = () => {
      const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), {
        timeout: 10000,
      });
      try {
        return (
          db
            .prepare(
              `SELECT COUNT(*) AS n FROM learning_events
               WHERE kind = 'answer_given' AND json_extract(payload_json, '$.evidenceKind') = 'check'`,
            )
            .get() as { n: number }
        ).n;
      } finally {
        db.close();
      }
    };

    const status = page.getByRole("status").filter({ hasText: /^Sto scrivendo/ });
    const quick = page.getByRole("region", { name: "Verifica rapida" });
    const open = () =>
      page.evaluate(
        ({ planId, topicId }) => {
          location.hash = `/plans/${planId}/lesson/${topicId}`;
        },
        { planId, topicId },
      );

    // First run: answer the closed check, then stop. A stopped lesson saves nothing, so the pick is not counted.
    await open();
    await expect(status).toBeVisible();
    await expect(quick).toHaveCount(1);
    // The first section is finished and readable. The second is only a status with its title, an icon and words,
    // until it is finished: its text and the block still being written are not on the page yet.
    await expect(page.getByText("Una forza cambia il moto.")).toBeVisible();
    await expect(status).toContainText("Sto scrivendo la sezione 2:");
    await expect(status).toContainText("Seconda idea");
    await expect(status.locator("svg")).toHaveCount(1);
    await expect(page.getByRole("heading", { name: "Seconda idea" })).toHaveCount(0);
    await expect(page.getByText("Forza, massa e accelerazione.")).toHaveCount(0);
    await expect(page.getByText("Sto preparando un esercizio…")).toHaveCount(0);
    for (const theme of ["light", "dark"] as const) {
      await page.evaluate((theme) => window.pyxis.setAppearance(theme), theme);
      await saveShot(page, `lesson-streaming/it-${theme}-1280.png`);
      await expectNoAxeViolations(page);
    }
    await page.setViewportSize({ width: 960, height: 640 });
    await saveShot(page, "lesson-streaming/it-dark-960.png");
    await page.evaluate(() => window.pyxis.setAppearance("light"));
    await page.setViewportSize({ width: 1280, height: 800 });
    await quick.getByRole("button", { name: /Spinge nel verso/ }).click();
    await expect(quick.getByText("Non proprio.")).toBeVisible();
    await expect(status).toBeVisible();
    await status.getByRole("button", { name: "Interrompi" }).click();
    await expect(status).toHaveCount(0);
    await expect(quick.getByText("Non proprio.")).toHaveCount(0);
    // A stop is not a failure to save: the pick just goes back to unanswered, with no error and nothing more to click.
    await expect(page.getByText("La risposta non è stata salvata.")).toHaveCount(0);
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(quick.getByRole("button", { name: /Spinge nel verso/ })).toBeDisabled();
    expect(answerEvents()).toBe(0);

    // Second run: answer while it streams, let it finish, and the answer is counted once.
    await page.getByRole("button", { name: "Riprova" }).click();
    await expect(status).toBeVisible();
    await quick.getByRole("button", { name: /È nulla/ }).click();
    await expect(quick.getByText("Giusto.", { exact: true })).toBeVisible();
    await expect(status).toBeVisible();
    expect(answerEvents()).toBe(0);
    // What the reader is on does not move when the rest of the lesson lands.
    const reading = page.getByText("Una forza cambia il moto.");
    const before = (await reading.boundingBox())!.y;
    writeFileSync(hold, "");
    await expect(status).toHaveCount(0, { timeout: 20000 });
    await expect(page.getByText("Forza, massa e accelerazione.")).toBeVisible();
    expect((await reading.boundingBox())!.y).toBe(before);
    await expect(
      page.getByRole("region", { name: "Ripasso finale" }),
    ).toBeVisible();
    await expect(page.getByText("Forza, massa e accelerazione.")).toBeVisible();
    await expect.poll(answerEvents).toBe(1);
    // The saved pick is what the reader sees after a reload.
    await page.reload();
    await expect(
      page
        .getByRole("region", { name: "Verifica rapida" })
        .first()
        .getByText("Giusto.", { exact: true }),
    ).toBeVisible();
    expect(answerEvents()).toBe(1);
    // The second check, now written in full, is answerable in the normal way.
    await page
      .getByRole("region", { name: "Verifica rapida" })
      .nth(1)
      .getByRole("button", { name: /La legge di Ohm/ })
      .click();
    await expect(
      page
        .getByRole("region", { name: "Verifica rapida" })
        .nth(1)
        .getByText("Non proprio."),
    ).toBeVisible();
    await expect.poll(answerEvents).toBe(2);

    // Rewriting the lesson: until the new text starts, the old lesson on screen takes no pick, which would be dropped.
    await page.getByRole("button", { name: "Altre azioni" }).click();
    await page.getByRole("menuitem", { name: "Riscrivi", exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Riscrivi", exact: true }).click();
    await expect(status).toBeVisible();
    const recapRegion = page.getByRole("region", { name: "Ripasso finale" });
    await expect(recapRegion.getByRole("button", { name: /Newton/ })).toBeDisabled();
    await expect(status).toHaveCount(0, { timeout: 20000 });
    await expect(recapRegion.getByRole("button", { name: /Newton/ })).toBeEnabled();
    await expect(page.getByRole("alert")).toHaveCount(0);
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});
