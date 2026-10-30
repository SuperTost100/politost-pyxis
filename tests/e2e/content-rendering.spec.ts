import { expect, test } from "@playwright/test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importPickedSource } from "./picked-source";
import { launchPyxis } from "./app-under-test";
import { makeBook } from "./book";
import { expectNoAxeViolations } from "./axe";
import { saveShot } from "./shots";

const block = (kind: string, body: unknown) => ["```pyxis-" + kind, JSON.stringify(body), "```"].join("\n");

// The smartbook as the book generator writes it: ids, heading marks, reference links, formula placeholders and math.
const chapter = [
  "## p1 | Misurare",
  "Misurare significa confrontare una grandezza con un'unità e dichiarare quanto è affidabile il risultato.",
  "",
  "## p2 | Grandezze e punto $P$",
  "### Grandezze fisiche e incertezza di misura",
  "Un vettore, come in [testo](ref:chapter/1#p2), individua la posizione di un punto $P$ nello spazio ed è {{formula:1.5}}.",
  "",
].join("\n");

// "\theta" and "\frac" in these JS strings are a tab and a form feed: what a single backslash in a model's JSON becomes.
const lesson = [
  "## Il vettore",
  "",
  "Il modulo è {{formula:1.5}}: vedi [testo](ref:chapter/1#p2), con $m\\vec{g}\\sin\theta$ e $\frac{a}{b}$.",
  "",
  "Un punto $P$ nello spazio.",
  "",
  block("recap", {
    questions: [
      {
        question: "Quanto vale la velocità?",
        options: ["$6\\ \\text{m/s}$", "$12\\ \\text{m/s}$", "$\\frac{a}{b}$"],
        answer: 0,
        explanation: "Il valore è $6\\ \\text{m/s}$.",
      },
      {
        question: "Quale simbolo?",
        options: ["$\\alpha$", "$\\beta$"],
        answer: 0,
        explanation: "Alfa.",
      },
    ],
  }),
].join("\n");

test("book text and model LaTeX reach the student clean: path row, lesson, source panel, selection and option names", async () => {
  test.setTimeout(240000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-content-"));
  const book = join(userData, "fisica.ptsb");
  writeFileSync(
    book,
    makeBook({
      id: "content",
      chapters: [
        { title: "Misure e vettori", text: chapter },
        { title: "Cinematica", text: "## p1 | Moto\nIl moto descrive lo spostamento nel tempo.\n" },
      ],
      files: {
        "esercizi.md":
          ':::exercise{id="mod" chapter="1"}\nCalcola il modulo.\n:::solution\nIl modulo è {{formula:1.5}}: $|v| = 5$.\n:::\n:::',
      },
    }),
  );
  const replies = {
    markdown: { markdown: lesson },
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
  const app = await launchPyxis({ userData, env: { PYXIS_E2E_PLAN_REPLIES: JSON.stringify(replies) } });
  try {
    const page = await app.firstWindow();
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.getByRole("button", { name: "Salta" }).click();
    await expect(page).toHaveURL(/#\/exams$/);
    const invoke = <T,>(channel: string, input: unknown) =>
      page.evaluate(({ channel, input }) => window.pyxis.invoke(channel as never, input as never), {
        channel,
        input,
      }) as Promise<T>;
    const { sourceId } = (await importPickedSource(page, app, book)) as { sourceId: string };
    await expect
      .poll(async () =>
        (await invoke<Array<{ id: string; status: string }>>("sources.list", {})).find((row) => row.id === sourceId)
          ?.status,
      )
      .toBe("ready");
    const { planId } = await invoke<{ planId: string }>("plans.create", {
      title: "Fisica 1",
      sourceIds: [sourceId],
      language: "it",
    });
    await expect
      .poll(async () => (await invoke<{ state: string }>("plans.build", { planId })).state, { timeout: 60000 })
      .toBe("succeeded");
    const { topics } = await invoke<{ topics: Array<{ id: string; subtopics: string[] }> }>("plans.read", { planId });
    const topicId = topics[0]!.id;
    expect(topics[0]!.subtopics).toEqual(["Misurare", "Grandezze e punto $P$"]);

    // 1. The expanded path row names its subtopics cleanly and draws their math.
    await page.evaluate((planId) => {
      location.hash = `/plans/${planId}`;
    }, planId);
    const about = page.locator(".px-path-about").first();
    if (!(await about.isVisible())) {
      await page.locator(".px-path-rows button[aria-expanded='false']").first().click();
    }
    await expect(about).toBeVisible();
    await expect(about).toContainText("Misurare");
    await expect(about).toContainText("Grandezze e punto");
    await expect(about.locator(".katex")).toHaveCount(1);
    expect(await about.innerText()).not.toMatch(/\bp\d\b|###|ref:|\$|\{\{/);
    await expectNoAxeViolations(page);
    await saveShot(page, "content-path-row.png");

    // 2. A book solution with a formula reference shows the number the book prints, not the placeholder.
    await page.evaluate(
      ({ planId, topicId }) => {
        location.hash = `/plans/${planId}/practice/${topicId}`;
      },
      { planId, topicId },
    );
    await page.getByRole("button", { name: "Mostra la soluzione" }).click();
    const solution = page.locator("li.passage").filter({ hasText: "Calcola il modulo" });
    await expect(solution).toContainText("Il modulo è (1.5):");
    expect(await solution.innerText()).not.toContain("{{");

    // 3. The lesson: no placeholder, no reference link, and LaTeX the model wrote with single backslashes is intact.
    await page.evaluate(
      ({ planId, topicId }) => {
        location.hash = `/plans/${planId}/lesson/${topicId}`;
      },
      { planId, topicId },
    );
    const body = page.locator(".px-markdown").first();
    await expect(body).toContainText("Il modulo è (1.5)", { timeout: 30000 });
    expect(await body.innerText()).not.toMatch(/\{\{|ref:|\[testo\]/);
    const tex = await body.locator('annotation[encoding="application/x-tex"]').allTextContents();
    expect(tex).toContain("m\\vec{g}\\sin\\theta");
    expect(tex).toContain("\\frac{a}{b}");
    await saveShot(page, "content-lesson.png");

    // 5. An answer button with math is named in words and signs, never in TeX.
    const recap = page.getByRole("region", { name: "Ripasso finale" });
    await recap.scrollIntoViewIfNeeded();
    await expect(recap.getByRole("button", { name: "A 6 m/s", exact: true })).toBeVisible();
    await expect(recap.getByRole("button", { name: /^[A-C] a\/b$/ })).toBeVisible();
    expect(await recap.getByRole("button").evaluateAll((nodes) => nodes.map((n) => n.getAttribute("aria-label")))).not.toContainEqual(
      expect.stringMatching(/[\\{}]/),
    );

    // 4. A selection over math is quoted once, as TeX, and its menu gives way to the flashcard dialog.
    const paragraph = page.locator(".px-markdown p", { hasText: "Un punto" });
    const select = () =>
      paragraph.evaluate((node) => {
        const selection = window.getSelection()!;
        const range = document.createRange();
        range.selectNodeContents(node);
        selection.removeAllRanges();
        selection.addRange(range);
      });
    await paragraph.scrollIntoViewIfNeeded();
    await select();
    const menu = page.getByRole("group", { name: "Chiedi al tutor" });
    await expect(menu).toBeVisible();
    await menu.getByRole("button", { name: "Crea flashcard" }).click();
    const dialog = page.getByRole("dialog", { name: "Crea flashcard" });
    await expect(dialog).toBeVisible();
    // The quote draws its formula once.
    await expect(dialog.locator(".px-mc-source .katex")).toHaveCount(1);
    await expect(menu).toHaveCount(0);
    // Moving focus into the dialog makes the browser report the (still selected) text again; the menu stays away.
    await page.evaluate(() => document.dispatchEvent(new Event("selectionchange")));
    await expect(menu).toHaveCount(0);
    await saveShot(page, "content-flashcard-dialog.png");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Crea flashcard" })).toBeHidden();
    await page.evaluate(() => window.getSelection()?.removeAllRanges());
    await select();
    await expect(menu).toBeVisible();
    await menu.getByRole("button", { name: "Chiedi al tutor" }).click();
    await expect(page).toHaveURL(/#\/ask\//);
    const chat = await invoke<{ context: { body: string } }>("chats.read", {
      chatId: page.url().split("/").at(-1)!,
    });
    expect(chat.context.body).toBe("Un punto $P$ nello spazio.");

    // A selection that starts inside the drawn formula, past its screen-reader copy, keeps what is drawn of it.
    await page.evaluate(
      ({ planId, topicId }) => {
        location.hash = `/plans/${planId}/lesson/${topicId}`;
      },
      { planId, topicId },
    );
    const again = page.locator(".px-markdown p", { hasText: "Un punto" });
    await expect(again).toBeVisible();
    await again.evaluate((node) => {
      const glyphs = node.querySelector(".katex-html")!;
      const first = document.createTreeWalker(glyphs, NodeFilter.SHOW_TEXT).nextNode()!;
      const last = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
      let end = first;
      for (let next = last.nextNode(); next; next = last.nextNode()) end = next;
      const range = document.createRange();
      range.setStart(first, 0);
      range.setEnd(end, end.textContent!.length);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
    });
    await expect(menu).toBeVisible();
    await menu.getByRole("button", { name: "Chiedi al tutor" }).click();
    await expect(page).toHaveURL(/#\/ask\//);
    const partial = await invoke<{ context: { body: string } }>("chats.read", {
      chatId: page.url().split("/").at(-1)!,
    });
    expect(partial.context.body).toBe("P nello spazio.");

    // The source panel's paragraph regions are named by their text, not "p1" and "p2".
    await page.evaluate((sourceId) => {
      window.dispatchEvent(new CustomEvent("pyxis:source-viewer", { detail: { sourceId, chapter: 1 } }));
    }, sourceId);
    await expect(page.locator(".source-viewer-paragraph")).toHaveCount(2);
    const names = await page
      .locator(".source-viewer-paragraph")
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("aria-label")));
    expect(names[0]).toMatch(/^Misurare significa confrontare/);
    for (const name of names) expect(name).not.toMatch(/^p\d+$|\$|###|ref:/);
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
});
