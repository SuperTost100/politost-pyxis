import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { launchPyxis } from "./app-under-test";
import { removeTestFolder } from "./cleanup";
import { fromChiediToExams, toLibrary } from "./doors";
import { seedPlan, seedSource, seedSubjects } from "./seed";
import { atRest } from "./settled";
import { seedSourcePanel } from "./source-panel-fixture";

/**
 * A menu opened on a page that is scrolled stays open until the student scrolls the page under it. The page's own
 * three dots sit in a bar that stays at the top (the lesson's), or in a row of a list; a press on a button shrinks it
 * about its centre, and a `scroll` event can arrive a frame after the menu opened, so these specs open each menu every
 * way on a scrolled page and send it the late event.
 */

/** A way to ask for a menu; the last item says whether Escape gives the focus back to the button or row it came from. */
type Opener = [how: string, open: () => Promise<void>, focusBack?: boolean];

const menuOf = (page: Page) => page.getByRole("menu");

/** Scrolls the page and every scroller around `item` to its end, as a student does with the wheel. */
async function scrollToEnd(item: Locator) {
  await item.evaluate((node) => {
    for (let element: Element | null = node; element; element = element.parentElement)
      if (element.scrollHeight > element.clientHeight + 1) element.scrollTop = element.scrollHeight;
    document.scrollingElement?.scrollTo(0, document.scrollingElement.scrollHeight);
  });
  await atRest(item);
}

/** Scrolls `item` to the foot of its window, and waits until the scroll and its event are over. */
async function scrollDownTo(item: Locator) {
  await item.evaluate((node) => node.scrollIntoView({ block: "end" }));
  await atRest(item);
}

/**
 * The `scroll` event of a scroll that happened before the menu opened, arriving after it: it moved nothing now. Sent to
 * the document and to every scroller of the page, which the menu hears in the capture phase and weighs by whether the
 * scroller holds its item.
 */
async function lateScroll(item: Locator) {
  await item.evaluate(() => {
    document.dispatchEvent(new Event("scroll"));
    for (const element of document.querySelectorAll("*"))
      if (element.scrollHeight > element.clientHeight + 1) element.dispatchEvent(new Event("scroll"));
  });
}

/**
 * Every way to ask for the menu of a button: its click, a right-click on it, the context-menu key and Shift+F10. A
 * button that has no right-click of its own (`rightClick` false) leaves it to the row around it, which opens the menu at
 * the pointer without giving the focus back to the button.
 */
function dotsWays(page: Page, dots: Locator, rightClick = true): Opener[] {
  const centre = async () => {
    const box = (await dots.boundingBox())!;
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  };
  return [
    ["a click", () => dots.click()],
    ["a right-click at the pointer", async () => {
      const { x, y } = await centre();
      await page.mouse.click(x, y, { button: "right" });
    }, rightClick],
    ["a right-click by the test driver", () => dots.click({ button: "right" }), rightClick],
    ["the context-menu key", async () => {
      await dots.focus();
      await page.keyboard.press("ContextMenu");
    }],
    ["Shift+F10", async () => {
      await dots.focus();
      await page.keyboard.press("Shift+F10");
    }],
  ];
}

/** The ways to ask for the menu of a row: a right-click on it, and the keys on `focusable`, which is inside it. */
function rowWays(page: Page, row: Locator, focusable: Locator): Opener[] {
  return [
    ["a right-click at the pointer", async () => {
      const box = (await row.boundingBox())!;
      await page.mouse.click(box.x + Math.min(box.width / 2, 160), box.y + box.height / 2, { button: "right" });
    }, false],
    ["a right-click by the test driver", () => row.click({ button: "right" }), false],
    ["the context-menu key", async () => {
      await focusable.focus();
      await page.keyboard.press("ContextMenu");
    }],
    ["Shift+F10", async () => {
      await focusable.focus();
      await page.keyboard.press("Shift+F10");
    }],
  ];
}

/** The focus is inside the open menu. */
const focusInMenu = (page: Page, message: string) =>
  expect
    .soft.poll(() => page.evaluate(() => Boolean(document.activeElement?.closest(".px-item-menu"))), { message })
    .toBe(true);

/**
 * Opens the menu each way: it is open and has the focus, stays so when a late scroll event comes (and once the page
 * is at rest again), and Escape closes it and gives the focus back to `back`, when it is given. A menu without a
 * landmark, as the source panel's, takes the focus later (`takesFocus` false).
 */
async function staysOpen(page: Page, where: string, still: Locator, openers: Opener[], back?: Locator, takesFocus = true) {
  const menu = menuOf(page);
  for (const [how, open, focusBack = true] of openers) {
    const label = `${where}, ${how}`;
    await open();
    await expect.soft(menu, label).toBeVisible();
    await lateScroll(still);
    await atRest(still);
    await expect.soft(menu, label).toHaveCount(1);
    await expect.soft(menu, label).toBeVisible();
    if (takesFocus) await focusInMenu(page, `${label}: the focus is in the menu`);
    await page.keyboard.press("Escape");
    await expect.soft(menu, label).toHaveCount(0);
    if (back && focusBack) await expect.soft(back, label).toBeFocused();
  }
}

/** The sum of every scroller's offset: it changes when anything scrolls. */
const scrolledBy = (page: Page) =>
  page.evaluate(() => [...document.querySelectorAll("*"), document.scrollingElement!].reduce((sum, element) => sum + element.scrollTop, 0));

/** A wheel turn over the page, as a student scrolls: waits for the page to move, then for the scroll to end. */
async function wheel(page: Page, item: Locator, deltaY: number) {
  const before = await scrolledBy(page);
  await page.mouse.move(8, 400);
  await page.mouse.wheel(0, deltaY);
  await expect.poll(() => scrolledBy(page)).not.toBe(before);
  await atRest(item);
}

const longLesson = Array.from(
  { length: 24 },
  (_, index) => `## Sezione ${index + 1}\n\n${"La seconda legge di Newton lega forza, massa e accelerazione. ".repeat(12)}`,
).join("\n\n");

/** Starts the app on a window of `width` x `height`, past setup, on Esami, and lets `seed` write the workspace. */
async function start(seed: (db: DatabaseSync, userData: string) => void, size = { width: 1280, height: 832 }, env = {}) {
  const userData = mkdtempSync(join(tmpdir(), "pyxis-menu-scrolled-"));
  const app = await launchPyxis({ userData, env });
  const page = await app.firstWindow();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize(size);
  await page.getByRole("button", { name: "Salta" }).click();
  await fromChiediToExams(page);
  const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), { timeout: 10_000 });
  seed(db, userData);
  db.close();
  const done = async () => {
    await app.close();
    removeTestFolder(userData);
  };
  return { app, page, userData, done };
}

const go = (page: Page, hash: string) =>
  page.evaluate((to) => {
    location.hash = to;
  }, hash);

test("the three dots of a lesson open and stay open on a page scrolled to its foot", async () => {
  test.setTimeout(120_000);
  const { page, done } = await start((db) => {
    seedPlan(db, { id: "p-les", title: "Fisica 1", topics: [{ id: "t-les", title: "Forze" }] });
    db.prepare(
      "INSERT INTO items(id,plan_id,topic_id,kind,body_json,engine_provider,grounding,created_at) VALUES('i-les','p-les','t-les','lesson',?,'fixture','sources',1)",
    ).run(
      JSON.stringify({
        cacheKey: JSON.stringify({ kind: "lesson", scopeId: "t-les", promptVersion: "model-1", passageIds: [] }),
        markdown: longLesson,
      }),
    );
  });
  try {
    // The lesson's three dots are in a bar that stays at the top while the page scrolls.
    await go(page, "/plans/p-les/lesson/t-les");
    await expect(page.getByText("Sezione 24", { exact: false }).first()).toBeAttached();
    const dots = page.getByRole("button", { name: "Altre azioni" });
    await expect(dots).toBeVisible();
    // Not scrolled, in the middle and at the foot.
    await staysOpen(page, "lesson, top", dots, dotsWays(page, dots), dots);
    await page.evaluate(() => window.scrollTo(0, 3000));
    await atRest(dots);
    await staysOpen(page, "lesson, middle", dots, dotsWays(page, dots), dots);
    await scrollToEnd(dots);
    expect(await page.evaluate(() => scrollY)).toBeGreaterThan(5000);
    await staysOpen(page, "lesson, foot", dots, dotsWays(page, dots), dots);

    // The bar does not move when the page scrolls, so a menu hanging from its button stays under the wheel: the
    // click's does, and the right-click's must too.
    for (const [how, open] of dotsWays(page, dots).slice(0, 2)) {
      await open();
      await expect(menuOf(page), how).toBeVisible();
      await wheel(page, dots, -400);
      await expect(menuOf(page), `${how}, then a turn of the wheel`).toHaveCount(1);
      await page.keyboard.press("Escape");
      await expect(menuOf(page)).toHaveCount(0);
      await expect(dots).toBeFocused();
    }
  } finally {
    await done();
  }
});

test("the three dots of an answer, in a long chat scrolled to its end, and of a map open and stay open", async () => {
  test.setTimeout(120_000);
  const { page, done } = await start((db) => {
    seedSubjects(db, [{ id: "cin", name: "Cinema" }]);
    db.exec("INSERT INTO chats(id,title,created_at,updated_at) VALUES('c-long','Una lunga chat',1,100)");
    const message = db.prepare(
      "INSERT INTO messages(id,chat_id,role,body,engine_provider,model_id,model_source,created_at) VALUES(?,?,?,?,?,?,?,?)",
    );
    for (let index = 0; index < 30; index++) {
      const answer = index % 2 === 1;
      message.run(
        `m${index}`,
        "c-long",
        answer ? "assistant" : "user",
        answer ? `Risposta numero ${index}. ${"Una funzione continua su un intervallo chiuso ha un massimo. ".repeat(6)}` : `Domanda numero ${index}`,
        answer ? "claude" : null,
        answer ? "claude-sonnet-5" : null,
        answer ? "reported" : null,
        index + 1,
      );
    }
    const node = (id: string, label: string, parent: string | null) => ({ id, label, parent, x: 0, y: 0, pinned: false });
    db.prepare("INSERT INTO maps(id,subject_id,graph_json,grounding,created_at) VALUES('row-cin','cin',?,'sources',1)").run(
      JSON.stringify({
        version: 1,
        maps: [
          {
            id: "m-cin",
            title: "Il montaggio",
            passageIds: [],
            grounding: "sources",
            graph: {
              layout: "tree",
              undo: null,
              redo: null,
              nodes: [node("n0", "Montaggio", null), node("n1", "Taglio", "n0"), node("n2", "Dissolvenza", "n0")],
              edges: [
                { from: "n0", to: "n1" },
                { from: "n0", to: "n2" },
              ],
            },
          },
        ],
      }),
    );
  });
  try {
    await go(page, "/ask/c-long");
    await page.reload();
    const answer = page.locator(".px-msg:not(.px-msg-user)").last();
    await expect(answer).toContainText("Risposta numero 29");
    const dots = answer.getByRole("button", { name: "Altre azioni" });
    await expect(dots).toBeVisible();
    await scrollToEnd(dots);
    await staysOpen(page, "answer, end of the chat", dots, dotsWays(page, dots), dots);
    // The answer moves with the chat, so a turn of the wheel closes its menu.
    for (const [how, open] of dotsWays(page, dots).slice(0, 2)) {
      await scrollToEnd(dots);
      await open();
      await expect(menuOf(page), how).toBeVisible();
      await wheel(page, dots, -60);
      await expect(menuOf(page), `${how}, then a turn of the wheel`).toHaveCount(0);
    }

    await go(page, "/maps/cin?from=maps&map=m-cin");
    await expect(page.locator(".react-flow__node")).toHaveCount(3);
    const mapDots = page.locator(".px-map-actions").getByRole("button", { name: "Altro", exact: true });
    await scrollToEnd(mapDots);
    await staysOpen(page, "map page", mapDots, dotsWays(page, mapDots), mapDots);
  } finally {
    await done();
  }
});

/** A Library of six subjects with eight files each, in a window too short for it, and a book that opens in the source panel. */
function seedLibrary(db: DatabaseSync, userData: string) {
  seedSourcePanel(db, userData);
  const names = ["Analisi", "Chimica", "Cinema", "Diritto", "Economia", "Storia"];
  seedSubjects(db, names.map((name, index) => ({ id: `lib-${index}`, name: `${name} ${index + 1}`, position: index + 1 })));
  for (const [index] of names.entries())
    for (let file = 0; file < 8; file++)
      seedSource(db, {
        id: `lib-${index}-${file}`,
        title: `Dispensa ${index + 1}.${file + 1}`,
        subjectId: `lib-${index}`,
      });
}

test("a file's and a subject's menu in a long Library scrolled down, and the source panel's, open and stay open", async () => {
  test.setTimeout(180_000);
  const { page, done } = await start(seedLibrary, { width: 960, height: 600 });
  try {
    await toLibrary(page);
    const cover = page.locator("ul.px-shelf > li").last();
    const coverDots = cover.getByRole("button", { name: /^Azioni per / });
    await expect(coverDots).toBeAttached();
    await scrollDownTo(cover);
    expect(await page.evaluate(() => [...document.querySelectorAll("*")].some((element) => element.scrollTop > 100))).toBe(true);
    await staysOpen(page, "a file's dots, Library scrolled down", coverDots, dotsWays(page, coverDots, false), coverDots);
    await staysOpen(page, "a file's cover, Library scrolled down", coverDots, rowWays(page, cover, cover.getByRole("button").first()), cover.getByRole("button").first());

    const subjectDots = page.getByRole("button", { name: /^Azioni sulla materia / }).last();
    await scrollDownTo(subjectDots);
    await staysOpen(page, "a subject's dots, Library scrolled down", subjectDots, dotsWays(page, subjectDots, false), subjectDots);
    const subjectName = page.locator(".px-shelf-subject-name").last();
    await staysOpen(page, "a subject's name, Library scrolled down", subjectDots, rowWays(page, subjectName, subjectDots));

    // The panel: its head holds the file's menu, and the panel's own content scrolls under it.
    await page.getByRole("button", { name: "Fisica I · Mazzoldi, Nigro, Voci", exact: true }).scrollIntoViewIfNeeded();
    await page.getByRole("button", { name: "Fisica I · Mazzoldi, Nigro, Voci", exact: true }).click();
    const sheet = page.locator("aside.source-panel");
    await expect(sheet.getByRole("heading", { name: "Fisica I · Mazzoldi, Nigro, Voci" })).toBeFocused();
    await expect(sheet.locator(".source-pdf-page canvas")).toBeVisible();
    const content = sheet.locator(".source-view-page");
    const scrolled = await content.evaluate((node) => {
      node.scrollTop = node.scrollHeight;
      return node.scrollTop;
    });
    expect(scrolled).toBeGreaterThan(0);
    await atRest(content);
    const panelDots = sheet.getByRole("button", { name: /^Azioni su / });
    await staysOpen(page, "the source panel's dots, its content scrolled", panelDots, dotsWays(page, panelDots, false), panelDots, false);
    const head = sheet.locator(".source-viewer-head");
    await staysOpen(page, "the source panel's head, its content scrolled", panelDots, rowWays(page, head, sheet.getByRole("heading", { name: "Fisica I · Mazzoldi, Nigro, Voci" })), undefined, false);
  } finally {
    await done();
  }
});

test("a source row, a flashcard row and a row of Da finire open and stay open on a page scrolled down", async () => {
  test.setTimeout(180_000);
  const { page, done } = await start(
    (db) => {
      seedSubjects(db, [{ id: "s-an", name: "Analisi 1" }]);
      const sourceIds = Array.from({ length: 12 }, (_, index) => `row-${index}`);
      for (const id of sourceIds) seedSource(db, { id, title: `Dispensa ${id.slice(4)}`, subjectId: "s-an" });
      seedPlan(db, {
        id: "p-an",
        subjectId: "s-an",
        title: "Analisi 1",
        language: "it",
        topics: [{ id: "t-lim", title: "Limiti" }],
        sourceIds,
      });
      const card = db.prepare(
        "INSERT INTO cards(id,plan_id,topic_id,front,back,seed_key,grounding,created_at) VALUES(?,?,?,?,?,?,?,?)",
      );
      for (let index = 0; index < 30; index++)
        card.run(`c-${index}`, "p-an", "t-lim", `Domanda ${index + 1}`, `Risposta ${index + 1}`, `k${index}`, "sources", index);
      // Twelve quizzes started and left.
      const item = db.prepare(
        "INSERT INTO items(id,plan_id,topic_id,kind,body_json,created_at) VALUES(?,?,'t-lim','quiz',?,?)",
      );
      const attempt = db.prepare("INSERT INTO attempts(id,plan_id,item_id,started_at) VALUES(?,?,?,?)");
      for (let index = 0; index < 12; index++) {
        item.run(`q-${index}`, "p-an", JSON.stringify({ complete: true, questions: [{ id: `qq-${index}` }] }), 10 + index);
        attempt.run(`a-${index}`, "p-an", `q-${index}`, 1_000_000 + index);
      }
    },
    { width: 960, height: 600 },
  );
  try {
    // A source row of the exam's material.
    await go(page, "/plans/p-an/sources");
    const source = page.locator("li.px-source-row").last();
    await expect(source).toBeVisible();
    const sourceDots = source.getByRole("button", { name: /^Azioni per / });
    await scrollDownTo(sourceDots);
    expect(await page.evaluate(() => [...document.querySelectorAll("*")].some((element) => element.scrollTop > 100))).toBe(true);
    await staysOpen(page, "a source row's dots", sourceDots, dotsWays(page, sourceDots, false), sourceDots);
    await staysOpen(page, "a source row", sourceDots, rowWays(page, source, source.locator(".px-source-row-open")), source.locator(".px-source-row-open"));

    // The exam page's Da finire.
    await go(page, "/plans/p-an");
    const unfinished = page.locator(".px-unf-item").last();
    await expect(unfinished).toBeVisible();
    const unfinishedDots = unfinished.getByRole("button", { name: /^Azioni su / });
    await scrollDownTo(unfinishedDots);
    await staysOpen(page, "a Da finire row's dots", unfinishedDots, dotsWays(page, unfinishedDots, false), unfinishedDots);
    await staysOpen(page, "a Da finire row", unfinishedDots, rowWays(page, unfinished, unfinished.locator(".px-unf-open")), unfinished.locator(".px-unf-open"));

    // The flashcard browser.
    await go(page, "/exams/cards");
    const row = page.locator(".px-cardbrowser-row").last();
    await expect(row).toBeVisible();
    const cardDots = row.getByRole("button", { name: /^Altre azioni/ });
    await scrollDownTo(cardDots);
    await staysOpen(page, "a flashcard's dots", cardDots, dotsWays(page, cardDots, false), cardDots);
    await staysOpen(page, "a flashcard row", cardDots, rowWays(page, row, cardDots), cardDots);
  } finally {
    await done();
  }
});

test("a linked folder's menu in a long list of Cartelle collegate opens and stays open", async () => {
  test.setTimeout(240_000);
  const { app, page, done } = await start(() => {}, { width: 960, height: 600 }, { PYXIS_E2E_FILE: undefined });
  const base = mkdtempSync(join(tmpdir(), "pyxis-folders-"));
  try {
    const folders = Array.from({ length: 14 }, (_, index) => {
      const folder = join(base, `Corso ${String(index + 1).padStart(2, "0")}`);
      mkdirSync(folder, { recursive: true });
      writeFileSync(join(folder, "Appunti.txt"), `Appunti del corso ${index + 1}: il campo elettrico decresce con la distanza.`);
      return folder;
    });
    await app.evaluate(({ dialog }, answer) => {
      delete process.env["PYXIS_E2E_FILE"];
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: answer })) as typeof dialog.showOpenDialog;
    }, folders);
    await page.evaluate(async () => {
      const picked = await window.pyxis.showOpenDialog({ properties: ["openDirectory", "multiSelections"] });
      const linked = await window.pyxis.invoke("sources.linkFolders", { paths: picked ?? [], mode: "subject" });
      await window.pyxis.invoke("sources.confirmFolders", {
        folders: linked.folders.map((folder) => ({ folderId: folder.id, subjects: [] })),
      });
    });
    await go(page, "/exams/library");
    await page.getByRole("button", { name: /^\d+ cartell[ae] collegat[ae]/ }).click();
    const list = page.getByRole("dialog", { name: "Cartelle collegate" });
    await expect(list).toBeVisible();
    const row = list.getByRole("listitem").last();
    const dots = row.getByRole("button", { name: /^Azioni sulla cartella / });
    await expect(dots).toBeVisible();
    await scrollDownTo(dots);
    expect(await list.evaluate((node) => [node, ...node.querySelectorAll("*")].some((element) => element.scrollTop > 20))).toBe(true);
    await staysOpen(page, "a linked folder's dots", dots, dotsWays(page, dots, false).slice(0, 1), dots);
    await staysOpen(page, "a linked folder's row", dots, rowWays(page, row, dots), dots);
  } finally {
    removeTestFolder(base);
    await done();
  }
});
