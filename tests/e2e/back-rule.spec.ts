import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { launchPyxis } from "./app-under-test";
import { removeTestFolder } from "./cleanup";
import { fromChiediToExams } from "./doors";
import { seedPlan, seedSource, seedSubjects } from "./seed";

/**
 * The walk that guards the rule for going back: every page with a back control is reached the ways a student reaches
 * it, and its control must name the place it really goes to, go there, and leave the focus on what opened the page, or
 * on the page's heading when that is gone. A page that gets its back control adds one row here.
 */

const EXAM = "Analisi Matematica 2";
const exam = "/plans/p-an2";

type Walk = { app: ElectronApplication; page: Page };

type Row = {
  /** The route pattern, as in places.ts. */
  page: string;
  /** How the student came, in a few words. */
  how: string;
  /** Reaches the page: clicks from a starting page, a reminder, a reload. */
  reach: (walk: Walk) => Promise<void>;
  /** What the back control says. */
  label: string;
  /** The address after pressing it. */
  leadsTo: string;
  /** The accessible name of what has the focus afterwards. */
  focus: string | RegExp;
  /** The sidebar row lit while the page shows: the section it was opened from, or null for a page without the sidebar. */
  lit: string | null;
  /** Nothing is behind the page, so Back opens its parent in the page's place and Avanti has nothing to return to. */
  parent?: boolean;
  /** A study page, with the study bar: one way back, and Attività last at the far right. */
  study?: boolean;
};

/** Opens a starting page the way a link from outside the app would. */
async function start(page: Page, hash: string, heading: string) {
  await page.evaluate((to) => {
    location.hash = to;
  }, hash);
  await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
}

const fromExam = (open: (page: Page) => Promise<void>) => async ({ page }: Walk) => {
  await start(page, `#${exam}`, EXAM);
  await open(page);
};

const side = (page: Page) => page.locator(".px-exam-aside");

/** Opens a page as a link from outside the app does, with nothing behind it on the trail. */
const direct = (path: string) => async ({ page }: Walk) => {
  await page.evaluate((to) => {
    location.hash = to;
  }, `#${path}`);
  await expect(page.getByRole("button", { name: /^Torna a / })).toBeVisible();
};

const rows: Row[] = [
  {
    page: "/plans/:planId/lesson/:topicId",
    how: "a part from the exam's path",
    reach: fromExam(async (page) => {
      await page.getByRole("button", { name: /^Funzioni di più variabili/ }).click();
      await page.getByRole("link", { name: /^Parte 1 · Intorni e distanza/ }).click();
      await expect(page.getByRole("heading", { level: 1, name: "Intorni e distanza" })).toBeVisible();
    }),
    label: EXAM,
    lit: null,
    leadsTo: exam,
    // The topic's row folds again on the exam page, since the diagnostic is still what the path is on: the focus goes
    // to the row that held the part.
    focus: /^Funzioni di più variabili/,
    study: true,
  },
  {
    page: "/maps/:subjectId/:topicId?",
    how: "a map from the exam's Mappe",
    reach: fromExam(async (page) => {
      await side(page).getByRole("link", { name: /Funzioni di più variabili/ }).click();
      await expect(page.getByRole("heading", { level: 1, name: "Funzioni di più variabili" })).toBeVisible();
    }),
    label: EXAM,
    lit: "Esami",
    leadsTo: exam,
    focus: /Funzioni di più variabili/,
  },
  {
    page: "/maps/:subjectId/:topicId?",
    how: "a map from Mappe",
    reach: async ({ page }) => {
      await start(page, "#/maps", "Mappe");
      await page.getByRole("link", { name: /Funzioni di più variabili/ }).first().click();
      await expect(page.getByRole("heading", { level: 1, name: "Funzioni di più variabili" })).toBeVisible();
    },
    label: "Mappe",
    lit: "Mappe",
    leadsTo: "/maps",
    focus: /Funzioni di più variabili/,
  },
  {
    page: "/exams/mistakes",
    how: "the Quaderno from the exam",
    reach: fromExam(async (page) => {
      await side(page).getByRole("button", { name: "Quaderno degli errori" }).click();
      await expect(page.getByRole("heading", { level: 1, name: "Quaderno degli errori" })).toBeVisible();
    }),
    label: EXAM,
    lit: "Esami",
    leadsTo: exam,
    focus: "Quaderno degli errori",
  },
  {
    page: "/plans/:planId/redo",
    how: "Rifai gli errori from the exam",
    reach: fromExam(async (page) => {
      await side(page).getByRole("button", { name: "Rifai la domanda" }).click();
      await expect(page.getByRole("button", { name: "Consegna" }).first()).toBeVisible();
    }),
    label: EXAM,
    lit: null,
    leadsTo: exam,
    focus: "Rifai la domanda",
    study: true,
  },
  {
    page: "/cards/due",
    how: "today's cards from the exam",
    reach: fromExam(async (page) => {
      await side(page).getByRole("button", { name: /^Ripassa/ }).click();
      await expect(page.getByRole("button", { name: "Gira", exact: true })).toBeVisible();
    }),
    label: EXAM,
    lit: null,
    leadsTo: exam,
    focus: /^Ripassa/,
    study: true,
  },
  {
    page: "/cards/due",
    how: "today's cards from the Flashcard section",
    reach: async ({ page }) => {
      await start(page, "#/flashcards", "Flashcard");
      await page.getByRole("button", { name: /^Ripassa le 2 di oggi$/ }).click();
      await expect(page.getByRole("button", { name: "Gira", exact: true })).toBeVisible();
    },
    label: "Flashcard",
    lit: null,
    leadsTo: "/flashcards",
    focus: /^Ripassa le 2 di oggi$/,
    study: true,
  },
  {
    page: "/exams/cards",
    how: "Sfoglia tutte from the exam",
    reach: fromExam(async (page) => {
      await side(page).getByRole("button", { name: "Sfoglia tutte" }).click();
      await expect(page.getByRole("heading", { level: 1, name: "Tutte le flashcard" })).toBeVisible();
    }),
    label: EXAM,
    lit: "Esami",
    leadsTo: exam,
    focus: "Sfoglia tutte",
  },
  {
    page: "/plans/:planId/settings",
    how: "the exam's settings",
    reach: fromExam(async (page) => {
      await page.getByRole("button", { name: "Impostazioni dell'esame" }).click();
      await expect(page.getByRole("heading", { level: 1, name: "Impostazioni dell'esame" })).toBeVisible();
    }),
    label: EXAM,
    lit: "Esami",
    leadsTo: exam,
    focus: "Impostazioni dell'esame",
  },
  {
    page: "/plans/:planId/:view?",
    how: "the exam's material",
    reach: fromExam(async (page) => {
      await side(page).getByRole("link", { name: /^Tutto il materiale/ }).click();
      await expect(page.getByRole("heading", { level: 1, name: "Materiale" })).toBeVisible();
    }),
    label: EXAM,
    lit: "Esami",
    leadsTo: exam,
    focus: /^Tutto il materiale/,
  },
  {
    page: "/plans/:planId/map/:topicId",
    how: "a map from a lesson's menu",
    reach: async (walk) => {
      await rows[0]!.reach(walk);
      await walk.page.getByRole("banner").getByRole("button", { name: "Altre azioni" }).click();
      await walk.page.getByRole("menuitem", { name: "Mappa" }).click();
      await expect(walk.page.getByRole("heading", { level: 1, name: "Funzioni di più variabili" })).toBeVisible();
    },
    label: "Funzioni di più variabili",
    lit: "Esami",
    leadsTo: `${exam}/lesson/t-fun`,
    // The menu item that opened the map is gone with its menu: the part's heading takes the focus.
    focus: "Intorni e distanza",
  },
  {
    page: "/maps/:subjectId/:topicId?",
    how: "a map from the exam, reloaded",
    reach: async (walk) => {
      await rows[1]!.reach(walk);
      await walk.page.reload();
      await expect(walk.page.getByRole("heading", { level: 1, name: "Funzioni di più variabili" })).toBeVisible();
    },
    label: EXAM,
    lit: "Esami",
    leadsTo: exam,
    focus: /Funzioni di più variabili/,
  },
  {
    page: "/maps/:subjectId/:topicId?",
    how: "a map from the exam, with the trail lost",
    reach: async (walk) => {
      await rows[1]!.reach(walk);
      await walk.page.evaluate(() => sessionStorage.removeItem("pyxis.trail"));
      await walk.page.reload();
      await expect(walk.page.getByRole("heading", { level: 1, name: "Funzioni di più variabili" })).toBeVisible();
    },
    label: "Mappe",
    lit: "Mappe",
    parent: true,
    leadsTo: "/maps?subject=s-an",
    // Mappe opened at a subject puts the focus on that subject's heading.
    focus: "Analisi",
  },
  {
    page: "/cards/due",
    how: "a study reminder, over a map",
    reach: async (walk) => {
      await rows[2]!.reach(walk);
      await walk.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.send("app:open-path", "/cards/due"));
      await expect(walk.page.getByRole("button", { name: "Gira", exact: true })).toBeVisible();
    },
    label: "Flashcard",
    lit: null,
    parent: true,
    leadsTo: "/flashcards",
    focus: "Flashcard",
  },
  ...[
    ["/plans/:planId/intro", `${exam}/intro`],
    ["/plans/:planId/practice/:topicId", `${exam}/practice/t-fun`],
    ["/plans/:planId/quiz/:topicId", `${exam}/quiz/t-fun`],
    ["/plans/:planId/diagnostic", `${exam}/diagnostic`],
    ["/plans/:planId/cards/:topicId", `${exam}/cards/t-fun`],
    ["/plans/:planId/review", `${exam}/review`],
    ["/plans/:planId/simulation", `${exam}/simulation`],
  ].map(
    ([pattern, path]): Row => ({
      page: pattern!,
      how: "with nothing behind it",
      reach: direct(path!),
      label: EXAM,
      lit: null,
      parent: true,
      leadsTo: exam,
      focus: EXAM,
      study: true,
    }),
  ),
  {
    page: "/cards/subject/:subjectId",
    how: "with nothing behind it",
    reach: direct("/cards/subject/s-an"),
    label: "Flashcard",
    lit: null,
    parent: true,
    leadsTo: "/flashcards",
    focus: "Flashcard",
    study: true,
  },
];

/** A topic in parts with two parts written from book text (no AI tool), a map, a missed question and two new cards. */
function seed(db: DatabaseSync) {
  seedSubjects(db, [{ id: "s-an", name: "Analisi" }]);
  const passages = Array.from({ length: 4 }, (_, i) => ({
    id: `ps-${i + 1}`,
    text: `Un intorno di un punto è un disco aperto centrato nel punto, paragrafo ${i + 1}.`,
    section: "Funzioni di più variabili",
    locator: { page: i + 1 },
  }));
  seedSource(db, { id: "src-an", title: "Bramanti, Pagani, Salsa", subjectId: "s-an", document: { id: "doc-an" }, passages });
  seedPlan(db, {
    id: "p-an2",
    subjectId: "s-an",
    title: EXAM,
    language: "it",
    sourceIds: ["src-an"],
    topics: [
      { id: "t-fun", title: "Funzioni di più variabili" },
      { id: "t-serie", title: "Successioni e serie di funzioni" },
    ],
  });
  const link = db.prepare("INSERT INTO topic_passages(topic_id,passage_id) VALUES('t-fun',?)");
  for (const passage of passages) link.run(passage.id);
  db.exec(`INSERT INTO chats(id,title,created_at,updated_at) VALUES('c-bayes','Teorema di Bayes',1,1);
    DELETE FROM feature_engines;
    INSERT INTO lesson_outlines(id,plan_id,topic_id,passage_key,origin,created_at) VALUES('o-fun','p-an2','t-fun','k','model',1);
    INSERT INTO lesson_parts(id,outline_id,position,kind,title,about,passage_ids_json,minutes) VALUES
      ('o-fun-1','o-fun',1,'part','Intorni e distanza','','["ps-1","ps-2"]',5),
      ('o-fun-2','o-fun',2,'part','Interno, esterno, frontiera','','["ps-3","ps-4"]',6);
    INSERT INTO cards(id,plan_id,topic_id,front,back,passage_id,grounding,created_at) VALUES
      ('c-1','p-an2','t-fun','Che cos''è un intorno?','Un disco aperto centrato nel punto.','ps-1','sources',1),
      ('c-2','p-an2','t-fun','Quando un insieme è aperto?','Quando contiene un intorno di ogni suo punto.','ps-2','sources',1);`);
  const node = (id: string, label: string, parent: string | null, x: number) => ({ id, label, parent, x, y: parent ? 160 : 0, pinned: false, sources: ["ps-1"] });
  db.prepare("INSERT INTO maps(id,plan_id,topic_id,graph_json,grounding,created_at) VALUES('m-fun','p-an2','t-fun',?,'sources',1)").run(
    JSON.stringify({
      version: 1,
      maps: [
        {
          id: "m-fun-entry",
          title: "Funzioni di più variabili",
          passageIds: ["ps-1"],
          graph: {
            layout: "tree",
            nodes: [node("n-root", "Funzioni di più variabili", null, 0), node("n-open", "Insiemi aperti", "n-root", 0)],
            edges: [{ from: "n-root", to: "n-open" }],
            undo: null,
          },
        },
      ],
    }),
  );
  const now = Date.now();
  db.prepare(
    "INSERT INTO items(id,plan_id,topic_id,kind,body_json,engine_provider,model_id,created_at) VALUES('quiz-fun','p-an2','t-fun','quiz',?,'claude','m',1)",
  ).run(
    JSON.stringify({
      complete: true,
      questions: [
        {
          id: "q-open",
          stem: "Il disco chiuso è un insieme aperto.",
          explanation: "Contiene i punti del bordo, che non hanno un intorno nell'insieme.",
          answer: { kind: "tf", picked: false, correct: false },
        },
      ],
    }),
  );
  db.prepare("INSERT INTO attempts(id,plan_id,item_id,started_at,submitted_at) VALUES('a-fun','p-an2','quiz-fun',?,?)").run(now - 86_400_000, now - 86_400_000);
  db.prepare("INSERT INTO attempt_answers(id,attempt_id,payload_json,created_at) VALUES('aa-fun','a-fun',?,?)").run(
    JSON.stringify({
      picks: { "q-open": "true" },
      score: 0,
      results: [{ id: "q-open", score: 0, expected: "false", explanation: "Contiene i punti del bordo." }],
    }),
    now - 86_400_000,
  );
}

/** The sidebar's lit row, if the page shows the sidebar. */
const lit = (page: Page) => page.locator('.px-side [aria-current="page"]');

const backControl = (page: Page) => page.getByRole("button", { name: /^Torna a / });

let walk: Walk;
let userData: string;

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  userData = mkdtempSync(join(tmpdir(), "pyxis-back-rule-"));
  const app = await launchPyxis({ userData });
  const page = await app.firstWindow();
  await page.getByRole("button", { name: "Salta" }).click();
  await fromChiediToExams(page);
  const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), { timeout: 10_000 });
  try {
    seed(db);
  } finally {
    db.close();
  }
  await page.reload();
  walk = { app, page };
});

test.afterAll(async () => {
  await walk?.app.close();
  removeTestFolder(userData);
});

for (const row of rows) {
  test(`${row.page}: ${row.how}`, async () => {
    test.setTimeout(90_000);
    const { page, app } = walk;
    await row.reach(walk);
    const reached = page.url();
    await expect(backControl(page)).toHaveAccessibleName(`Torna a ${row.label}`);
    await expect(backControl(page)).toHaveText(row.label);
    // The sidebar lights the section the page was opened from, not the one its address belongs to.
    if (row.lit === null) await expect(lit(page)).toHaveCount(0);
    else await expect(lit(page)).toHaveAccessibleName(row.lit);
    if (row.study) {
      // One way back: the bar's. The foot has no second button that does the same, and Attività is the last thing at the
      // bar's right end.
      await expect(
        page.getByRole("button", { name: /^(Torna al percorso|Torna al ripasso|Torna al quaderno|Indietro)$/ }),
      ).toHaveCount(0);
      await expect(page.locator(".px-studybar-actions > :last-child")).toHaveClass(/px-jobs-button/);
    }
    // Escape never leaves a page.
    await page.locator("body").press("Escape");
    expect(page.url()).toBe(reached);
    await backControl(page).click();
    await expect(page).toHaveURL(new RegExp(`#${row.leadsTo.replace(/[?]/g, "\\?")}(\\?.*)?$`));
    await expect(page.locator(":focus")).toHaveAccessibleName(row.focus);
    // Vai > Indietro goes where the control goes, and Vai > Avanti returns to the page.
    await row.reach(walk);
    // A page that opens a session of its own (Rifai gli errori) has a new address each time.
    const again = page.url();
    await app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById("back")?.click());
    await expect(page).toHaveURL(new RegExp(`#${row.leadsTo.replace(/[?]/g, "\\?")}(\\?.*)?$`));
    await expect(page.locator(":focus")).toHaveAccessibleName(row.focus);
    if (row.parent) return;
    await app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById("forward")?.click());
    await expect(page).toHaveURL(again);
  });
}

test("a part moved to inside the lesson is one entry: one press leaves the lesson", async () => {
  test.setTimeout(90_000);
  const { page } = walk;
  await rows[0]!.reach(walk);
  await page.getByRole("navigation", { name: "Parti del capitolo" }).getByRole("link", { name: /Interno, esterno, frontiera/ }).click();
  await expect(page).toHaveURL(/lesson\/t-fun\?part=2$/);
  await expect(backControl(page)).toHaveText(EXAM);
  await backControl(page).click();
  await expect(page).toHaveURL(new RegExp(`#${exam}$`));
});

test("A, B, back to A, then C: C goes back to A", async () => {
  test.setTimeout(90_000);
  const { page } = walk;
  await rows[1]!.reach(walk);
  await backControl(page).click();
  await expect(page).toHaveURL(new RegExp(`#${exam}$`));
  await side(page).getByRole("button", { name: "Quaderno degli errori" }).click();
  await expect(backControl(page)).toHaveText(EXAM);
  await backControl(page).click();
  await expect(page).toHaveURL(new RegExp(`#${exam}$`));
});

test("the sidebar lights the section the page came from, and every row opens its section's main page", async () => {
  test.setTimeout(90_000);
  const { page } = walk;
  const sections = page.getByRole("navigation", { name: "Sezioni" });
  const row = (name: string) => sections.getByRole("link", { name, exact: true });
  // A map opened from an exam keeps Esami lit, and Settings opened over that map does too.
  await rows[1]!.reach(walk);
  await expect(lit(page)).toHaveAccessibleName("Esami");
  await page.getByRole("button", { name: /^Profilo/ }).click();
  await page.getByRole("menuitem", { name: "Impostazioni" }).click();
  await expect(page).toHaveURL(/#\/settings$/);
  await expect(lit(page)).toHaveAccessibleName("Esami");
  // The rows go to the sections' main pages, whatever page the student left them on.
  await row("Mappe").click();
  await expect(page).toHaveURL(/#\/maps$/);
  await expect(lit(page)).toHaveAccessibleName("Mappe");
  await expect(backControl(page)).toHaveCount(0);
  await row("Esami").click();
  await expect(page).toHaveURL(/#\/exams$/);
  await expect(lit(page)).toHaveAccessibleName("Esami");
  // A chat lights its own row and nothing else.
  await page.locator(".px-side-chats").getByRole("link", { name: /Teorema di Bayes/ }).click();
  await expect(page).toHaveURL(/#\/ask\/c-bayes$/);
  await expect(lit(page)).toHaveCount(1);
  await expect(lit(page)).toHaveAccessibleName(/Teorema di Bayes/);
  await expect(backControl(page)).toHaveCount(0);
  // Vai goes straight to a section's root, and Indietro has nothing to do from there.
  await walk.app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById("maps")?.click());
  await expect(page).toHaveURL(/#\/maps$/);
  await expect(lit(page)).toHaveAccessibleName("Mappe");
  await expect(backControl(page)).toHaveCount(0);
});

test("Vai > Mappe does what the sidebar's row does, also on Mappe opened from an exam", async () => {
  test.setTimeout(90_000);
  const { page, app } = walk;
  await fromExam(async () => undefined)(walk);
  await side(page).getByRole("link", { name: "Tutte le mappe" }).click();
  await expect(page).toHaveURL(/#\/maps\?subject=s-an$/);
  // Mappe keeps the section of the exam it was opened from.
  await expect(lit(page)).toHaveAccessibleName("Esami");
  await app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById("maps")?.click());
  await expect(lit(page)).toHaveAccessibleName("Mappe");
  await expect(page).toHaveURL(/#\/maps$/);
  // Again, from the page the row opened: nothing is added to the history, and the row stays lit.
  const length = await page.evaluate(() => history.length);
  await app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById("maps")?.click());
  await expect(lit(page)).toHaveAccessibleName("Mappe");
  expect(await page.evaluate(() => history.length)).toBe(length);
});

test("the label follows the app's language, also after a reload", async () => {
  test.setTimeout(90_000);
  const { page } = walk;
  await start(page, "#/exams", "Esami");
  await page.getByRole("button", { name: /^(Altro su Esami|More for Exams)$/ }).click();
  await page.getByRole("menuitem", { name: "Quaderno degli errori" }).click();
  await expect(backControl(page)).toHaveText("Esami");
  await page.evaluate(() => localStorage.setItem("pyxis.lang", "en"));
  await page.reload();
  await expect(page.getByRole("button", { name: "Back to Exams" })).toHaveText("Exams");
  await page.evaluate(() => localStorage.setItem("pyxis.lang", "it"));
  await page.reload();
  await expect(backControl(page)).toHaveText("Esami");
});

test("the first page of a window goes back to its parent", async () => {
  test.setTimeout(90_000);
  await walk.app.close();
  const app = await launchPyxis({ userData, env: { PYXIS_ROUTE: `${exam}/lesson/t-fun?part=1` } });
  const page = await app.firstWindow();
  walk = { app, page };
  await expect(page.getByRole("heading", { level: 1, name: "Intorni e distanza" })).toBeVisible();
  await expect(backControl(page)).toHaveAccessibleName(`Torna a ${EXAM}`);
  await backControl(page).click();
  await expect(page).toHaveURL(new RegExp(`#${exam}$`));
  // The exam took the lesson's place, so the window has nothing behind it.
  expect(await page.evaluate(() => (history.state as { idx?: number } | null)?.idx ?? 0)).toBe(0);
});

test("every page with a back control has a row", () => {
  const router = readFileSync(join(process.cwd(), "src/renderer/src/app/router.tsx"), "utf8");
  const routes = [...router.matchAll(/\bpath: "([^"]+)"/g)]
    .map((match) => match[1]!)
    .filter((path) => path !== "/")
    .map((path) => (path.startsWith("/") || path === "*" ? path : `/${path}`));
  // Pages whose back control comes later, and pages that have none: sidebar sections, redirects, setup, the gallery.
  const later = new Set([
    "/plans/new",
    "/plans/new/guided",
    "/exams/get",
    "/settings/:section?",
    "/tools/whiteboard",
    "/tools/graph",
    "/tools/python",
    "/onboarding",
    "/ask/:chatId?",
  ]);
  const none = new Set(["/exams", "/exams/library", "/maps", "/flashcards", "/exams/planner", "/settings/subjects", "/dev/gallery", "*"]);
  const walked = new Set(rows.map((row) => row.page));
  // Study pages that open only on a session of their own (a review in progress, a handed-in simulation, past papers)
  // share the bar's control with the rows above.
  const shared = new Set([
    "/plans/:planId/past",
    "/plans/:planId/review/cards",
    "/plans/:planId/review/questions",
    "/plans/:planId/exam/:attemptId",
  ]);
  expect(routes.filter((route) => !walked.has(route) && !later.has(route) && !none.has(route) && !shared.has(route))).toEqual([]);
});
