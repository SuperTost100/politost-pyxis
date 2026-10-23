import {
  expect,
  test,
} from "@playwright/test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importPickedSource } from "./picked-source";
import { launchPyxis } from "./app-under-test";
import { makeBook } from "./book";
import { expectNoAxeViolations } from "./axe";

const both = (it: string, en: string) => new RegExp(`^(${it}|${en})$`);

test("practice: rate two exercises, change one, finish, and mastery moves by two light observations", async () => {
  test.setTimeout(120000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-rating-"));
  const book = join(userData, "fisica.ptsb");
  writeFileSync(
    book,
    makeBook({
      id: "rating",
      chapters: [
        { title: "Lavoro", text: "## p1 | Lavoro\nIl lavoro è forza per spostamento.\n" },
        { title: "Energia", text: "## p1 | Energia\nL’energia misura il lavoro disponibile.\n" },
      ],
      files: {
        "esercizi.md": [
          ':::exercise{id="work" chapter="1"}\nQuanto vale il lavoro di 5 N su 2 m?\n:::solution\nW = F s = 10 J.\n:::\n:::',
          ':::exercise{id="power" chapter="1"}\nQuanto vale la potenza di 10 J in 5 s?\n:::solution\nP = W / t = 2 W.\n:::\n:::',
        ].join("\n\n"),
      },
    }),
  );
  const replies = {
    markdown: { markdown: "## Lavoro\nIl lavoro [P1]." },
    questions: {
      questions: Array.from({ length: 10 }, (_, i) => ({
        stem: `Diagnosi ${i}`,
        options: ["a", "b", "c", "d"],
        correct: 0,
        topicIndex: i % 2,
        passageIds: [`{{passage:${i % 2}}}`],
        explanation: "La grandezza fisica.",
      })),
    },
  };
  const env = {
    PYXIS_E2E_PLAN_REPLIES: JSON.stringify(replies),
  };
  const app = await launchPyxis({ userData, env });
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.getByRole("button", { name: "Salta" }).click();
    // Skipping saves the profile, then moves to Exams; wait so a reload or route change cannot land on setup.
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
            }
          ).state,
        { timeout: 60000 },
      )
      .toBe("succeeded");
    const { topics } = (await page.evaluate(
      (planId) => window.pyxis.invoke("plans.read", { planId }),
      planId,
    )) as {
      topics: Array<{ id: string }>;
    };
    const topicId = topics[0]!.id;
    const mastery = async () =>
      (
        (await page.evaluate(
          (planId) => window.pyxis.invoke("plans.mastery", { planId }),
          planId,
        )) as Array<{
          id: string;
          mastery: number;
        }>
      ).find((topic) => topic.id === topicId)!.mastery;
    const ratings = async () =>
      (
        (await page.evaluate(
          ({ planId, topicId }) =>
            window.pyxis.invoke("study.exercises", { planId, topicId }),
          { planId, topicId },
        )) as { exercises: Array<{ prompt: string; rating: string | null }> }
      ).exercises.map((exercise) => exercise.rating);
    expect(await mastery()).toBe(0);
    expect(await ratings()).toEqual([null, null]);

    await page.evaluate(
      ({ planId, topicId }) => {
        location.hash = `/plans/${planId}/practice/${topicId}`;
      },
      { planId, topicId },
    );
    const work = page
      .getByRole("listitem")
      .filter({ hasText: "Quanto vale il lavoro" });
    const power = page
      .getByRole("listitem")
      .filter({ hasText: "Quanto vale la potenza" });
    const got = (card: typeof work) =>
      card.getByRole("button", { name: both("Ce l'ho fatta", "Got it") });
    const missed = (card: typeof work) =>
      card.getByRole("button", {
        name: both("Non ce l'ho fatta", "Missed it"),
      });
    await expect(work).toBeVisible();
    // Optional: nothing is chosen, and finishing needs no rating.
    for (const card of [work, power]) {
      await expect(got(card)).toHaveAttribute("aria-pressed", "false");
      await expect(missed(card)).toHaveAttribute("aria-pressed", "false");
    }

    await got(work).click();
    await missed(power).click();
    await expect(got(work)).toHaveAttribute("aria-pressed", "true");
    await expect(missed(power)).toHaveAttribute("aria-pressed", "true");
    // Changing a mind: the second exercise becomes "Got it".
    await got(power).click();
    await expect(got(power)).toHaveAttribute("aria-pressed", "true");
    await expect(missed(power)).toHaveAttribute("aria-pressed", "false");
    await expect.poll(ratings).toEqual(["got", "got"]);

    // Leaving and coming back inside the app shows the saved choice, not what the page loaded with.
    // Each move waits for its page, so the checks below run on the page we came back to, not the one we left.
    await page.evaluate((planId) => {
      location.hash = `/plans/${planId}`;
    }, planId);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(work).toBeHidden();
    await page.evaluate(
      ({ planId, topicId }) => {
        location.hash = `/plans/${planId}/practice/${topicId}`;
      },
      { planId, topicId },
    );
    await expect(page).toHaveURL(new RegExp(`#/plans/${planId}/practice/${topicId}`));
    await expect(got(work)).toHaveAttribute("aria-pressed", "true");
    await expect(got(power)).toHaveAttribute("aria-pressed", "true");
    await expect(missed(power)).toHaveAttribute("aria-pressed", "false");

    // The choice survives a reload, and the page passes axe with ratings selected.
    await page.reload();
    await expect(got(work)).toHaveAttribute("aria-pressed", "true");
    await expect(got(power)).toHaveAttribute("aria-pressed", "true");
    await expectNoAxeViolations(page);

    // Finish: both exercises count once, each with weight 0.5. A third observation for the changed one would give 0.222.
    await page
      .getByRole("button", { name: both("Segna come fatto", "Mark as done") })
      .click();
    await expect(page).toHaveURL(new RegExp(`#/plans/${planId}$`));
    expect(await mastery()).toBeCloseTo(1 / 4, 3);

    const series = (await page.evaluate(
      (planId) => window.pyxis.invoke("plans.series", { planId }),
      planId,
    )) as {
      gaps: unknown[];
      topics: Array<{ id: string; exercisesSolved: number }>;
    };
    expect(series.gaps).toEqual([]);
    expect(
      series.topics.find((topic) => topic.id === topicId)!.exercisesSolved,
    ).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
});
