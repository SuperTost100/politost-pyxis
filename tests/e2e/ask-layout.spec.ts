import {
  expect,
  test,
  type ElectronApplication,
} from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { launchPyxis } from "./app-under-test";
import { seedPlan, seedSource, seedSubjects } from "./seed";
import { animationsSettled, atRest } from "./settled";
import { removeTestFolder } from "./cleanup";
import { fromChiediToExams } from "./doors";
import { answerNextMenu, lastMenuLabels } from "./native-menu";

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
  // The recent chats show beside the page from 1100px; Windows runners scale the default window below that.
  await page.setViewportSize({ width: 1280, height: 832 });
  await page.getByRole("button", { name: "Salta" }).click();
  await fromChiediToExams(page);
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

async function finish(app: ElectronApplication, userData: string) {
  await app.close();
  removeTestFolder(userData);
}

test("Ask: recent chats, automatic titles, rename and delete, greeting and the thinking placeholder", async () => {
  test.setTimeout(120000);
  const { app, page, userData } = await launch({ PYXIS_E2E_REPLY_DELAY: "3000" });
  try {
    await page.evaluate(() => window.pyxis.invoke("profile.save", { displayName: "Tommaso" }));
    await page.evaluate(() => {
      location.hash = "/ask";
    });
    await page.reload();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(/^(Buongiorno|Buon pomeriggio|Buonasera), Tommaso$/);
    await expect(page.getByRole("link", { name: "Nuova chat" })).toBeVisible();

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
    const list = page.getByRole("list", { name: "Chat" });
    const title = (await list.getByRole("link", { name: /^Mi spieghi/ }).textContent()) ?? "";
    expect(title.length).toBeLessThanOrEqual(61);
    expect(title.endsWith("…")).toBe(true);
    await expect(list.getByRole("textbox")).toHaveCount(0);

    // Rename on demand: Esc cancels, Enter saves.
    // The row's actions are the system's own context menu, from a right-click or the "…" button.
    await answerNextMenu(app, "Rinomina");
    await list.getByRole("link", { name: /^Mi spieghi/ }).click({ button: "right" });
    await expect
      .poll(() => lastMenuLabels(app))
      .toEqual(["Rinomina", "Esporta come Markdown", "Esporta come PDF", "-", "Elimina"]);
    const field = page.getByRole("textbox", { name: "Nome della chat" });
    await field.fill("Scartato");
    await field.press("Escape");
    await expect(list.getByRole("link", { name: /^Mi spieghi/ })).toBeVisible();
    await answerNextMenu(app, "Rinomina");
    await list.getByRole("button", { name: /^Azioni per Mi spieghi/ }).click();
    await page.getByRole("textbox", { name: "Nome della chat" }).fill("Teorema fondamentale");
    await page.getByRole("textbox", { name: "Nome della chat" }).press("Enter");
    await expect(list.getByRole("link", { name: "Teorema fondamentale", exact: true })).toBeVisible();

    // Delete asks first.
    await answerNextMenu(app, "Elimina");
    await list.getByRole("button", { name: "Azioni per Teorema fondamentale" }).click();
    const dialog = page.getByRole("dialog", { name: "Eliminare questa chat?" });
    await dialog.getByRole("button", { name: "Annulla" }).click();
    await expect(list.getByRole("link", { name: "Teorema fondamentale", exact: true })).toBeVisible();
    // The cancelled dialog is still closing; wait so the next click lands on the row.
    await expect(dialog).toHaveCount(0);
    await animationsSettled(page);
    // A menu closed without a pick does nothing.
    await answerNextMenu(app, null);
    await list.getByRole("button", { name: "Azioni per Teorema fondamentale" }).click();
    await expect(dialog).toHaveCount(0);
    await answerNextMenu(app, "Elimina");
    await list.getByRole("button", { name: "Azioni per Teorema fondamentale" }).click();
    await page.getByRole("button", { name: "Elimina per sempre" }).click();
    await expect(page.getByText("Le tue chat compaiono qui.")).toBeVisible();
    await expect(page).toHaveURL(/#\/ask$/);
  } finally {
    await finish(app, userData);
  }
});

test("Ask: All chats shows in the sidebar only when there are more chats than it lists", async () => {
  test.setTimeout(180000);
  const { app, page, userData } = await launch();
  try {
    const list = page.getByRole("list", { name: "Chat" });
    const allChats = page.getByRole("button", { name: "Tutte le chat" });
    await page.evaluate(() => {
      location.hash = "/ask";
    });
    await page.reload();

    // No chats: the empty note shows and nothing leads to a list.
    await expect(page.getByText("Le tue chat compaiono qui.")).toBeVisible();
    await expect(allChats).toHaveCount(0);

    // Two chats, both listed: no link.
    const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), { timeout: 10000 });
    const insert = db.prepare("INSERT INTO chats(id,title,created_at,updated_at) VALUES(?,?,?,?)");
    const seedChats = (from: number, to: number) => {
      for (let i = from; i <= to; i += 1) {
        const n = String(i).padStart(2, "0");
        insert.run(`c${n}`, `Argomento ${n}`, 100 + i, 100 + i);
      }
    };
    seedChats(1, 2);
    await page.reload();
    await expect(list.getByRole("listitem")).toHaveCount(2);
    await expect(allChats).toHaveCount(0);

    // Exactly as many chats as the sidebar lists: still no link.
    seedChats(3, 20);
    await page.reload();
    await expect(list.getByRole("listitem")).toHaveCount(20);
    await expect(allChats).toHaveCount(0);

    // A new chat takes the list over its limit, and the link appears without a reload.
    const box = page.getByRole("textbox", { name: "Messaggio" });
    await box.fill("Che cos'è l'integrazione per parti?");
    await box.press("Enter");
    await expect(page.getByText("Fammi un altro esempio")).toBeVisible({ timeout: 30000 });
    await expect(list.getByRole("listitem")).toHaveCount(20);
    await expect(list.getByRole("link", { name: "Argomento 01" })).toHaveCount(0);
    await expect(allChats).toBeVisible();

    // Folded, the sidebar shows no chats and no link; unfolded, the link is back.
    await page.getByRole("button", { name: "Riduci la barra" }).click();
    await expect(allChats).toBeHidden();
    await page.getByRole("button", { name: "Espandi la barra" }).click();
    await expect(allChats).toBeVisible();

    // The link opens every chat, including the one the sidebar does not list.
    await allChats.click();
    const finder = page.getByRole("dialog", { name: "Cerca" });
    await expect(finder.getByRole("option")).toHaveCount(21);
    await expect(finder.getByRole("option", { name: /^Argomento 01/ })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(finder).toBeHidden();

    // Deleting a chat leaves exactly as many as the sidebar lists, and the link goes without a reload.
    await answerNextMenu(app, "Elimina");
    await list.getByRole("button", { name: "Azioni per Argomento 20" }).click();
    await page.getByRole("button", { name: "Elimina per sempre" }).click();
    await expect(list.getByRole("link", { name: "Argomento 01" })).toBeVisible();
    await expect(list.getByRole("listitem")).toHaveCount(20);
    await expect(allChats).toHaveCount(0);

    // With 20 chats the search still reaches them all, and each row's three dots offer the same menu as in the search.
    await page.keyboard.press(process.platform === "darwin" ? "Meta+K" : "Control+K");
    await expect(finder.getByRole("group", { name: "Chat" }).getByRole("option", { name: "Tutte le chat" })).toBeVisible();
    await page.keyboard.press("Escape");
    await answerNextMenu(app, null);
    await list.getByRole("button", { name: "Azioni per Argomento 01" }).click();
    expect(await lastMenuLabels(app)).toEqual(["Rinomina", "Esporta come Markdown", "Esporta come PDF", "-", "Elimina"]);

    // In English the link is named the same way and follows the same rule.
    seedChats(21, 21);
    db.close();
    await page.evaluate(() => localStorage.setItem("pyxis.lang", "en"));
    await page.reload();
    await expect(page.getByRole("button", { name: "All chats" })).toBeVisible();
    await expect(list.getByRole("listitem")).toHaveCount(20);
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
    const foot = async () =>
      page.evaluate(() => {
        const composer = document.querySelector(".px-composer")!.getBoundingClientRect();
        return window.innerHeight - composer.bottom;
      });
    // Home, the empty chat, has the composer in the middle under the greeting, well clear of the foot of the window.
    // On macOS the layout can settle after the first paint, so wait for it.
    await expect.poll(foot).toBeGreaterThan(120);

    await box.fill("Come si risolve un integrale per parti?");
    await box.press("Enter");
    await expect(page.getByRole("button", { name: "Fammi un altro esempio" })).toBeVisible();
    // Once the chat has a message, the composer docks to the foot of the window.
    await expect.poll(foot).toBeLessThan(40);
    for (const text of ["Una seconda domanda", "Una terza domanda"]) {
      await box.fill(text);
      await box.press("Enter");
      await expect(page.getByText(text, { exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Interrompi" })).toHaveCount(0, { timeout: 90000 });
    }
    // With nothing in the Library about the question, the reply is still given, and says it comes from general knowledge.
    const general = "Non ho trovato niente su questa domanda nella tua Libreria, quindi ti rispondo con quello che so in generale.";
    const before = await page.getByText(general).count();
    await box.fill("Una domanda fuori materia");
    await box.press("Enter");
    // Slow hosted runners can take well over 30 s for a recorded reply.
    await expect(page.getByText(general)).toHaveCount(before + 1, { timeout: 90000 });
    await expect(page.getByText("Il materiale non copre questa domanda.")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Interrompi" })).toHaveCount(0, { timeout: 90000 });

    // The saved reply replaces the streamed one off screen, so it is skipped (content-visibility) at its 240px placeholder
    // until the window draws its next frame, which lays it out and scrolls to it. A Mac runner draws few frames and can
    // measure in between, before what the student sees exists; wait for the last message to settle first. Only a saved
    // reply has a foot, so the wait is on the saved one and not on the streamed one it replaces.
    const saved = page.locator(".ask-thread > .px-msg").last();
    await expect(saved.locator(".px-msg-foot")).toBeAttached();
    await atRest(saved);
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
    await page.getByRole("link", { name: "Nuova chat" }).click();
    // Home first, so reopening the chat is a change of chat.
    await expect(page).toHaveURL(/#\/ask$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(/^(Buongiorno|Buon pomeriggio|Buonasera)/);
    // At 960px the sidebar is folded, so the chat opens from the search, the newest first.
    await page.keyboard.press(process.platform === "darwin" ? "Meta+K" : "Control+K");
    const finder = page.getByRole("dialog", { name: "Cerca" });
    await expect(finder.getByRole("option").first()).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(finder).toBeHidden();
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
    // Content that arrives after the reply (its chips, the math checks) still grows the page on a slow runner. The wheel
    // scrolls in small steps, and a growth while the page is still within 96 px of the end pins it back down, as it
    // should for a student who has not scrolled up yet. So wait until the height holds before turning the wheel.
    let height = -1;
    await expect
      .poll(
        async () => {
          const now = await page.evaluate(() => document.scrollingElement!.scrollHeight);
          const held = now === height;
          height = now;
          return held;
        },
        { intervals: [500] },
      )
      .toBe(true);
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
    // The page must not follow the new content. Nothing signals that it chose not to, so this waits a fixed time.
    await page.waitForTimeout(500);
    expect(await top()).toBe(scrolled);
    expect(await gap()).toBe(before + 300);
  } finally {
    await finish(app, userData);
  }
});
