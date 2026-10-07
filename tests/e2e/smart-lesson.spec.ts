import AxeBuilder from "@axe-core/playwright";
import { _electron as electron, expect, test, type Page } from "@playwright/test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { strToU8, zipSync } from "fflate";
import { importPickedSource } from "./picked-source";

const block = (kind: string, body: unknown) =>
  ["```pyxis-" + kind, JSON.stringify(body), "```"].join("\n");

// A recorded smart lesson: prose, one block of every kind and the closing recap.
const lesson = [
  "## Che cos'è una forza",
  "",
  "Una **forza** è ciò che cambia lo stato di moto di un corpo. Se spingi un carrello fermo, inizia a muoversi; se lo spingi mentre si muove, cambia velocità.",
  "",
  block("reveal", {
    style: "term",
    front: "Newton (N)",
    back: "L'unità della forza: $1\\,\\mathrm{N} = 1\\,\\mathrm{kg\\,m/s^2}$.",
  }),
  "",
  block("check", {
    question: "Un carrello si muove a velocità costante su un piano senza attrito. Che cosa puoi dire della forza totale?",
    options: ["È nulla", "Spinge nel verso del moto", "Cresce col tempo"],
    answer: 0,
    explanation: "Velocità costante vuol dire accelerazione nulla, quindi $F = ma = 0$.",
  }),
  "",
  "## La seconda legge",
  "",
  "La seconda legge di Newton lega forza, massa e accelerazione:",
  "",
  "$$F = m\\,a$$",
  "",
  block("example", {
    title: "Un carrello spinto",
    body: "Un carrello di $2\\,\\mathrm{kg}$ accelera a $3\\,\\mathrm{m/s^2}$.\n\n1. Scrivi la legge: $F = ma$.\n2. Sostituisci: $F = 2 \\cdot 3$.\n3. Risultato: $F = 6\\,\\mathrm{N}$.",
  }),
  "",
  block("try", {
    prompt: "Una forza di $10\\,\\mathrm{N}$ agisce su una massa di $5\\,\\mathrm{kg}$. Quanto vale l'accelerazione?",
    hint: "Ricava $a$ dalla seconda legge.",
    steps: ["Parti da $F = ma$ e isola $a$: $a = F/m$.", "Sostituisci: $a = 10/5$."],
    answer: "$a = 2\\,\\mathrm{m/s^2}$",
  }),
  "",
  block("recap", {
    questions: [
      {
        question: "Qual è l'unità della forza?",
        options: ["Joule", "Newton", "Watt"],
        answer: 1,
        explanation: "Il newton, $\\mathrm{kg\\,m/s^2}$.",
      },
      {
        question: "Se raddoppi la forza su una massa fissa, l'accelerazione…",
        options: ["raddoppia", "si dimezza", "non cambia"],
        answer: 0,
        explanation: "$a = F/m$ è proporzionale a $F$.",
      },
      {
        question: "Un corpo con forza totale nulla…",
        options: ["è sempre fermo", "si muove a velocità costante o è fermo", "rallenta"],
        answer: 1,
        explanation: "Senza forza totale la velocità non cambia.",
      },
    ],
  }),
].join("\n");

const intro = [
  "Benvenuto in **Fisica 1**: imparerai a descrivere il moto e le sue cause. [01a110b2-3b89-7089-b52e-0855aadf1b56]",
  "",
  "Partirai dalle forze e arriverai all'energia; ogni argomento usa il precedente.",
  "",
  block("check", {
    question: "Quale grandezza misura quanto velocemente cambia la posizione?",
    options: ["La velocità", "La massa", "La temperatura"],
    answer: 0,
    explanation: "La velocità è lo spostamento diviso il tempo.",
  }),
].join("\n");

async function language(page: Page, value: "it" | "en", theme: "light" | "dark") {
  await page.evaluate(
    async ({ value, theme }) => {
      localStorage.setItem("pyxis.lang", value);
      await window.pyxis.setAppearance(theme);
    },
    { value, theme },
  );
  await page.reload();
}

test("smart lesson: opening never completes it, checks give feedback, the recap completes it, the intro is a page", async () => {
  test.setTimeout(240000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-smart-"));
  const book = join(userData, "fisica.ptsb");
  writeFileSync(
    book,
    zipSync({
      "smartbook.json": strToU8(
        JSON.stringify({
          id: "smart",
          title: "Fisica",
          access: "public",
          chapters: [{ id: "c1", number: 1, title: "Forze", file: "01.md" }],
        }),
      ),
      "chapters/01.md": strToU8(
        "## p1 | Forza\nLa forza cambia lo stato di moto.\n\n## p2 | Seconda legge\nLa forza è il prodotto di massa e accelerazione.\n",
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
        topicIndex: 0,
        passageIds: ["{{passage:0}}"],
        explanation: "Una forza cambia il moto.",
      })),
    },
  };
  const env = {
    ...process.env,
    PYXIS_USER_DATA: userData,
    PYXIS_E2E: "1",
    PYXIS_E2E_PLAN_REPLIES: JSON.stringify(replies),
    PYXIS_E2E_PLAN_DELAY: "2500",
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({
    args: [join(process.cwd(), "out/main/index.js")],
    env,
  });
  const shots = ".shots/smart-text";
  mkdirSync(shots, { recursive: true });
  try {
    const page = await app.firstWindow();
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 1280, height: 800 });
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
        async () =>
          ((await page.evaluate((planId) => window.pyxis.invoke("plans.build", { planId }), planId)) as {
            state: string;
          } | null)?.state,
        { timeout: 60000 },
      )
      .toBe("succeeded");
    const read = () =>
      page.evaluate((planId) => window.pyxis.invoke("plans.read", { planId }), planId) as Promise<{
        steps: Array<{ activity: string; topicId: string | null }>;
        topics: Array<{ id: string }>;
      }>;
    const done = async (activity: string, topicId: string | null = null) =>
      (await read()).steps.some((step) => step.activity === activity && step.topicId === topicId);
    // An introduction stored before smart text, with a raw passage id, next to a quick check.
    const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), { timeout: 10000 });
    db.prepare("UPDATE items SET body_json = ? WHERE plan_id = ? AND kind = 'intro'").run(
      JSON.stringify({ markdown: intro, passageIds: [] }),
      planId,
    );
    db.close();

    // The introduction opens as its own page from the path.
    await page.evaluate((planId) => {
      location.hash = `/plans/${planId}`;
    }, planId);
    await page.locator(".px-path-next").getByRole("button", { name: "Inizia", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`#/plans/${planId}/intro$`));
    await expect(page.getByRole("heading", { level: 1, name: "Fisica 1" })).toBeVisible();
    await expect(page.getByText("imparerai a descrivere il moto")).toBeVisible();
    await expect(page.getByText(/01a110b2/)).toHaveCount(0);
    for (const [lang, theme] of [["it", "light"], ["it", "dark"], ["en", "light"], ["en", "dark"]] as const) {
      await language(page, lang, theme);
      await expect(page.getByText("imparerai a descrivere il moto")).toBeVisible();
      await page.screenshot({ path: `${shots}/intro-${lang}-${theme}.png` });
    }
    await language(page, "it", "light");
    expect((await new AxeBuilder({ page }).setLegacyMode(true).analyze()).violations).toEqual([]);
    await page.getByRole("button", { name: /La velocità/ }).click();
    await expect(page.getByText("Giusto.", { exact: true })).toBeVisible();
    // Answering the introduction's only check completes it.
    await expect(page.getByText("Introduzione completata")).toBeVisible();
    expect(await done("intro")).toBe(true);
    await page.screenshot({ path: `${shots}/intro-answered-it-light.png` });

    const learn = { topicId: (await read()).topics[0]!.id };

    // Generating: an in-place status with Stop and skeleton lines, then the lesson.
    await page.evaluate(
      ({ planId, topicId }) => {
        location.hash = `/plans/${planId}/lesson/${topicId}`;
      },
      { planId, topicId: learn.topicId },
    );
    const status = page.getByRole("status").filter({ hasText: "Sto scrivendo la lezione…" });
    await expect(status).toBeVisible();
    await expect(status.getByRole("button", { name: "Interrompi" })).toBeVisible();
    await page.screenshot({ path: `${shots}/lesson-generating-it-light.png` });
    await expect(page.getByText("Una forza è ciò che cambia", { exact: false })).toBeVisible({ timeout: 20000 });
    await expect(status).toHaveCount(0);
    // Opening the lesson did not mark it done.
    expect(await done("lesson", learn.topicId)).toBe(false);
    await expect(page.getByText("Rispondi al ripasso finale per completare la lezione.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Segna come fatto" })).toBeVisible();
    await expect(page.getByText("pyxis-")).toHaveCount(0);
    expect((await new AxeBuilder({ page }).setLegacyMode(true).analyze()).violations).toEqual([]);

    for (const [lang, theme] of [["it", "light"], ["it", "dark"], ["en", "light"], ["en", "dark"]] as const) {
      await language(page, lang, theme);
      await expect(page.getByText("Una forza è ciò che cambia", { exact: false })).toBeVisible();
      await page.screenshot({ path: `${shots}/lesson-top-${lang}-${theme}.png` });
      await page.getByRole("button", { name: /^(Altre azioni|More actions)$/ }).click();
      await expect(page.getByRole("menuitem", { name: /^(Riscrivi una parte|Rewrite a part)$/ })).toBeVisible();
      await expect(page.getByRole("menuitem", { name: /^(Mappa|Map)$/ })).toBeVisible();
      await expect(page.getByRole("menuitem", { name: /^(Esporta|Export)$/ })).toBeVisible();
      await page.screenshot({ path: `${shots}/lesson-menu-${lang}-${theme}.png` });
      await page.keyboard.press("Escape");
    }
    await language(page, "it", "light");
    // Export opens from the menu.
    await page.getByRole("button", { name: "Altre azioni" }).click();
    await page.getByRole("menuitem", { name: "Esporta" }).click();
    const exportDialog = page.getByRole("dialog", { name: "Esporta" });
    await expect(exportDialog.getByRole("button", { name: "Salva file" })).toBeVisible();
    await exportDialog.getByRole("button", { name: "Annulla" }).click();
    await expect(exportDialog).toBeHidden();

    // Quick check: instant feedback and the explanation.
    const quick = page.getByRole("region", { name: "Verifica rapida" });
    await quick.getByRole("button", { name: /Spinge nel verso/ }).click();
    await expect(quick.getByText("Non proprio.")).toBeVisible();
    await expect(quick.getByText("Velocità costante vuol dire accelerazione nulla", { exact: false })).toBeVisible();
    // Try it: hint, then the solution one step at a time.
    const tryIt = page.getByRole("region", { name: "Prova tu" });
    await tryIt.getByRole("button", { name: "Mostra un suggerimento" }).click();
    await expect(tryIt.getByText("Ricava", { exact: false })).toBeVisible();
    await tryIt.getByRole("button", { name: "Mostra il primo passaggio" }).click();
    await tryIt.getByRole("button", { name: "Mostra il passaggio 2 di 2" }).click();
    await expect(tryIt.getByText("Risultato")).toBeVisible();
    // Reveal: the term card opens.
    await page.getByRole("button", { name: /Newton \(N\)/ }).click();
    await expect(
      page.getByRole("region", { name: "Termine chiave" }).getByText("L'unità della forza", { exact: false }),
    ).toBeVisible();
    for (const [lang, theme] of [["it", "light"], ["it", "dark"], ["en", "light"], ["en", "dark"]] as const) {
      await language(page, lang, theme);
      const check = page.getByRole("region", { name: /^(Verifica rapida|Quick check)$/ });
      await check.scrollIntoViewIfNeeded();
      await expect(check.getByText(/^(Non proprio\.|Not quite\.)$/)).toBeVisible();
      await page.screenshot({ path: `${shots}/lesson-check-answered-${lang}-${theme}.png` });
      const tryRegion = page.getByRole("region", { name: /^(Prova tu|Try it)$/ });
      await tryRegion.getByRole("button", { name: /^(Mostra tutta la soluzione|Show the whole solution)$/ }).click();
      await tryRegion.scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${shots}/lesson-try-revealed-${lang}-${theme}.png` });
    }
    await language(page, "it", "light");
    // The saved answer survives a reload.
    await expect(quick.getByText("Non proprio.")).toBeVisible();

    // Recap: answering every question completes the lesson.
    const recap = page.getByRole("region", { name: "Ripasso finale" });
    await recap.scrollIntoViewIfNeeded();
    await recap.getByRole("button", { name: /^B\s*Newton/ }).click();
    await recap.getByRole("button", { name: /raddoppia/ }).click();
    expect(await done("lesson", learn.topicId)).toBe(false);
    await recap.getByRole("button", { name: /è sempre fermo/ }).click();
    await expect(recap.getByText("2 su 3 giuste")).toBeVisible();
    await expect(page.getByText("Lezione completata")).toBeVisible();
    expect(await done("lesson", learn.topicId)).toBe(true);

    // Sources used: collapsed, and each place opens the source viewer.
    const sources = page.locator(".px-reader-sources");
    await expect(sources.getByRole("button", { name: /cap\. 1/ })).toBeHidden();
    await sources.locator("summary").click();
    await expect(sources.getByRole("button", { name: /cap\. 1/ })).toBeVisible();
    for (const [lang, theme] of [["it", "light"], ["it", "dark"], ["en", "light"], ["en", "dark"]] as const) {
      await language(page, lang, theme);
      const region = page.getByRole("region", { name: /^(Ripasso finale|Recap)$/ });
      await region.scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${shots}/lesson-recap-${lang}-${theme}.png` });
      await page.locator(".px-reader-sources summary").click();
      await page.locator(".px-reader-sources").scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${shots}/lesson-sources-${lang}-${theme}.png` });
    }
    await language(page, "it", "light");
    await page.locator(".px-reader-sources summary").click();
    await page.locator(".px-reader-sources").getByRole("button", { name: /cap\. 1/ }).click();
    await expect(page.getByText("La forza cambia lo stato di moto.")).toBeVisible();
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
});
