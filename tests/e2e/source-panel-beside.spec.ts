import { expect, test } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { launchPyxis } from "./app-under-test";
import { seedPlan, seedSource, seedSubjects } from "./seed";
import { removeTestFolder } from "./cleanup";
import { fromChiediToExams } from "./doors";
import { atRest } from "./settled";
import { saveShot } from "./shots";

const LONG =
  "Appunti_di_fisica_generale_per_il_corso_di_laurea_in_ingegneria_edile_e_dei_sistemi_territoriali_2026";

function seed(db: DatabaseSync) {
  seedSubjects(db, [{ id: "s-fis", name: "Fisica" }]);
  seedSource(db, {
    id: "src-a",
    title: "Appunti di fisica",
    document: { id: "doc-a" },
    passages: [{ id: "pa-1", text: "La forza è il prodotto di massa e accelerazione.", locator: { chapter: 1, paragraph: "p1" }, section: "1. Dinamica" }],
  });
  seedSource(db, { id: "src-long", title: LONG, document: { id: "doc-long" }, passages: [{ id: "pa-long", text: "Una riga.", section: "1. Forze" }] });
  seedSource(db, { id: "src-photo", title: "Lavagna del 12 novembre", kind: "photo", document: { id: "doc-photo" }, passages: [{ id: "pa-photo", text: "Un appunto.", section: "1" }] });
  seedSource(db, { id: "src-sorted", title: "Esercizi di meccanica", subjectId: "s-fis", document: { id: "doc-sorted" }, passages: [{ id: "pa-s", text: "Un esercizio.", section: "1" }] });
  seedPlan(db, { id: "p-fis", subjectId: "s-fis", title: "Fisica 1", language: "it", target: 0.75, sourceIds: ["src-a", "src-long"], topics: [{ id: "t1", title: "Dinamica" }] });
  db.exec(`
    INSERT INTO topic_passages(topic_id,passage_id) VALUES('t1','pa-1');
    INSERT INTO chats(id,title,subject,created_at,updated_at) VALUES('c-1','Seconda legge di Newton','Fisica',1,2);
    INSERT INTO messages(id,chat_id,role,body,created_at) VALUES('m-1','c-1','user','Come calcolo la forza?',1);
    INSERT INTO messages(id,chat_id,role,body,grounding,created_at) VALUES('m-2','c-1','assistant','Usa la seconda legge di Newton: la forza è il prodotto di massa e accelerazione, quindi con $m=2$ e $a=3$ ottieni $6$ N [P1].','sources',2);
    INSERT INTO message_passages(message_id,passage_id,label) VALUES('m-2','pa-1','P1');
  `);
  db.prepare(
    "INSERT INTO items(id,plan_id,topic_id,kind,body_json,engine_provider,grounding,created_at) VALUES('lesson-1','p-fis','t1','lesson',?,'fixture','sources',1)",
  ).run(
    JSON.stringify({
      cacheKey: JSON.stringify({ kind: "lesson", scopeId: "t1", promptVersion: "model-1", passageIds: ["pa-1"] }),
      markdown:
        "## La dinamica\n\nLa seconda legge di Newton lega la forza alla massa e all'accelerazione di un corpo, come $F=ma$ [P1]. Un corpo di massa maggiore ha bisogno di una forza maggiore per avere la stessa accelerazione.\n\n## Un esempio\n\nCon una massa di $2\\,kg$ e un'accelerazione di $3\\,m/s^2$, la forza vale $6\\,N$.",
    }),
  );
}

test("the source panel leaves the Library, the chat, a lesson and the exam's material usable beside it from 1180px", async () => {
  test.setTimeout(300_000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-panel-beside-"));
  const app = await launchPyxis({ userData });
  try {
    const page = await app.firstWindow();
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.getByRole("button", { name: "Salta" }).click();
    await fromChiediToExams(page);
    await page.evaluate(() => window.pyxis.invoke("plans.list", {}));
    const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), { timeout: 10000 });
    seed(db);
    // Jobs that run and wait widen Attività, which used to take room from the page beside the panel too.
    const job = db.prepare("INSERT INTO jobs(id,kind,params_json,state,progress,error,created_at,updated_at) VALUES(?,'demo','{}',?,0,?,1,1)");
    for (const id of ["run-1", "run-2"]) job.run(id, "running", null);
    for (const id of ["fix-1", "fix-2", "fix-3"]) job.run(id, "failed", "engine-failed");
    db.close();

    const panel = page.locator("aside.source-panel");
    const open = async () => {
      await page.evaluate(() =>
        window.dispatchEvent(new CustomEvent("pyxis:source-viewer", { detail: { passageId: "pa-1" } })),
      );
      await expect(panel).toBeVisible();
    };
    // A box that is a column of single letters is tall and narrow: the line is as wide as its words need.
    const readable = async (selector: string, label: string, least: number) => {
      const found = page.locator(selector);
      await expect(found.first(), `${label}: ${selector}`).toBeVisible();
      for (const [index, box] of (await found.evaluateAll((nodes) => nodes.map((n) => n.getBoundingClientRect().width))).entries())
        expect(box, `${label}: ${selector} #${index} is wide enough to read`).toBeGreaterThanOrEqual(least);
    };

    for (const language of ["it", "en"] as const)
      for (const text of ["md", "lg"] as const) {
        await page.evaluate((language) => localStorage.setItem("pyxis.lang", language), language);
        await page.evaluate((textSize) => window.pyxis.invoke("profile.save", { dyslexia: false, textSize }), text);
        for (const width of [1180, 1280, 1440]) {
          await page.setViewportSize({ width, height: 800 });
          const where = (route: string) => `${language}, ${text} text, ${width}px, ${route}`;
          for (const route of ["/exams/library", "/ask/c-1", "/plans/p-fis/lesson/t1", "/plans/p-fis/sources"]) {
            await page.evaluate((route) => {
              location.hash = route;
            }, route);
            await page.reload();
            await expect(page.locator("h1:visible, .ask-bar-name").first()).toBeVisible();
            await open();
            await atRest(panel);
            const label = where(route);
            const main = (await page.locator("main").boundingBox())!;
            expect(main.width, `${label}: the page column keeps a usable width`).toBeGreaterThanOrEqual(320);
            expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${label}: nothing overflows sideways`).toBe(true);
            if (route === "/exams/library") {
              // A file's name in "Da sistemare" reads on one line of its own, the subject choice sits with it or under it,
              // and a subject's shelf keeps a width its covers fit in.
              await readable(".px-unsorted-open .body-strong", label, 120);
              await readable(".px-unsorted-row select.px-library-picker", label, 160);
              await readable(".px-shelf-subject", label, 240);
              const rows = await page.locator(".px-unsorted-row").evaluateAll((nodes) => nodes.map((n) => n.getBoundingClientRect().height));
              for (const height of rows) expect(height, `${label}: a file's row is not a tall column`).toBeLessThan(220);
            }
            await saveShot(page, `panel-beside-${route.split("/").filter(Boolean).join("-")}-${language}-${text}-${width}.png`);
            await page.keyboard.press("Escape");
            await expect(panel).toHaveCount(0);
          }
        }
      }
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});
