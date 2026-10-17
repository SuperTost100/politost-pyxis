import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const MAIN = join(
  process.cwd(),
  process.env.PYXIS_OUT ?? "out",
  "main/index.js",
);
const mac = process.platform === "darwin";

async function launch(options: { onboarded: boolean }) {
  const userData = mkdtempSync(join(tmpdir(), "pyxis-app-menu-"));
  const env = {
    ...process.env,
    PYXIS_USER_DATA: userData,
    PYXIS_E2E: "1",
    PYXIS_E2E_RELEASE: JSON.stringify({
      tag_name: "v9.9.9",
      body: "Fixture release.",
      draft: false,
      prerelease: false,
    }),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: [MAIN], env });
  const page = await app.firstWindow();
  if (options.onboarded) {
    await page.getByRole("button", { name: "Salta" }).click();
    await expect(page).toHaveURL(/#\/exams$/);
  }
  return { app, page, userData };
}

/** Picks a menu item the way a click on it would: runs its handler in the main process. */
async function pick(app: ElectronApplication, id: string) {
  const found = await app.evaluate(({ Menu }, id) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById(id);
    item?.click();
    return Boolean(item);
  }, id);
  expect(found, `menu item ${id}`).toBe(true);
}

/** Time for a command that must do nothing to have done something. */
async function settle(page: Page) {
  await page.waitForTimeout(400);
}

function topLevel(app: ElectronApplication) {
  return app.evaluate(({ Menu }) =>
    Menu.getApplicationMenu()?.items.map((item) => item.label),
  );
}

function seed(userData: string, run: (db: DatabaseSync) => void) {
  const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), {
    timeout: 10000,
  });
  try {
    run(db);
  } finally {
    db.close();
  }
}

test("the menu follows the interface language and hides its bar on Windows and Linux", async () => {
  const { app, page, userData } = await launch({ onboarded: true });
  try {
    const italian = ["File", "Modifica", "Vai", "Vista", "Aiuto"];
    const english = ["File", "Edit", "Go", "View", "Help"];
    const withApp = (labels: string[]) =>
      mac
        ? [
            "PoliTost Pyxis",
            ...labels.slice(0, 4),
            labels[4] === "Aiuto" ? "Finestra" : "Window",
            labels[4]!,
          ]
        : labels;
    await expect.poll(() => topLevel(app)).toEqual(withApp(italian));

    if (!mac)
      expect(
        await app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0]!.isMenuBarAutoHide(),
        ),
      ).toBe(true);

    // Changing the language in Settings rebuilds the menu while the app runs.
    await page.evaluate(() => {
      location.hash = "/settings/language";
    });
    await page.getByRole("button", { name: "English", exact: true }).click();
    await expect.poll(() => topLevel(app)).toEqual(withApp(english));
    const labels = await app.evaluate(
      ({ Menu }) =>
        Menu.getApplicationMenu()?.getMenuItemById("new-exam")?.label,
    );
    expect(labels).toBe("New exam");

    // A reload reports the language again, and Italian comes back the same way.
    await page.getByRole("button", { name: "Italiano", exact: true }).click();
    await expect.poll(() => topLevel(app)).toEqual(withApp(italian));
    await page.reload();
    await expect.poll(() => topLevel(app)).toEqual(withApp(italian));

    // Development builds keep reload and developer tools; this build is not packaged.
    const view = await app.evaluate(({ Menu }) =>
      Menu.getApplicationMenu()
        ?.items.find((item) => item.label === "Vista")
        ?.submenu?.items.map((item) => item.role),
    );
    expect(view).toEqual(
      expect.arrayContaining([
        "zoomin",
        "zoomout",
        "resetzoom",
        "reload",
        "toggledevtools",
      ]),
    );
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
});

test("menu items open their pages, the shortcuts list, the updates check and the issue tracker", async () => {
  const { app, page, userData } = await launch({ onboarded: true });
  try {
    // The renderer starts listening a moment after the page shows, and a command sent earlier is dropped. Retry the first.
    await expect(async () => {
      await pick(app, "new-exam");
      await expect(page).toHaveURL(/#\/plans\/new$/, { timeout: 500 });
    }).toPass();
    await pick(app, "back");
    await expect(page).toHaveURL(/#\/exams$/);

    await pick(app, "settings");
    await expect(page).toHaveURL(/#\/settings$/);
    await pick(app, "ask");
    await expect(page).toHaveURL(/#\/ask$/);
    await pick(app, "maps");
    await expect(page).toHaveURL(/#\/maps$/);
    await expect(
      page.getByRole("heading", { level: 1, name: "Mappe" }),
    ).toBeVisible();
    await pick(app, "library");
    await expect(page).toHaveURL(/#\/exams\/library$/);
    await pick(app, "flashcards");
    await expect(page).toHaveURL(/#\/exams\/cards$/);
    await pick(app, "exams");
    await expect(page).toHaveURL(/#\/exams$/);
    // The Exams door remembers where it was left after the page renders; on a slow runner the next picks can come first.
    await expect
      .poll(() =>
        page.evaluate(
          () => (JSON.parse(sessionStorage.getItem("pyxis.lastDoorPath") ?? "{}") as { exams?: string }).exams,
        ),
      )
      .toBe("/exams");
    await pick(app, "new-chat");
    await expect(page).toHaveURL(/#\/ask$/);
    await pick(app, "about");
    await expect(page).toHaveURL(/#\/settings\/about$/);

    // The check runs on arrival. Main counts the requests that reach it.
    await app.evaluate(({ ipcMain }) => {
      const counter = globalThis as unknown as { checks: number };
      counter.checks = 0;
      ipcMain.removeHandler("updates:check");
      ipcMain.handle("updates:check", () => {
        counter.checks += 1;
        return { state: "current", current: "0.2.3", checkedAt: Date.now() };
      });
    });
    await pick(app, "exams");
    await expect(page).toHaveURL(/#\/exams$/);
    const checks = () =>
      app.evaluate(() => (globalThis as unknown as { checks: number }).checks);
    const before = await checks();
    await pick(app, "check-updates");
    await expect(page).toHaveURL(/#\/settings\/updates$/);
    await expect.poll(checks).toBe(before + 1);

    // Keyboard shortcuts: an accessible dialog with the menu's keys and the page keys.
    await pick(app, "shortcuts");
    const dialog = page.getByRole("dialog", {
      name: "Scorciatoie da tastiera",
    });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("Nuovo esame")).toBeVisible();
    await expect(dialog.getByText("Gira la scheda")).toBeVisible();
    await expect(dialog.getByText("Annulla l'ultimo tratto")).toBeVisible();
    await expect(
      dialog.getByText("Controlla una risposta scritta"),
    ).toBeVisible();
    await expect(dialog.getByText("Interrompi la risposta")).toBeVisible();
    // Focus is inside the dialog, and Escape closes it and returns to the page behind.
    await expect
      .poll(() =>
        page.evaluate(() =>
          Boolean(document.activeElement?.closest("[role=dialog]")),
        ),
      )
      .toBe(true);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(page).toHaveURL(/#\/settings\/updates$/);

    // Report a problem goes through openExternal, to the issue tracker only.
    await app.evaluate(({ shell }) => {
      (globalThis as unknown as { opened: string[] }).opened = [];
      shell.openExternal = async (url: string) => {
        (globalThis as unknown as { opened: string[] }).opened.push(url);
      };
    });
    await pick(app, "report-problem");
    await expect
      .poll(() =>
        app.evaluate(
          () => (globalThis as unknown as { opened: string[] }).opened,
        ),
      )
      .toEqual(["https://github.com/SuperTost100/politost-pyxis/issues/new"]);
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
});

test("a menu pick does nothing during setup", async () => {
  const { app, page, userData } = await launch({ onboarded: false });
  try {
    await expect(page).toHaveURL(/#\/onboarding/);
    for (const id of [
      "settings",
      "ask",
      "new-exam",
      "library",
      "back",
      "shortcuts",
      "about",
    ]) {
      await pick(app, id);
      await settle(page);
      await expect(page).toHaveURL(/#\/onboarding/);
      await expect(page.getByRole("dialog")).toHaveCount(0);
    }
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
});

test("a menu pick leaves a dialog, unsaved text, a quiz and a running simulation alone", async () => {
  test.setTimeout(90000);
  const { app, page, userData } = await launch({ onboarded: true });
  try {
    await page.evaluate(() => window.pyxis.invoke("plans.list", {}));
    seed(userData, (db) =>
      db.exec(`
        INSERT INTO plans(id,title,status,content_language,target,created_at,updated_at) VALUES('menu-plan','Fisica 1','ready','it',0.75,1,1);
        INSERT INTO topics(id,plan_id,title,position,created_at) VALUES('menu-topic','menu-plan','Dinamica',0,1);
      `),
    );
    await page.reload();
    // An open dialog.
    await page.getByRole("button", { name: "Gestisci materie" }).click();
    const manage = page.getByRole("dialog");
    await expect(manage).toBeVisible();
    await pick(app, "settings");
    await pick(app, "shortcuts");
    await settle(page);
    await expect(page).toHaveURL(/#\/exams$/);
    await expect(
      page.getByRole("dialog", { name: "Scorciatoie da tastiera" }),
    ).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(manage).toHaveCount(0);

    // Text typed into a field that the app does not keep.
    const search = page.getByRole("textbox", { name: "Cerca un piano" });
    await search.fill("fisica");
    await pick(app, "ask");
    await settle(page);
    await expect(page).toHaveURL(/#\/exams$/);
    await search.fill("");
    await pick(app, "ask");
    await expect(page).toHaveURL(/#\/ask$/);

    // The Ask composer keeps its draft per chat, so the menu may leave it, and the draft is there on return.
    const composer = page.getByRole("textbox", { name: "Messaggio" });
    await composer.click();
    await page.keyboard.type("bozza della domanda");
    await expect(composer).toContainText("bozza della domanda");
    await pick(app, "exams");
    await expect(page).toHaveURL(/#\/exams$/);
    await pick(app, "ask");
    await expect(page).toHaveURL(/#\/ask$/);
    await expect(
      page.getByRole("textbox", { name: "Messaggio" }),
    ).toContainText("bozza della domanda");
    await pick(app, "new-chat");
    await expect(page).toHaveURL(/#\/ask$/);
    await expect(
      page.getByRole("textbox", { name: "Messaggio" }),
    ).toContainText("bozza della domanda");

    // Code typed into the Python tool is not saved. With focus moved off the editor, only the page's lock holds the menu.
    await page.evaluate(() => {
      location.hash = "/tools/python";
    });
    const editor = page.getByRole("textbox", { name: /codice|code/i });
    await editor.fill("print('quasi finito')");
    await editor.blur();
    await pick(app, "exams");
    await pick(app, "settings");
    await settle(page);
    await expect(page).toHaveURL(/#\/tools\/python$/);
    await expect(editor).toHaveValue("print('quasi finito')");
    // Back at the starting example, there is nothing to lose.
    await editor.fill("print(1 + 1)");
    await editor.blur();
    await pick(app, "exams");
    await expect(page).toHaveURL(/#\/exams$/);

    // A quiz being answered, and a simulation that is running.
    const now = Date.now();
    seed(userData, (db) => {
      const questions = Array.from({ length: 3 }, (_, i) => ({
        id: `menu-question-${i}`,
        topicId: "menu-topic",
        stem: `Domanda ${i + 1}`,
        options: ["Prima", "Seconda", "Terza", "Quarta"],
        explanation: "Spiegazione.",
        answer: { kind: "mcq", correct: 0, picked: -1 },
      }));
      db.prepare(
        "INSERT INTO items(id,plan_id,topic_id,kind,body_json,engine_provider,grounding,created_at) VALUES('menu-quiz','menu-plan','menu-topic','quiz',?,'fixture','sources',?)",
      ).run(
        JSON.stringify({
          questions,
          config: { count: 3, feedback: true, types: ["mcq"] },
          complete: true,
        }),
        now,
      );
      db.prepare(
        "INSERT INTO attempts(id,plan_id,item_id,started_at) VALUES('menu-quiz-attempt','menu-plan','menu-quiz',?)",
      ).run(now);
    });
    await page.evaluate(() => {
      location.hash =
        "/plans/menu-plan/quiz/menu-topic?attempt=menu-quiz-attempt";
    });
    await expect(page.locator(".px-quiz-question")).toBeVisible();
    await settle(page);
    const quiz = page.url();
    for (const id of [
      "settings",
      "ask",
      "exams",
      "new-exam",
      "new-chat",
      "library",
      "about",
      "back",
    ]) {
      await pick(app, id);
      await settle(page);
      expect(page.url(), id).toBe(quiz);
    }
    // The list of shortcuts is the one thing that opens: its quiz keys are worth looking up.
    await pick(app, "shortcuts");
    await expect(
      page.getByRole("dialog", { name: "Scorciatoie da tastiera" }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);

    seed(userData, (db) => {
      db.prepare(
        "UPDATE attempts SET submitted_at = ? WHERE id = 'menu-quiz-attempt'",
      ).run(now);
      db.prepare(
        "INSERT INTO items(id,plan_id,topic_id,kind,body_json,engine_provider,grounding,created_at) VALUES('menu-exam','menu-plan','menu-topic','simulation',?,'fixture','sources',?)",
      ).run(JSON.stringify({ minutes: 60, questions: [], picks: {} }), now);
      db.prepare(
        "INSERT INTO attempts(id,plan_id,item_id,started_at) VALUES('menu-exam-attempt','menu-plan','menu-exam',?)",
      ).run(now);
    });
    // On a page inside the shell, the exam in progress holds the menu too.
    await page.evaluate(() => {
      location.hash = "/exams";
    });
    await expect(page.getByRole("button", { name: "Riprendi" })).toBeVisible();
    await pick(app, "settings");
    await settle(page);
    await expect(page).toHaveURL(/#\/exams$/);
    // And on the exam page itself.
    await page.evaluate(() => {
      location.hash = "/plans/menu-plan/exam/menu-exam-attempt";
    });
    await expect(page.getByRole("timer")).toBeVisible();
    await settle(page);
    const exam = page.url();
    for (const id of ["settings", "ask", "library", "new-exam"]) {
      await pick(app, id);
      await settle(page);
      expect(page.url(), id).toBe(exam);
    }
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
});
