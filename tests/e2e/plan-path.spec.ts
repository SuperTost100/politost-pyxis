import AxeBuilder from "@axe-core/playwright";
import { _electron as electron, expect, test, type Page } from "@playwright/test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { importPickedSource } from "./picked-source";

const block = (kind: string, body: unknown) =>
  ["```pyxis-" + kind, JSON.stringify(body), "```"].join("\n");

// A recorded smart text with a closing recap; every topic's lesson uses it.
const lesson = [
  "## Che cos'è una forza",
  "",
  "Una **forza** cambia lo stato di moto di un corpo.",
  "",
  block("recap", {
    questions: [
      {
        question: "Qual è l'unità della forza?",
        options: ["Joule", "Newton", "Watt"],
        answer: 1,
        explanation: "Il newton.",
      },
      {
        question: "Se raddoppi la forza su una massa fissa, l'accelerazione…",
        options: ["raddoppia", "si dimezza", "non cambia"],
        answer: 0,
        explanation: "$a = F/m$.",
      },
    ],
  }),
].join("\n");

const chapters = [
  { number: 1, title: "Forze" },
  { number: 2, title: "Energia e lavoro" },
  { number: 3, title: "Onde meccaniche e suono" },
];

type Read = {
  steps: Array<{ activity: string; topicId: string | null; result: unknown }>;
  topics: Array<{ id: string; title: string }>;
};

async function language(page: Page, value: "it" | "en", theme: "light" | "dark") {
  await page.evaluate(
    async ({ value, theme }) => {
      localStorage.setItem("pyxis.lang", value);
      await window.pyxis.setAppearance(theme);
    },
    { value, theme },
  );
  await page.reload();
  await expect(page.locator(".px-path-next")).toBeVisible();
}

/** A full-page shot from the top, so the sticky app bar stays at the top of the image. */
async function shoot(page: Page, path: string) {
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path, fullPage: true });
}

/** No connector line may run through a box or a label: each stops at least a few pixels short of them. */
async function linesClear(page: Page) {
  return page.evaluate(() => {
    const boxes = Array.from(
      document.querySelectorAll<HTMLElement>(".px-path .px-node, .px-path .px-node-label, .px-path-next, .px-path-heading"),
    ).map((element) => element.getBoundingClientRect());
    const hits: string[] = [];
    for (const path of document.querySelectorAll<SVGPathElement>(".px-path-lines path")) {
      const length = path.getTotalLength();
      const matrix = path.getScreenCTM()!;
      for (let at = 0; at <= length; at += 2) {
        const point = path.getPointAtLength(at).matrixTransform(matrix);
        for (const box of boxes)
          if (
            point.x > box.left - 4 &&
            point.x < box.right + 4 &&
            point.y > box.top - 4 &&
            point.y < box.bottom + 4
          )
            hits.push(`${Math.round(point.x)},${Math.round(point.y)}`);
      }
    }
    return { lines: document.querySelectorAll(".px-path-lines path").length, hits };
  });
}

test("plan path: nothing locked, the next step offers every activity, any topic's lesson records a step", async () => {
  test.setTimeout(240000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-path-"));
  const book = join(userData, "fisica.ptsb");
  writeFileSync(
    book,
    zipSync({
      "smartbook.json": strToU8(
        JSON.stringify({
          id: "path",
          title: "Fisica",
          access: "public",
          chapters: chapters.map((chapter) => ({
            id: `c${chapter.number}`,
            number: chapter.number,
            title: chapter.title,
            file: `0${chapter.number}.md`,
          })),
        }),
      ),
      ...Object.fromEntries(
        chapters.map((chapter) => [
          `chapters/0${chapter.number}.md`,
          strToU8(`## p${chapter.number} | ${chapter.title}\nTesto su ${chapter.title}.\n`),
        ]),
      ),
    }),
  );
  const replies = {
    markdown: { markdown: lesson },
    questions: {
      questions: Array.from({ length: 10 }, (_, i) => ({
        stem: `Che cosa cambia una forza ${i + 1}?`,
        options: ["Il moto", "Il colore", "La massa", "Il volume"],
        correct: 0,
        // The diagnostic needs a question on every topic.
        topicIndex: i % chapters.length,
        passageIds: [],
        explanation: "Una forza cambia il moto.",
      })),
    },
  };
  const env = {
    ...process.env,
    PYXIS_USER_DATA: userData,
    PYXIS_E2E: "1",
    PYXIS_E2E_PLAN_REPLIES: JSON.stringify(replies),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: [join(process.cwd(), "out/main/index.js")], env });
  const shots = ".shots/plan-path";
  mkdirSync(shots, { recursive: true });
  const combos = [
    ["it", "light"],
    ["it", "dark"],
    ["en", "light"],
    ["en", "dark"],
  ] as const;
  try {
    const page = await app.firstWindow();
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.getByRole("button", { name: "Salta" }).click();
    const { sourceId } = (await importPickedSource(page, app, book)) as { sourceId: string };
    await expect
      .poll(async () =>
        (
          (await page.evaluate(() => window.pyxis.invoke("sources.list", {}))) as Array<{
            id: string;
            status: string;
          }>
        ).find((row) => row.id === sourceId)?.status,
      )
      .toBe("ready");
    const { planId } = (await page.evaluate(
      (sourceId) =>
        window.pyxis.invoke("plans.create", { title: "Fisica 1", sourceIds: [sourceId], language: "it" }),
      sourceId,
    )) as { planId: string };
    await expect
      .poll(
        async () => {
          const build = (await page.evaluate(
            (planId) => window.pyxis.invoke("plans.build", { planId }),
            planId,
          )) as { state: string; error: string | null } | null;
          return build?.state === "failed" ? `failed: ${build.error}` : build?.state;
        },
        { timeout: 60000 },
      )
      .toBe("succeeded");
    const read = () =>
      page.evaluate((planId) => window.pyxis.invoke("plans.read", { planId }), planId) as Promise<Read>;
    const topics = (await read()).topics;
    expect(topics.map((topic) => topic.title)).toEqual(chapters.map((c) => `${c.number}. ${c.title}`));

    // A new plan: the introduction is suggested, every topic is a preview, nothing is locked.
    await page.evaluate((planId) => {
      location.hash = `/plans/${planId}`;
    }, planId);
    const next = page.locator(".px-path-next");
    await expect(next.getByText("Ti suggerisco")).toBeVisible();
    await expect(next.getByRole("heading", { name: "Introduzione" })).toBeVisible();
    await expect(page.getByText(/Si sblocca|Unlocks/)).toHaveCount(0);
    await expect(page.locator(".px-node.is-locked, .lucide-lock")).toHaveCount(0);
    const planned = page.getByRole("list", { name: "In programma" });
    await expect(planned.getByRole("listitem")).toHaveCount(4);
    expect((await linesClear(page)).hits).toEqual([]);
    for (const [lang, theme] of combos) {
      await language(page, lang, theme);
      await shoot(page, `${shots}/new-plan-${lang}-${theme}.png`);
    }
    await language(page, "it", "light");
    expect((await new AxeBuilder({ page }).setLegacyMode(true).analyze()).violations).toEqual([]);

    // The chooser lets the student skip the introduction and the diagnostic.
    await next.getByRole("button", { name: "Altre attività" }).click();
    const forFirst = page.getByRole("list", { name: `Attività su ${topics[0]!.title}` });
    for (const name of ["Testo smart", "Esercizio assistito", "Quiz", "Flashcard"])
      await expect(forFirst.getByRole("button", { name: new RegExp(`^${name}`) })).toBeVisible();
    const whole = page.getByRole("list", { name: "Tutto il piano" });
    for (const name of ["Simulazione d'esame", "Test diagnostico", "Introduzione"])
      await expect(whole.getByRole("button", { name: new RegExp(`^${name}`) })).toBeVisible();
    await forFirst.getByRole("button", { name: /^Testo smart/ }).click();
    await expect(page).toHaveURL(new RegExp(`#/plans/${planId}/lesson/${topics[0]!.id}$`));
    // Opening records nothing.
    await expect(page.getByText("Una forza cambia lo stato di moto", { exact: false })).toBeVisible({
      timeout: 20000,
    });
    expect((await read()).steps).toEqual([]);
    const recap = page.getByRole("region", { name: "Ripasso finale" });
    await recap.scrollIntoViewIfNeeded();
    await recap.getByRole("button", { name: /^B\s*Newton/ }).click();
    await recap.getByRole("button", { name: /si dimezza/ }).click();
    await expect(page.getByText("Lezione completata")).toBeVisible();
    expect((await read()).steps).toMatchObject([{ activity: "lesson", topicId: topics[0]!.id }]);

    // After the first lesson the next box suggests work on it, with every alternative next to it.
    await page.getByRole("button", { name: "Torna al percorso" }).click();
    await expect(next.getByText("Ti suggerisco")).toBeVisible();
    await expect(next.getByRole("heading")).toHaveText(`Esercizio assistito su ${topics[0]!.title}`);
    await expect(next.getByText("Fissa quello che hai appena letto.")).toBeVisible();
    const done = page.getByRole("list", { name: "Passi fatti" });
    await expect(done.getByRole("button", { name: new RegExp(`^Testo smart, ${topics[0]!.title}, letto`) })).toBeVisible();
    await next.getByRole("button", { name: "Altre attività" }).click();
    for (const name of ["Testo smart", "Quiz", "Flashcard"])
      await expect(forFirst.getByRole("button", { name: new RegExp(`^${name}`) })).toBeVisible();
    await expect(forFirst.getByRole("button", { name: /^Esercizio assistito.*Consigliato/ })).toBeVisible();

    // "Change topic" retargets the options; the picker searches the plan's topics.
    await next.getByRole("button", { name: "Cambia argomento" }).click();
    const search = page.getByRole("textbox", { name: "Cerca un argomento" });
    await expect(search).toBeFocused();
    await search.fill("onde");
    const topicList = page.getByRole("list", { name: "Argomenti del piano" });
    await expect(topicList.getByRole("button")).toHaveCount(1);
    await search.fill("");
    for (const [lang, theme] of combos) {
      await language(page, lang, theme);
      await next.getByRole("button", { name: /^(Altre attività|Other activities)$/ }).click();
      await next.getByRole("button", { name: /^(Cambia argomento|Change topic)$/ }).click();
      await shoot(page, `${shots}/topic-picker-${lang}-${theme}.png`);
    }
    await language(page, "it", "light");
    await next.getByRole("button", { name: "Altre attività" }).click();
    await next.getByRole("button", { name: "Cambia argomento" }).click();
    await search.fill("onde");
    await topicList.getByRole("button", { name: new RegExp(topics[2]!.title) }).click();
    const forThird = page.getByRole("list", { name: `Attività su ${topics[2]!.title}` });
    await expect(forThird).toBeVisible();
    // For a topic not read yet the smart text is what fits.
    await expect(forThird.getByRole("button", { name: /^Testo smart.*Consigliato/ })).toBeVisible();
    await expect(page.getByRole("button", { name: "Cambia argomento" })).toBeFocused();

    // A lesson on a topic the path did not suggest still records a done step.
    await forThird.getByRole("button", { name: /^Testo smart/ }).click();
    await expect(page).toHaveURL(new RegExp(`#/plans/${planId}/lesson/${topics[2]!.id}$`));
    await expect(page.getByText("Una forza cambia lo stato di moto", { exact: false })).toBeVisible({
      timeout: 20000,
    });
    await recap.scrollIntoViewIfNeeded();
    await recap.getByRole("button", { name: /^B\s*Newton/ }).click();
    await recap.getByRole("button", { name: /raddoppia/ }).click();
    await expect(page.getByText("Lezione completata")).toBeVisible();
    expect((await read()).steps.map((step) => [step.activity, step.topicId])).toEqual([
      ["lesson", topics[0]!.id],
      ["lesson", topics[2]!.id],
    ]);
    await page.getByRole("button", { name: "Torna al percorso" }).click();
    await expect(done.getByRole("listitem")).toHaveCount(2);
    // Only the unread topic and the simulation are still to come; still nothing is locked.
    await expect(planned.getByRole("listitem")).toHaveCount(2);
    await expect(page.locator(".px-node.is-locked, .lucide-lock")).toHaveCount(0);
    expect((await linesClear(page)).hits).toEqual([]);
    expect((await new AxeBuilder({ page }).setLegacyMode(true).analyze()).violations).toEqual([]);
    for (const [lang, theme] of combos) {
      await language(page, lang, theme);
      await shoot(page, `${shots}/mid-way-${lang}-${theme}.png`);
      await next.getByRole("button", { name: /^(Altre attività|Other activities)$/ }).click();
      expect((await linesClear(page)).hits).toEqual([]);
      await shoot(page, `${shots}/chooser-${lang}-${theme}.png`);
    }
    // Narrow window.
    await language(page, "it", "light");
    await page.setViewportSize({ width: 560, height: 900 });
    await next.getByRole("button", { name: "Altre attività" }).click();
    expect((await linesClear(page)).hits).toEqual([]);
    await shoot(page, `${shots}/chooser-narrow-it-light.png`);
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
});
