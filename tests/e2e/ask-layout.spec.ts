import {
  expect,
  test,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { launchPyxis } from "./app-under-test";
import { seedPlan, seedSource, seedSubjects } from "./seed";

const REPLY = [
  "Per parti usa $\\int u\\,dv = uv - \\int v\\,du$ [P1].",
  "",
  "Poni $u=x$ e $dv=e^{x}dx$, quindi $\\int x e^{x}dx = e^{x}(x-1)+C$.",
  "",
  "<followups>",
  "Fammi un altro esempio",
  "Come scelgo u e dv?",
  "Quando serve due volte?",
  "</followups>",
].join("\n");

/** A reply many screens tall, so the chat scrolls far more than one wheel turn whatever fonts the platform has. */
const LONG_REPLY = [
  ...Array.from(
    { length: 24 },
    (_, i) =>
      `Passo ${i + 1}: si sceglie $u$ come la parte che si semplifica derivando e $dv$ come quella che si integra senza fatica, poi si applica la formula e si controlla il risultato derivandolo.`,
  ).flatMap((line) => [line, ""]),
  "<followups>",
  "Fammi un altro esempio",
  "</followups>",
].join("\n");

async function launch(extra: Record<string, string> = {}) {
  const userData = mkdtempSync(join(tmpdir(), "pyxis-ask-layout-"));
  const env = {
    PYXIS_E2E_REPLY: REPLY,
    ...extra,
  };
  const app = await launchPyxis({ userData, env });
  const page = await app.firstWindow();
  await page.getByRole("button", { name: "Salta" }).click();
  await expect(page).toHaveURL(/#\/exams$/);
  return { app, page, userData };
}

/** Two subjects, each with a plan and a source, plus a source in no plan. Fisica's source holds the passage the reply cites. */
function seed(userData: string) {
  const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), { timeout: 10000 });
  seedSubjects(db, [{ id: "s-fis", name: "Fisica" }, { id: "s-an", name: "Analisi 2" }]);
  seedSource(db, {
    id: "src-fis",
    title: "Appunti di fisica",
    document: { id: "d-fis" },
    passages: [
      {
        id: "pa1",
        text: "Come si risolve un integrale per parti: la formula integrale per parti di u dv vale uv meno integrale di v du.",
        locator: { chapter: 1, paragraph: "p1" },
        section: "1. Integrali",
      },
    ],
  });
  seedSource(db, { id: "src-fis2", title: "Esercizi di meccanica" });
  seedSource(db, { id: "src-an", title: "Dispense di analisi 2" });
  seedSource(db, { id: "src-free", title: "Slide di chimica" });
  seedPlan(db, {
    id: "p-fis",
    subjectId: "s-fis",
    title: "Fisica 1",
    language: "it",
    target: 0.75,
    sourceIds: ["src-fis", "src-fis2"],
  });
  seedPlan(db, {
    id: "p-an",
    subjectId: "s-an",
    title: "Analisi 2",
    language: "it",
    target: 0.75,
    sourceIds: ["src-an"],
  });
  db.close();
}

async function chat(page: Page) {
  return page.evaluate(
    () =>
      window.pyxis.invoke("chats.read", {
        chatId: location.hash.split("/").at(-1)!,
      }) as Promise<{
        sourceIds: string[];
        subject: string | null;
        messages: Array<{ role: string; body: string }>;
      }>,
  );
}

async function finish(app: ElectronApplication, userData: string) {
  await app.close();
  rmSync(userData, { recursive: true, force: true });
}

test("Ask: the composer chip is the only subject control and picks the subject's sources", async () => {
  test.setTimeout(120000);
  const { app, page, userData } = await launch();
  try {
    seed(userData);
    await page.evaluate(() => {
      location.hash = "/ask";
    });
    await page.reload();
    await page.getByRole("heading", { level: 1 }).waitFor();
    // The old Select row and the loose source lists are gone.
    await expect(page.getByRole("combobox")).toHaveCount(0);
    await expect(page.locator(".choice")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Gestisci materie" })).toHaveCount(0);

    const subject = page.getByRole("button", { name: /^Materia:/ });
    await expect(subject).toHaveText("Nessuna materia");
    await expect(page.getByRole("button", { name: "Fonti", exact: true })).toBeVisible();

    await subject.click();
    // Focus moves into the menu, so the keyboard can pick.
    await expect(page.getByRole("button", { name: "Nessuna materia", exact: true })).toBeFocused();
    await expect(page.getByRole("button", { name: "Gestisci materie" })).toBeVisible();
    await page.getByRole("button", { name: "Fisica", exact: true }).click();
    await expect(subject).toHaveText("Fisica");

    // Fisica's plan brings its two sources, and nothing of Analisi 2.
    const sources = page.getByRole("button", { name: "2 fonti" });
    await sources.click();
    const menu = page.getByRole("region", { name: "Fonti in uso" });
    await expect(menu.getByRole("button").first()).toBeFocused();
    await expect(menu.getByText("Appunti di fisica")).toBeVisible();
    await expect(menu.getByText("Esercizi di meccanica")).toBeVisible();
    await expect(menu.getByText("Dispense di analisi 2")).toHaveCount(0);

    // Remove one, then add another from the library.
    await menu.getByRole("button", { name: "Rimuovi Esercizi di meccanica" }).click();
    await expect(page.getByRole("button", { name: "1 fonte" })).toBeVisible();
    await menu.getByRole("button", { name: "Aggiungi fonti" }).click();
    await menu.getByRole("button", { name: "Slide di chimica" }).click();
    await menu.getByRole("button", { name: "Indietro" }).click();
    await expect(page.getByRole("button", { name: "2 fonti" })).toBeVisible();
    await page.keyboard.press("Escape");

    // Switching subject swaps the subject's sources and keeps the one added by hand.
    await subject.click();
    await page.getByRole("button", { name: "Analisi 2", exact: true }).click();
    await page.getByRole("button", { name: "2 fonti" }).click();
    await expect(menu.getByText("Dispense di analisi 2")).toBeVisible();
    await expect(menu.getByText("Slide di chimica")).toBeVisible();
    await expect(menu.getByText("Appunti di fisica")).toHaveCount(0);
    await page.keyboard.press("Escape");

    // Back to Fisica, then ask: the chat stores that scope and restores it.
    await subject.click();
    await page.getByRole("button", { name: "Fisica", exact: true }).click();
    const box = page.getByRole("textbox", { name: "Messaggio" });
    await box.fill("Come si risolve un integrale per parti?");
    await box.press("Enter");
    await expect(page).toHaveURL(/#\/ask\/.+/);
    await expect(page.getByRole("button", { name: "Fammi un altro esempio" })).toBeVisible();
    const stored = await chat(page);
    expect(stored.subject).toBe("Fisica");
    expect(stored.sourceIds.sort()).toEqual(["src-fis", "src-fis2", "src-free"].sort());
    await page.evaluate(() => {
      location.hash = "/ask";
    });
    await expect(page.getByRole("button", { name: "Fonti", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Apri le chat" }).click();
    await page.getByRole("button", { name: "Come si risolve un integrale per parti?", exact: true }).click();
    await expect(page.getByRole("button", { name: /^Materia: Fisica/ })).toBeVisible();
    await expect(page.getByRole("button", { name: "3 fonti" })).toBeVisible();
  } finally {
    await finish(app, userData);
  }
});

test("Ask: panel, automatic titles, rename and delete, greeting and the thinking placeholder", async () => {
  test.setTimeout(120000);
  const { app, page, userData } = await launch({ PYXIS_E2E_REPLY_DELAY: "3000" });
  try {
    await page.evaluate(() => window.pyxis.invoke("profile.save", { displayName: "Tommaso" }));
    await page.evaluate(() => {
      location.hash = "/ask";
    });
    await page.reload();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Ciao, Tommaso");
    await expect(page.getByRole("button", { name: "Nuova chat" })).toBeVisible();

    const question =
      "Mi spieghi con calma come si dimostra il teorema fondamentale del calcolo integrale partendo dalla definizione?";
    const box = page.getByRole("textbox", { name: "Messaggio" });
    await box.fill(question);
    await box.press("Enter");
    // The question and a status line show at once, before any text streams.
    await expect(page.locator(".px-msg-bubble", { hasText: question })).toBeVisible();
    await expect(box).toHaveText("");
    await expect(page.getByText("Sto pensando…")).toBeVisible();
    await expect(page.getByText("Fammi un altro esempio")).toBeVisible({ timeout: 30000 });
    await expect(page.getByText("Sto pensando…")).toHaveCount(0);

    // The chat is named after the first message, cut near 60 characters.
    await page.getByRole("button", { name: "Apri le chat" }).click();
    const list = page.getByRole("list", { name: "Chat" });
    const title = (await list.getByRole("button", { name: /^Mi spieghi/ }).textContent()) ?? "";
    expect(title.length).toBeLessThanOrEqual(61);
    expect(title.endsWith("…")).toBe(true);
    await expect(list.getByRole("textbox")).toHaveCount(0);

    // Rename on demand: Esc cancels, Enter saves.
    const actions = list.getByRole("button", { name: /^Azioni per Mi spieghi/ });
    await actions.click();
    await page.getByRole("menuitem", { name: "Rinomina" }).click();
    const field = page.getByRole("textbox", { name: "Nome della chat" });
    await field.fill("Scartato");
    await field.press("Escape");
    await expect(list.getByRole("button", { name: /^Mi spieghi/ })).toBeVisible();
    await list.getByRole("button", { name: /^Azioni per Mi spieghi/ }).click();
    await page.getByRole("menuitem", { name: "Rinomina" }).click();
    await page.getByRole("textbox", { name: "Nome della chat" }).fill("Teorema fondamentale");
    await page.getByRole("textbox", { name: "Nome della chat" }).press("Enter");
    await expect(list.getByRole("button", { name: "Teorema fondamentale", exact: true })).toBeVisible();

    // Delete asks first.
    await list.getByRole("button", { name: "Azioni per Teorema fondamentale" }).click();
    await page.getByRole("menuitem", { name: "Elimina" }).click();
    const dialog = page.getByRole("dialog", { name: "Eliminare questa chat?" });
    await dialog.getByRole("button", { name: "Annulla" }).click();
    await expect(list.getByRole("button", { name: "Teorema fondamentale", exact: true })).toBeVisible();
    await list.getByRole("button", { name: "Azioni per Teorema fondamentale" }).click();
    await page.getByRole("menuitem", { name: "Elimina" }).click();
    await page.getByRole("button", { name: "Elimina per sempre" }).click();
    await expect(page.getByText("Le tue chat compaiono qui.")).toBeVisible();
    await expect(page).toHaveURL(/#\/ask$/);
  } finally {
    await finish(app, userData);
  }
});

test("Ask: composer stays docked, the newest message is in view and nothing overlaps", async () => {
  test.setTimeout(150000);
  const { app, page, userData } = await launch();
  try {
    seed(userData);
    await page.setViewportSize({ width: 960, height: 640 });
    await page.evaluate(() => {
      location.hash = "/ask";
    });
    await page.reload();
    await page.getByRole("heading", { level: 1 }).waitFor();
    const box = page.getByRole("textbox", { name: "Messaggio" });
    // The composer sits at the foot of the window on an empty page.
    const foot = async () =>
      page.evaluate(() => {
        const composer = document.querySelector(".px-composer")!.getBoundingClientRect();
        return window.innerHeight - composer.bottom;
      });
    // On macOS the layout can settle after the first paint, so wait for it.
    await expect.poll(foot).toBeLessThan(40);

    await box.fill("Come si risolve un integrale per parti?");
    await box.press("Enter");
    await expect(page.getByRole("button", { name: "Fammi un altro esempio" })).toBeVisible();
    for (const text of ["Una seconda domanda", "Una terza domanda"]) {
      await box.fill(text);
      await box.press("Enter");
      await expect(page.getByText(text, { exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Interrompi" })).toHaveCount(0, { timeout: 90000 });
    }
    // With a subject chosen and nothing in its sources about the question, the reply is still given, marked as general knowledge.
    await page.getByRole("button", { name: /^Materia:/ }).click();
    await page.getByRole("button", { name: "Analisi 2", exact: true }).click();
    await box.fill("Una domanda fuori materia");
    await box.press("Enter");
    // Slow hosted runners can take well over 30 s for a recorded reply.
    await expect(page.getByText("Conoscenza generale, non dalle tue fonti")).toBeVisible({ timeout: 90000 });
    await expect(page.getByText("Il materiale non copre questa domanda.")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Interrompi" })).toHaveCount(0, { timeout: 90000 });
    // The earlier replies, from a chat with nothing selected, carry no badge.
    await expect(page.getByText("Conoscenza generale, non dalle tue fonti")).toHaveCount(1);

    // The page scrolls to the newest message after the reply ends; a slow runner can measure before it gets there.
    await expect
      .poll(() =>
        page.evaluate(() => {
          const root = document.scrollingElement!;
          return root.scrollHeight - root.scrollTop - root.clientHeight;
        }),
      )
      .toBeLessThan(4);
    const layout = await page.evaluate(() => {
      const top = (selector: string) => document.querySelector(selector)?.getBoundingClientRect();
      const chips = [...document.querySelectorAll(".px-msg-chips .px-chip")].map((el) => el.getBoundingClientRect());
      const users = [...document.querySelectorAll(".px-msg-user")].map((el) => el.getBoundingClientRect());
      const root = document.scrollingElement!;
      return {
        chipsTop: Math.min(...chips.map((r) => r.top)),
        chipsBottom: Math.max(...chips.map((r) => r.bottom)),
        lastUserBottom: users.at(-1)!.bottom,
        composerTop: top(".px-composer")!.top,
        composerBottom: top(".px-composer")!.bottom,
        viewport: window.innerHeight,
        atBottom: root.scrollHeight - root.scrollTop - root.clientHeight,
      };
    });
    expect(layout.lastUserBottom).toBeLessThanOrEqual(layout.chipsTop);
    expect(layout.chipsBottom).toBeLessThanOrEqual(layout.composerTop);
    expect(layout.composerBottom).toBeLessThanOrEqual(layout.viewport);
    expect(layout.composerBottom).toBeGreaterThan(layout.viewport - 40);
    expect(layout.atBottom).toBeLessThan(4);

    // Scrolled to the top the composer is still in view; opening the chat again lands on the latest message.
    await page.evaluate(() => document.scrollingElement!.scrollTo({ top: 0 }));
    await expect.poll(foot).toBeLessThan(40);
    await page.getByRole("button", { name: "Nuova chat" }).click();
    await page.getByRole("button", { name: "Apri le chat" }).click();
    await page.getByRole("list", { name: "Chat" }).getByRole("button").first().click();
    await expect(page.getByText("Una domanda fuori materia", { exact: true })).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(() => {
          const root = document.scrollingElement!;
          return root.scrollHeight - root.scrollTop - root.clientHeight;
        }),
      )
      .toBeLessThan(4);
  } finally {
    await finish(app, userData);
  }
});

test("Ask: content that grows after a reply, such as the suggestion chips, stays in view", async () => {
  test.setTimeout(120000);
  const { app, page, userData } = await launch();
  try {
    seed(userData);
    await page.setViewportSize({ width: 960, height: 640 });
    await page.evaluate(() => {
      location.hash = "/ask";
    });
    await page.reload();
    const box = page.getByRole("textbox", { name: "Messaggio" });
    for (const text of ["Come si risolve un integrale per parti?", "Una seconda domanda"]) {
      await box.fill(text);
      await box.press("Enter");
      await expect(page.getByRole("button", { name: "Interrompi" })).toHaveCount(0, { timeout: 90000 });
    }
    const gap = () =>
      page.evaluate(() => {
        const root = document.scrollingElement!;
        return root.scrollHeight - root.scrollTop - root.clientHeight;
      });
    await expect.poll(gap).toBeLessThan(4);
    // Late content, like the chips that arrive after the reply, and a scroll event before Pyxis has caught up with it.
    // A slow computer does exactly this; the student never scrolled up, so the page must still follow.
    await page.evaluate(() => {
      const late = document.createElement("div");
      late.style.height = "300px";
      document.querySelector(".ask-page")!.append(late);
      window.dispatchEvent(new Event("scroll"));
    });
    await expect.poll(gap).toBeLessThan(4);
  } finally {
    await finish(app, userData);
  }
});

test("Ask: a layout shift above the end of the chat is not the student scrolling up", async () => {
  test.setTimeout(120000);
  const { app, page, userData } = await launch();
  try {
    seed(userData);
    await page.setViewportSize({ width: 960, height: 640 });
    await page.evaluate(() => {
      location.hash = "/ask";
    });
    await page.reload();
    const box = page.getByRole("textbox", { name: "Messaggio" });
    for (const text of ["Come si risolve un integrale per parti?", "Una seconda domanda"]) {
      await box.fill(text);
      await box.press("Enter");
      await expect(page.getByRole("button", { name: "Interrompi" })).toHaveCount(0, { timeout: 90000 });
    }
    const gap = () =>
      page.evaluate(() => {
        const root = document.scrollingElement!;
        return root.scrollHeight - root.scrollTop - root.clientHeight;
      });
    await expect.poll(gap).toBeLessThan(4);
    // Let the scroll events for the last move arrive, so the page remembers where the student was.
    await page.evaluate(() => new Promise((done) => setTimeout(done, 300)));
    // Rows above shrink (a skipped row settles to its real height), which lowers the scroll position without the
    // student touching anything, and the chips grow below before the next frame. That is not scrolling up.
    await page.evaluate(() => {
      const root = document.scrollingElement!;
      const rows = document.querySelectorAll<HTMLElement>(".ask-thread > .px-msg");
      for (const row of Array.from(rows).slice(0, -1)) row.style.display = "none";
      void root.scrollTop;
      const late = document.createElement("div");
      late.style.height = "300px";
      document.querySelector(".ask-page")!.append(late);
      window.dispatchEvent(new Event("scroll"));
    });
    await expect.poll(gap).toBeLessThan(4);
  } finally {
    await finish(app, userData);
  }
});

test("Ask: a student who scrolled up is not pulled back down by new content", async () => {
  test.setTimeout(120000);
  const { app, page, userData } = await launch({ PYXIS_E2E_REPLY: LONG_REPLY });
  try {
    seed(userData);
    await page.setViewportSize({ width: 960, height: 640 });
    await page.evaluate(() => {
      location.hash = "/ask";
    });
    await page.reload();
    const box = page.getByRole("textbox", { name: "Messaggio" });
    for (const text of ["Come si risolve un integrale per parti?", "Una seconda domanda"]) {
      await box.fill(text);
      await box.press("Enter");
      await expect(page.getByRole("button", { name: "Interrompi" })).toHaveCount(0, { timeout: 90000 });
    }
    const gap = () =>
      page.evaluate(() => {
        const root = document.scrollingElement!;
        return root.scrollHeight - root.scrollTop - root.clientHeight;
      });
    // A page shorter than the window is also "at the end": wait for the second reply to be laid out in full first.
    await expect(page.getByText(/^Passo 24:/).last()).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => document.scrollingElement!.scrollHeight - document.scrollingElement!.clientHeight))
      .toBeGreaterThan(3 * 300);
    await expect.poll(gap).toBeLessThan(4);
    const top = () => page.evaluate(() => document.scrollingElement!.scrollTop);
    const end = await top();
    // The chat is several wheel turns tall, so one turn up cannot reach the top and stops early.
    expect(end).toBeGreaterThan(3 * 300);
    await page.mouse.move(480, 200);
    await page.mouse.wheel(0, -300);
    // The wheel scrolls smoothly over several frames. Wait until the page has moved up and stopped there.
    let last = end;
    await expect
      .poll(async () => {
        const now = await top();
        const stopped = now < end && now === last;
        last = now;
        return stopped;
      })
      .toBe(true);
    const scrolled = last;
    const before = await gap();
    // Out of the 96 px near the end where Ask follows the chat again (AskPage.tsx).
    expect(before).toBeGreaterThan(96);
    await page.evaluate(() => {
      const late = document.createElement("div");
      late.style.height = "300px";
      document.querySelector(".ask-page")!.append(late);
    });
    await page.waitForTimeout(500);
    expect(await top()).toBe(scrolled);
    expect(await gap()).toBe(before + 300);
  } finally {
    await finish(app, userData);
  }
});
