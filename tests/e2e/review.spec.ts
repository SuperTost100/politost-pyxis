import AxeBuilder from "@axe-core/playwright";
import { _electron as electron, expect, test, type Page } from "@playwright/test";
import { strToU8, zipSync } from "fflate";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { importPickedSource } from "./picked-source";

// The built app can be pointed at another output folder so a test run never races a rebuild of out/.
const MAIN = join(process.cwd(), process.env.PYXIS_OUT ?? "out", "main/index.js");

const exercise = (id: string, chapter: number, n: number) =>
  `:::exercise{id="${id}" chapter="${chapter}"}\nDomanda ${id}?\n:::solution\nrisposta ${n}\n:::\n:::\n`;

test("LES-13 mixed Review keeps one stored queue across reloads and shows one progress", async () => {
  test.setTimeout(240000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-review-check-"));
  const file = join(userData, "fisica.ptsb");
  writeFileSync(
    file,
    zipSync({
      "smartbook.json": strToU8(
        JSON.stringify({
          id: "fisica",
          title: "Fisica",
          access: "public",
          chapters: [
            { id: "c1", number: 1, title: "Forze", file: "01.md" },
            { id: "c2", number: 2, title: "Energia", file: "02.md" },
          ],
        }),
      ),
      "chapters/01.md": strToU8("## p1 | Forza\nLa forza vale massa per accelerazione.\n"),
      "chapters/02.md": strToU8("## p1 | Energia\nL’energia cinetica dipende dalla velocità.\n"),
      "esercizi.md": strToU8(
        [1, 2, 3, 4].map((n) => exercise(`a${n}`, 1, n)).join("\n") +
          [5, 6, 7].map((n) => exercise(`b${n}`, 2, n)).join("\n"),
      ),
    }),
  );
  const planReplies = {
    markdown: { markdown: "## Ripasso\nUsa le formule [P1]." },
    questions: {
      questions: Array.from({ length: 10 }, (_, i) => ({
        stem: `Diagnosi ${i}`,
        options: ["a", "b", "c", "d"],
        correct: 0,
        topicIndex: i % 2,
        passageIds: [`{{passage:${i % 2}}}`],
        explanation: "La relazione fisica.",
      })),
    },
  };
  const env = {
    ...process.env,
    PYXIS_USER_DATA: userData,
    PYXIS_E2E: "1",
    PYXIS_E2E_PLAN_REPLIES: JSON.stringify(planReplies),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: [MAIN], env });
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Salta" }).click();
    const invoke = <T>(channel: string, input: object) =>
      page.evaluate(
        ([channel, input]) =>
          window.pyxis.invoke(channel as never, input as never),
        [channel, input] as const,
      ) as Promise<T>;
    const source = await importPickedSource(page, app, file) as { sourceId: string };
    await expect
      .poll(async () =>
        (await invoke<Array<{ id: string; status: string }>>("sources.list", {})).find(
          (row) => row.id === source.sourceId,
        )?.status,
      )
      .toBe("ready");
    const { planId } = await invoke<{ planId: string }>("plans.create", {
      title: "Fisica 1",
      sourceIds: [source.sourceId],
    });
    await expect
      .poll(async () => (await invoke<{ state: string }>("plans.build", { planId })).state)
      .toBe("succeeded");
    // The path's frontier is the topic whose lesson the student read last.
    const plan = await invoke<{ topics: Array<{ id: string }> }>("plans.read", { planId });
    await invoke("plans.complete", { planId, activity: "lesson", topicId: plan.topics[0]!.id });
    for (const n of [1, 2, 3, 4, 5, 6])
      await invoke("study.save", {
        planId,
        topicId: plan.topics[0]!.id,
        front: `Carta ${n}`,
        back: `Retro ${n}`,
      });

    const goto = (hash: string) =>
      page.evaluate((hash) => {
        window.location.hash = hash;
      }, hash);
    const progress = page.locator(".px-review-progress .small");
    const front = page.locator("article.px-card .px-markdown").first();
    const rate = async (key: string) => {
      await page.keyboard.press("Space");
      await page.keyboard.press(key);
    };

    await goto(`/plans/${planId}/review`);
    await page.locator(".ant-segmented-item-label", { hasText: /^5$/ }).click();
    await page.getByRole("button", { name: "Inizia il ripasso" }).click();
    await expect(page).toHaveURL(/\/review\/cards/);
    await expect(progress).toHaveText(/^0 di (\d+) fatti · 5 schede, (\d+) domande$/);
    const total = Number(/di (\d+) fatti/.exec((await progress.textContent()) ?? "")?.[1]);
    const questions = total - 5;
    expect(questions).toBeGreaterThan(0);

    // Every rating is Again, so a recycling queue would show a card twice.
    const seen: string[] = [];
    for (let done = 0; done < 2; done += 1) {
      await expect(front).not.toHaveText("");
      seen.push((await front.innerText()).trim());
      await rate("1");
      await expect(progress).toHaveText(new RegExp(`^${done + 1} di ${total} fatti`));
    }
    // A card that turns up now must not join the stored queue, and a reload must not rebuild it.
    await invoke("study.save", {
      planId,
      topicId: plan.topics[0]!.id,
      front: "Carta nuova",
      back: "Retro",
    });
    await page.reload();
    await expect(progress).toHaveText(new RegExp(`^2 di ${total} fatti · 5 schede`));
    for (let done = 2; done < 5; done += 1) {
      seen.push((await front.innerText()).trim());
      await rate("1");
      await expect(progress).toHaveText(new RegExp(`^${done + 1} di ${total} fatti`));
    }
    expect(new Set(seen).size).toBe(5);
    expect(seen).not.toContain("Carta nuova");

    // Reopening Review resumes the same session instead of building another.
    await goto(`/plans/${planId}/review`);
    await expect(page.getByText("Hai un ripasso in corso")).toBeVisible();
    await expect(progress).toHaveText(new RegExp(`^5 di ${total} fatti`));
    expect(
      (await new AxeBuilder({ page }).setLegacyMode(true).analyze()).violations,
    ).toEqual([]);
    await page.getByRole("button", { name: "Continua il ripasso" }).click();
    await expect(page).toHaveURL(/\/diagnostic\?attempt=/);
    // The question screen continues the same queue: card count first, then the question.
    await expect(page.getByText(`6 di ${total}`)).toBeVisible();

    // Submitting the questions closes the session; the next start builds a new one.
    const open = await invoke<{ sessionId: string; attemptId: string } | null>("study.reviewSession", { planId });
    expect(open?.attemptId).toBeTruthy();
    await invoke("study.quizSubmit", { attemptId: open!.attemptId, picks: {} });
    await expect
      .poll(() => invoke("study.reviewSession", { planId }))
      .toBeNull();
    const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), { readOnly: true });
    const events = db
      .prepare(
        "SELECT topic_id, payload_json FROM learning_events WHERE kind = 'answer_given' AND plan_id = ?",
      )
      .all(planId) as Array<{ topic_id: string; payload_json: string }>;
    db.close();
    // Every review question comes from the frontier topic; none is credited to the other.
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((row) => row.topic_id === plan.topics[0]!.id)).toBe(true);
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
});

test("MATH-03 a tutor Python block runs in the sandbox, drops stale output and keeps output focusable", async () => {
  test.skip(
    !existsSync(".tmp/pyodide/pyodide.js"),
    "Requires the pinned Pyodide runtime fixture in .tmp/pyodide.",
  );
  test.setTimeout(240000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-python-block-"));
  const { version } = JSON.parse(readFileSync("resources/pyodide-manifest.json", "utf8"));
  const pack = join(userData, "workspace/runtimes/pyodide", version);
  mkdirSync(pack, { recursive: true });
  cpSync(".tmp/pyodide", pack, { recursive: true });
  const env = {
    ...process.env,
    PYXIS_USER_DATA: userData,
    PYXIS_E2E: "1",
    PYXIS_E2E_REPLY: "Prova così:\n\n```python\nprint(6 * 7)\n```\n",
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: [MAIN], env });
  try {
    const page: Page = await app.firstWindow();
    await page.getByRole("button", { name: "Salta" }).click();
    const { chatId } = (await page.evaluate(() =>
      window.pyxis.invoke("chats.ask", {
        text: "calcola 6 per 7",
        allowGeneral: true,
        mode: "solver",
      }),
    )) as { chatId: string };
    await page.evaluate((chatId) => {
      window.location.hash = `/ask/${chatId}`;
    }, chatId);
    const code = page.getByRole("textbox", { name: "Codice Python" });
    await expect(code).toHaveValue("print(6 * 7)");
    await page.getByRole("button", { name: "Esegui" }).click();
    const output = page.getByLabel("Risultato");
    // Pyodide's first start takes over a minute on the hosted macOS x64 runner (each python.spec case there takes ~20 s).
    await expect(output).toHaveText("42\n", { timeout: 150000 });
    // The captured output scrolls by keyboard, so it must take focus.
    await output.focus();
    await expect(output).toBeFocused();
    expect(
      (await new AxeBuilder({ page }).setLegacyMode(true).analyze()).violations,
    ).toEqual([]);
    // Output belongs to the code that produced it: editing hides it, restoring brings it back.
    await code.fill("print(1)");
    await expect(output).toHaveCount(0);
    await page.getByRole("button", { name: "Ripristina il codice" }).click();
    await expect(code).toHaveValue("print(6 * 7)");
    await expect(output).toHaveText("42\n");
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
});
