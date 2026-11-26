import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { launchPyxis, setUp } from "./app-under-test";
import { removeTestFolder } from "./cleanup";
import { fromChiediToExams } from "./doors";
import { seedPlan } from "./seed";
import { saveShot } from "./shots";

const written = ["Quanto vale $2 + 2$?", "Quanto vale $3 \\cdot 3$?"].map((stem, index) => ({
  id: `q-${index}`,
  stem,
  topicId: "t-kin",
  options: ["1", "4", "9", "16"],
  answer: { kind: "mcq", correct: index === 0 ? 1 : 2, picked: -1 },
  explanation: "Un calcolo.",
}));

/** Two quizzes of eight questions with two written so far and their build running: one untimed, one with a clock. */
async function launch() {
  const userData = mkdtempSync(join(tmpdir(), "pyxis-quiz-note-"));
  const app = await launchPyxis({ userData });
  return setUp(app, userData, async () => {
    let db: DatabaseSync | undefined;
    try {
      const page = await app.firstWindow();
      await page.getByRole("button", { name: "Salta" }).click();
      await fromChiediToExams(page);
      await page.evaluate(() => window.pyxis.invoke("plans.list", {}));
      db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), { timeout: 10000 });
      const now = Date.now();
      db.prepare("INSERT INTO subjects(id,name,position,created_at) VALUES('sub-fis','Fisica',0,1)").run();
      seedPlan(db, { id: "p-fis", subjectId: "sub-fis", title: "Fisica I", language: "it", topics: [{ id: "t-kin", title: "Cinematica" }] });
      for (const [id, timerMinutes, state, error] of [
        ["plain", undefined, "running", null],
        ["timed", 20, "running", null],
        ["stopped", undefined, "failed", "invalid-output"],
      ] as const) {
        const count = id === "stopped" ? 10 : 8;
        const seeded =
          id === "stopped"
            ? Array.from({ length: 6 }, (_, index) => ({
                id: `s-${index}`,
                stem: `Domanda pronta ${index + 1}?`,
                topicId: "t-kin",
                options: ["1", "4", "9", "16"],
                answer: { kind: "mcq", correct: 1, picked: -1 },
                explanation: "Un calcolo.",
              }))
            : written;
        db.prepare(
          "INSERT INTO items(id,plan_id,topic_id,kind,body_json,engine_provider,grounding,created_at) VALUES(?,'p-fis','t-kin','quiz',?,'fixture','sources',?)",
        ).run(
          `i-${id}`,
          JSON.stringify({ questions: seeded, config: { count, feedback: true, types: ["mcq"], timerMinutes }, complete: false }),
          now,
        );
        db.prepare("INSERT INTO attempts(id,plan_id,item_id,started_at) VALUES(?,'p-fis',?,?)").run(`a-${id}`, `i-${id}`, now);
        db.prepare(
          "INSERT INTO jobs(id,kind,params_json,state,progress,error,created_at,updated_at) VALUES(?,'quiz-build',?,?,0.6,?,?,?)",
        ).run(`j-${id}`, JSON.stringify({ attemptId: `a-${id}` }), state, error, now, now);
      }
      db.close();
      return {
        app,
        page,
        done: async () => {
          await app.close();
          removeTestFolder(userData);
        },
      };
    } catch (error) {
      // An open database handle keeps the folder from being removed on Windows.
      if (db?.isOpen) db.close();
      throw error;
    }
  });
}

/** Sets the window to `width` device pixels at `zoom`, as Ctrl and plus do. */
async function zoomWindow(app: ElectronApplication, page: Page, width: number, zoom: number) {
  await app.evaluate(
    ({ BrowserWindow }, { width, zoom }) => {
      const window = BrowserWindow.getAllWindows()[0]!;
      window.setContentSize(width, 800);
      window.webContents.setZoomFactor(zoom);
    },
    { width, zoom },
  );
  await expect.poll(() => page.evaluate(() => innerWidth)).toBe(Math.round(width / zoom));
}

test("Consegna says why it waits in every layout, and its tooltip says the same", async () => {
  test.setTimeout(180_000);
  const { app, page, done } = await launch();
  try {
    const reasons = {
      plain: "Potrai consegnare quando tutte le domande saranno pronte.",
      timed: "Potrai rispondere quando tutte le domande saranno pronte. Il tempo parte in quel momento.",
    };
    for (const size of [
      { name: "1280", width: 1280, zoom: 1, text: "md", strip: false },
      { name: "960-large", width: 960, zoom: 1, text: "lg", strip: false },
      { name: "960-zoom200-large", width: 960, zoom: 2, text: "lg", strip: true },
    ] as const) {
      await page.evaluate((textSize) => window.pyxis.invoke("profile.save", { dyslexia: false, textSize }), size.text);
      await zoomWindow(app, page, size.width, size.zoom);
      for (const kind of ["plain", "timed"] as const) {
        await page.evaluate((hash) => {
          location.hash = hash;
        }, `/plans/p-fis/quiz/t-kin?attempt=a-${kind}`);
        await page.reload();
        const side = page.getByRole("complementary", { name: "Domande" });
        const handIn = side.getByRole("button", { name: "Consegna" });
        await expect(handIn, `${size.name} ${kind}`).toBeDisabled();
        const note = side.locator(".px-qz-note");
        await expect(note, `${size.name} ${kind}: the reason shows`).toBeVisible();
        await expect(note).toHaveText(reasons[kind]);
        await expect(handIn, `${size.name} ${kind}: the tooltip says the same`).toHaveAttribute("title", reasons[kind]);
        // The strip holds the button and the reason, and nothing runs off it or off the window.
        const card = (await side.boundingBox())!;
        for (const box of [(await handIn.boundingBox())!, (await note.boundingBox())!]) {
          expect(box.x, `${size.name} ${kind}`).toBeGreaterThanOrEqual(card.x - 1);
          expect(box.x + box.width, `${size.name} ${kind}`).toBeLessThanOrEqual(card.x + card.width + 1);
          expect(box.y + box.height, `${size.name} ${kind}`).toBeLessThanOrEqual(card.y + card.height + 1);
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), size.name).toBe(true);
        if (size.strip) expect(card.y + card.height, `${size.name}: the strip sits over the question`).toBeLessThanOrEqual(
          (await page.locator(".px-qz-sheet").boundingBox())!.y,
        );
      }
    }

    // A quiz that stopped partway (6 of 10 written, failed with invalid-output): counts agree, Consegna stays
    // disabled with a matching note, the alert explains the failure in plain words, and Q6 offers retry.
    await page.evaluate(() => window.pyxis.invoke("profile.save", { dyslexia: false, textSize: "md" }));
    await zoomWindow(app, page, 1280, 1);
    await page.evaluate(() => {
      location.hash = "/plans/p-fis/quiz/t-kin?attempt=a-stopped";
    });
    await page.reload();
    await expect(page.getByRole("heading", { level: 1, name: "Domanda 1 di 10" })).toBeVisible();
    const side = page.getByRole("complementary", { name: "Domande" });
    await expect(side.locator(".px-qz-count")).toHaveText("0 di 10 date");
    await expect(side.locator(".px-qz-busy")).toHaveText("6 di 10 pronte: mancano 4 domande.");
    await expect(side.locator(".px-qz-num.is-waiting")).toHaveCount(4);
    const handIn = side.getByRole("button", { name: "Consegna" });
    await expect(handIn).toBeDisabled();
    const stoppedReason = "Prima completa la preparazione del quiz: potrai consegnare quando tutte le domande saranno pronte.";
    await expect(side.locator(".px-qz-note")).toHaveText(stoppedReason);
    await expect(handIn).toHaveAttribute("title", stoppedReason);
    const alert = page.getByRole("alert");
    await expect(alert).toContainText("Lo strumento ha dato una risposta che non riesco a usare.");
    await expect(alert.getByText("invalid-output")).toHaveCount(0);
    await alert.getByRole("button", { name: "Dettagli" }).click();
    await expect(alert.getByText("invalid-output")).toBeVisible();
    await saveShot(page, "quiz/partial-stopped-invalid-output.png");
    await side.getByRole("button", { name: "Domanda 6" }).click();
    await expect(page.locator(".px-qz-nav").getByRole("button", { name: "Riprova la preparazione" })).toBeEnabled();
  } finally {
    await done();
  }
});
