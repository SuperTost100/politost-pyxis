import { expect, test, type Page } from "@playwright/test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { launchPyxis, setUp } from "./app-under-test";
import { removeTestFolder } from "./cleanup";
import { fromChiediToExams } from "./doors";
import { PHOTO_NAME, seedFigureChat, seedFollowupsChat, seedOutlineChat, seedSentFilesChat, seedStoppedChat } from "./chat-look-seed";
import { clickSettled } from "./settled";
import { saveShot } from "./shots";

/*
 * The look of Chiedi: the files a message carried and the viewer, a figure's menu and viewer, the outline of a long
 * conversation and the way to go on with a stopped answer. Nothing here calls a model: replies are recorded ones.
 */

async function launch(seed: (db: DatabaseSync, userData: string) => void, extra: Record<string, string> = {}) {
  const userData = mkdtempSync(join(tmpdir(), "pyxis-chat-look-"));
  const app = await launchPyxis({ userData, env: { PYXIS_E2E_REPLY: " e il tavolo preme sul libro con la stessa forza.", ...extra } });
  return setUp(app, userData, async () => {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Salta" }).click();
    await fromChiediToExams(page);
    const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), { timeout: 10000 });
    try {
      seed(db, userData);
    } finally {
      db.close();
    }
    await page.evaluate(() => window.pyxis.setAppearance("light"));
    return { app, page, userData };
  });
}

const open = async (page: Page, chat: string) => {
  await page.evaluate((id) => {
    location.hash = `/ask/${id}`;
  }, chat);
  await page.reload();
};

for (const theme of ["light", "dark"] as const) {
  test(`${theme}: a figure has a menu on its three dots, a right-click and Shift+F10, and a viewer that returns the focus`, async () => {
    test.setTimeout(120000);
    const { app, page, userData } = await launch((db) => seedFigureChat(db, { both: true }), { PYXIS_E2E_SAVE: join(tmpdir(), `pyxis-figure-${theme}.png`) });
    try {
      await page.evaluate((value) => window.pyxis.setAppearance(value), theme);
      await open(page, "look-figure");
      const figure = page.locator("figure.px-figure").first();
      const dots = figure.getByRole("button", { name: "Azioni sulla figura" });
      await expect(figure).toBeVisible();
      // The dots wait for the pointer or the focus.
      await expect(dots).toHaveCSS("opacity", "0");
      await figure.hover();
      await expect(dots).toHaveCSS("opacity", "1");
      await saveShot(page, `chat-look/figure-${theme}-with-control.png`, { animations: "disabled" });
      const items = ["Ingrandisci", "Scarica PNG", "Copia immagine"];
      const menu = () => page.locator(".px-item-menu:not(.ant-dropdown-hidden)");

      // The three dots, a right-click on the figure and Shift+F10 on its picture all open the same three actions.
      await dots.click();
      await expect(menu().getByRole("menuitem")).toHaveText(items);
      // The menu grows from its button: it is shot once it has stopped.
      await page.waitForTimeout(400);
      await saveShot(page, `chat-look/figure-${theme}-menu.png`);
      await page.keyboard.press("Escape");
      await expect(menu()).toHaveCount(0);
      await expect(dots).toBeFocused();
      await figure.getByRole("button", { name: /^Ingrandisci la figura/ }).click({ button: "right" });
      await expect(menu().getByRole("menuitem")).toHaveText(items);
      await page.keyboard.press("Escape");
      await figure.getByRole("button", { name: /^Ingrandisci la figura/ }).focus();
      await page.keyboard.press("Shift+F10");
      await expect(menu().getByRole("menuitem")).toHaveText(items);

      // Ingrandisci opens the viewer, which grows from the figure; Escape closes it and the focus goes back to the figure.
      await clickSettled(page, menu().getByRole("menuitem", { name: "Ingrandisci" }));
      const viewer = page.getByRole("dialog", { name: "Figura ingrandita" });
      await expect(viewer).toBeVisible();
      await expect(viewer.getByRole("button", { name: "Chiudi" })).toBeFocused();
      await expect(viewer.getByRole("status").first()).toHaveText("100%");
      await viewer.getByRole("button", { name: "Aumenta lo zoom" }).click();
      await expect(viewer.getByText("150%")).toBeVisible();
      await viewer.getByRole("button", { name: "Riduci lo zoom" }).click();
      await viewer.getByRole("button", { name: "Riduci lo zoom" }).click();
      await expect(viewer.getByText("75%")).toBeVisible();
      await page.keyboard.press("0");
      await expect(viewer.getByText("100%")).toBeVisible();
      // The caption's formulas are drawn, as in the chat, and the name the figure's button has reads them in words.
      const caption = viewer.locator("figcaption");
      await expect(caption.locator(".katex").first()).toBeVisible();
      const drawn = await caption.evaluate((el) => {
        const copy = el.cloneNode(true) as HTMLElement;
        copy.querySelectorAll(".katex-mathml").forEach((node) => node.remove());
        return copy.textContent ?? "";
      });
      expect(drawn).not.toMatch(/\$|\\/);
      expect(drawn).toContain("cresce di 1,5 m/s ogni secondo");
      await expect(figure.getByRole("button", { name: /^Ingrandisci la figura: La velocità v\(t\)=2\+1,5 t cresce/ })).toBeVisible();
      await saveShot(page, `chat-look/figure-${theme}-viewer.png`, { animations: "disabled" });
      // A right-click or Shift+F10 in the viewer does not open the menu of the figure behind it.
      // On the picture, not on text: on macOS a right-click on text selects the word under the pointer and the app then shows
      // its native Copia menu, which a test cannot close and which keeps the app from quitting (see text-menu.spec.ts).
      await viewer.locator(".px-viewer-card img").click({ button: "right" });
      await viewer.getByRole("button", { name: "Scarica PNG" }).focus();
      await page.keyboard.press("Shift+F10");
      await expect(menu()).toHaveCount(0);
      await expect(viewer).toBeVisible();
      // Tab stays inside the viewer, and the picture's own scroll area is one of its stops.
      const stage = viewer.getByRole("region", { name: "Immagine: scorrila con le frecce" });
      await viewer.getByRole("button", { name: "Chiudi" }).focus();
      await page.keyboard.press("Tab");
      await expect(stage).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(viewer.getByRole("button", { name: "Riduci lo zoom" })).toBeFocused();
      await page.keyboard.press("Shift+Tab");
      await expect(stage).toBeFocused();
      // Zoomed past the window, the arrow keys scroll the picture.
      for (let i = 0; i < 3; i++) await page.keyboard.press("+");
      await expect(viewer.getByText("300%")).toBeVisible();
      expect(await stage.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
      await stage.focus();
      const before = await stage.evaluate((el) => el.scrollLeft);
      await page.keyboard.press("ArrowRight");
      await expect.poll(() => stage.evaluate((el) => el.scrollLeft)).toBeGreaterThan(before);
      // A zoom button that reaches its limit keeps the focus, so Escape still closes the viewer.
      const zoomIn = viewer.getByRole("button", { name: "Aumenta lo zoom" });
      await zoomIn.focus();
      await page.keyboard.press("Enter");
      await expect(zoomIn).toHaveAttribute("aria-disabled", "true");
      await expect(zoomIn).toBeFocused();
      await page.keyboard.press("0");
      await expect(viewer.getByText("100%")).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(viewer).toHaveCount(0);
      await expect(figure.getByRole("button", { name: /^Ingrandisci la figura/ })).toBeFocused();

      // Download keeps a PNG, and Copy says it was copied.
      await figure.hover();
      await dots.click();
      await clickSettled(page, menu().getByRole("menuitem", { name: "Scarica PNG" }));
      await expect(figure.getByText("Salvata")).toBeVisible();
      const saved = join(tmpdir(), `pyxis-figure-${theme}.png`);
      expect(existsSync(saved)).toBe(true);
      expect(readFileSync(saved).subarray(1, 4).toString()).toBe("PNG");

      // A figure stored before there was a dark one stays on its white card in both themes.
      const old = page.locator("figure.px-figure").nth(1);
      await old.scrollIntoViewIfNeeded();
      await expect(old.locator("button.px-figure-open")).toHaveCSS("background-color", "rgb(255, 255, 255)");
      await expect(old.locator("img.px-figure-dark")).toHaveCount(0);
      // The new one is drawn for the theme: its card is the dark ground in dark and white in light.
      await expect(figure.locator("button.px-figure-open")).toHaveCSS(
        "background-color",
        theme === "dark" ? "rgb(23, 27, 34)" : "rgb(255, 255, 255)",
      );
      await expect(figure.locator(theme === "dark" ? "img.px-figure-dark" : "img.px-figure-light")).toBeVisible();
      await expect(figure.locator(theme === "dark" ? "img.px-figure-light" : "img.px-figure-dark")).toBeHidden();
    } finally {
      await app.close();
      removeTestFolder(userData);
    }
  });
}

test("the outline has a mark per question from the third on, a card on hover and focus, one Tab stop, and a jump that loads older messages", async () => {
  test.setTimeout(120000);
  const { app, page, userData } = await launch((db) => {
    seedOutlineChat(db);
    seedOutlineChat(db, "look-two", 2);
  });
  try {
    await open(page, "look-two");
    await expect(page.locator(".px-msg-user")).toHaveCount(2);
    await expect(page.getByRole("navigation", { name: "Indice della conversazione" })).toHaveCount(0);

    await open(page, "look-outline");
    const outline = page.getByRole("navigation", { name: "Indice della conversazione" });
    const marks = outline.getByRole("button");
    await expect(marks).toHaveCount(9);
    // A long chat opens on its latest messages: the first question is not on the page until it is asked for.
    await expect(page.getByText("Quanto vale la forza normale?")).toHaveCount(0);
    await expect(marks.last()).toHaveAttribute("aria-current", "true");

    // The outline sits along the left edge of the chat pane beside the sidebar, clear of message text.
    const checkLeftPlacement = async () => {
      const current = outline.locator('button[aria-current="true"] i');
      const other = outline.locator('button:not([aria-current="true"]) i').first();
      await expect.poll(async () => (await current.boundingBox())!.width).toBeCloseTo(22, 0);
      const box = await outline.boundingBox();
      const pane = await page.locator(".ask-page").boundingBox();
      const side = await page.locator("aside.px-side").boundingBox();
      const msg = await page.locator(".px-msg-text").last().boundingBox();
      const shortBar = await other.boundingBox();
      const currentBar = await current.boundingBox();
      expect(box!.x).toBeCloseTo(pane!.x + 6, 0);
      expect(box!.x).toBeGreaterThanOrEqual(side!.x + side!.width);
      expect(box!.x + box!.width).toBeLessThanOrEqual(msg!.x);
      // Marks align to the left edge and the current mark grows to the right.
      expect(currentBar!.x).toBeCloseTo(shortBar!.x, 0);
      expect(currentBar!.x).toBeCloseTo(pane!.x + 10, 0);
      expect(currentBar!.width).toBeGreaterThan(shortBar!.width);
    };
    await page.setViewportSize({ width: 1280, height: 800 });
    await checkLeftPlacement();

    // The pointer on a mark shows its question and the start of its answer, opening to the right of the marks.
    await marks.nth(3).hover();
    const card = outline.locator(".ask-outline-card");
    await expect(card).toContainText("Domanda 4 di 9");
    await expect(card).toContainText("Come trovo l'angolo a cui il blocco inizia a scivolare?");
    await expect(card).toContainText("Risposta 4.");
    const outlineBox = await outline.boundingBox();
    const cardBox = await card.boundingBox();
    expect(cardBox!.x).toBeGreaterThanOrEqual(outlineBox!.x + outlineBox!.width);
    expect(await card.evaluate((el) => getComputedStyle(el).transformOrigin)).toMatch(/^0px /);
    // The formulas in the card are drawn, never shown as their source.
    await expect(card.locator(".katex").first()).toBeVisible();
    const seen = await card.evaluate((el) => {
      const copy = el.cloneNode(true) as HTMLElement;
      copy.querySelectorAll(".katex-mathml").forEach((node) => node.remove());
      return copy.textContent ?? "";
    });
    expect(seen).not.toMatch(/\\[a-z]|\$/);
    // The question stays on one line with an ellipsis, whatever its length and its formulas.
    const question = card.locator("b");
    expect((await question.boundingBox())!.height).toBeLessThan(24);
    expect(await question.evaluate((el) => getComputedStyle(el).textOverflow)).toBe("ellipsis");
    // And a mark is named in words for a screen reader.
    await expect(marks.nth(3)).toHaveAccessibleName("Domanda 4 di 9: Come trovo l'angolo a cui il blocco inizia a scivolare?");
    await saveShot(page, "chat-look/outline-card.png", { animations: "disabled" });
    await page.mouse.move(10, 10);
    await expect(card).toHaveCount(0);

    // One Tab stop: from the composer's side the marks take one Tab, and the arrows move inside them.
    await marks.last().focus();
    await expect(card).toContainText("Domanda 9 di 9");
    await page.keyboard.press("ArrowUp");
    await expect(marks.nth(7)).toBeFocused();
    await expect(card).toContainText("Domanda 8 di 9");
    await page.keyboard.press("Home");
    await expect(marks.first()).toBeFocused();
    await expect(marks.first()).toHaveAttribute("tabindex", "0");
    await expect(marks.last()).toHaveAttribute("tabindex", "-1");

    // Enter on the first mark loads the messages it needs and scrolls to its question.
    await page.keyboard.press("Enter");
    const first = page.locator(".px-msg-user", { hasText: "Quanto vale la forza normale?" });
    await expect(first).toBeVisible();
    await expect(first).toBeInViewport();
    await expect(marks.first()).toHaveAttribute("aria-current", "true");
    await saveShot(page, "chat-look/outline-after-jump.png", { animations: "disabled" });
    // A click on a mark of a question that is already on the page goes there too.
    await marks.nth(6).click();
    await expect(page.locator(".px-msg-user", { hasText: "Mi fai un esempio con i numeri?" })).toBeInViewport();
    await expect(marks.nth(6)).toHaveAttribute("aria-current", "true");

    // Folding the sidebar moves the outline to the left edge of the content; unfolding moves it back.
    await page.getByRole("button", { name: "Riduci la barra" }).click();
    await expect.poll(async () => (await outline.boundingBox())!.x).toBeLessThan(120);
    await checkLeftPlacement();
    await page.getByRole("button", { name: "Espandi la barra" }).click();
    await expect.poll(async () => (await outline.boundingBox())!.x).toBeGreaterThan(250);
    await checkLeftPlacement();

    // At 960 px wide the sidebar folds and the outline stays at the left edge without covering text.
    await page.setViewportSize({ width: 960, height: 800 });
    await expect.poll(async () => (await outline.boundingBox())!.x).toBeLessThan(120);
    await checkLeftPlacement();
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});

test("a stopped answer keeps its quiet tag under the text, and Continua sits left of Invia and writes on from there", async () => {
  test.setTimeout(120000);
  const { app, page, userData } = await launch((db) => seedStoppedChat(db), { PYXIS_E2E_REPLY_DELAY: "3000" });
  try {
    await open(page, "look-stopped");
    const reply = page.locator(".px-msg:not(.px-msg-user)").last();
    const tag = reply.getByText("Interrotta");
    await expect(tag).toBeVisible();
    // The tag is under the text, and Continua is not beside it.
    const text = await reply.locator(".px-msg-text").boundingBox();
    const tagBox = await tag.boundingBox();
    expect(tagBox!.y).toBeGreaterThan(text!.y + text!.height - 4);
    await expect(reply.getByRole("button", { name: "Continua" })).toHaveCount(0);
    // It is in the composer, immediately left of Invia, and not the primary.
    const continua = page.locator(".px-composer-bar").getByRole("button", { name: "Continua" });
    const send = page.locator(".px-composer-bar").getByRole("button", { name: "Invia", exact: true });
    await expect(continua).toBeVisible();
    const [c, s] = [await continua.boundingBox(), await send.boundingBox()];
    expect(c!.x + c!.width).toBeLessThanOrEqual(s!.x);
    expect(s!.x - (c!.x + c!.width)).toBeLessThan(16);
    await expect(continua).toHaveClass(/px-btn-secondary/);
    await expect(send).toHaveClass(/px-btn-primary/);
    await saveShot(page, "chat-look/stopped.png", { animations: "disabled" });

    await continua.click();
    // The button gives way to the working state with Stop, and the same sentence goes on.
    await expect(page.getByRole("button", { name: "Interrompi", exact: true })).toBeVisible();
    await expect(page.getByText("il tavolo preme sul libro con la stessa forza.")).toBeVisible({ timeout: 30000 });
    await expect(page.getByText("Interrotta")).toHaveCount(0);
    // A finished answer has no Continua.
    await expect(page.getByRole("button", { name: "Continua" })).toHaveCount(0);
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});

test("a sent message shows a photo as a thumbnail that opens the viewer and a document as a chip; an old photo is a chip", async () => {
  test.setTimeout(120000);
  const { app, page, userData } = await launch((db, dir) => seedSentFilesChat(db, dir), {
    PYXIS_E2E_SAVE: join(tmpdir(), "pyxis-photo-look.png"),
  });
  try {
    await open(page, "look-files");
    const files = page.locator(".ask-sent-files");
    const thumb = files.getByRole("button", { name: `Ingrandisci ${PHOTO_NAME}` });
    await expect(thumb).toBeVisible();
    await expect(thumb.locator("img")).toHaveJSProperty("complete", true);
    expect(await thumb.locator("img").evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(312);
    // The document is a chip with its size, and the photo sent before pictures were kept falls back to a chip too.
    await expect(files.getByRole("button", { name: /esercizi-scansione\.pdf/ })).toContainText("1 MB");
    await expect(files.locator(".ask-sent-doc.is-plain")).toHaveCount(1);
    await expect(files.locator(".ask-sent-thumb")).toHaveCount(1);
    // The files sit above the text, which has its own bubble.
    const filesBox = await files.boundingBox();
    const bubble = await page.locator(".px-msg-bubble").first().boundingBox();
    expect(filesBox!.y + filesBox!.height).toBeLessThanOrEqual(bubble!.y);
    await saveShot(page, "chat-look/sent-files.png", { animations: "disabled" });

    // The window of a laptop: 800 px high.
    await page.setViewportSize({ width: 1280, height: 800 });
    await thumb.click();
    const viewer = page.getByRole("dialog", { name: "Foto ingrandita" });
    await expect(viewer).toBeVisible();
    await expect(viewer.getByText(`${PHOTO_NAME}, dal tuo messaggio`, { exact: true })).toBeVisible();
    // A photo's caption and its picture's alt text are its file name as written: no link, no formula, no stripped marks.
    await expect(viewer.locator("figcaption .katex")).toHaveCount(0);
    await expect(viewer.locator("figcaption a")).toHaveCount(0);
    await expect(viewer.locator(".px-viewer-card img")).toHaveAttribute("alt", `${PHOTO_NAME}, dal tuo messaggio`);
    // A portrait photo in a window 800 px high: the whole card and its caption are on screen, none cut at the foot.
    await expect.poll(() => page.evaluate(() => window.innerHeight)).toBeGreaterThan(0);
    const height = await page.evaluate(() => window.innerHeight);
    const captionBox = await viewer.getByText(`${PHOTO_NAME}, dal tuo messaggio`, { exact: true }).boundingBox();
    const cardBox = await viewer.locator(".px-viewer-card").boundingBox();
    expect(cardBox!.y).toBeGreaterThanOrEqual(0);
    expect(captionBox!.y + captionBox!.height).toBeLessThanOrEqual(height);
    expect(cardBox!.height / cardBox!.width).toBeCloseTo(400 / 312, 1);
    await saveShot(page, "chat-look/photo-viewer.png", { animations: "disabled" });
    await page.keyboard.press("Escape");
    await expect(viewer).toHaveCount(0);
    await expect(thumb).toBeFocused();
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});

for (const theme of ["light", "dark"] as const) {
  test(`${theme}: the suggestions under an answer are quiet chips in a row, close under the footer`, async () => {
    test.setTimeout(120000);
    const { app, page, userData } = await launch((db) => seedFollowupsChat(db));
    try {
      await page.evaluate((value) => window.pyxis.setAppearance(value), theme);
      await open(page, "look-followups");
      const chips = page.locator(".px-msg-chips .px-chip");
      await expect(chips).toHaveText(["Mostrami la soluzione completa", "Dammi un indizio", /^Perché non è/]);
      const boxes = await chips.evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().toJSON() as DOMRect));
      // One row, left to right, 6 px apart, the first at the answer's left edge.
      expect(new Set(boxes.map((box) => Math.round(box.y))).size).toBe(1);
      expect(boxes[1]!.x - (boxes[0]!.x + boxes[0]!.width)).toBeCloseTo(6, 0);
      const text = await page.locator(".px-msg-text").first().boundingBox();
      expect(Math.abs(boxes[0]!.x - text!.x)).toBeLessThan(2);
      // Close under the footer: no gap left where the mode switch used to be.
      const foot = await page.locator(".px-msg-foot").first().boundingBox();
      expect(boxes[0]!.y - (foot!.y + foot!.height)).toBeLessThanOrEqual(16);
      // No outline: a fill.
      await expect(chips.first()).toHaveCSS("border-top-width", "0px");
      await saveShot(page, `chat-look/followups-${theme}.png`, { animations: "disabled" });
      await chips.first().focus();
      await expect(chips.first()).toHaveCSS("outline-style", "solid");
    } finally {
      await app.close();
      removeTestFolder(userData);
    }
  });
}

test("a jump's mark does not follow the student to another chat, and the next chat marks its own part in view", async () => {
  test.setTimeout(120000);
  const { app, page, userData } = await launch((db) => {
    seedOutlineChat(db, "look-short-a", 3, { short: true });
    seedOutlineChat(db, "look-short-b", 3, { short: true });
  });
  try {
    await open(page, "look-short-a");
    const marks = page.getByRole("navigation", { name: "Indice della conversazione" }).getByRole("button");
    await expect(marks).toHaveCount(3);
    // Both chats fit the window, so both are at scroll 0 and nothing but the chat tells them apart.
    // Messages out of view hold an estimated height until the page has laid them out, so the page is given a moment to settle;
    // on macOS the first look comes before it has. What it must not do, once settled, is scroll.
    await expect
      .poll(() => page.evaluate(() => document.scrollingElement!.scrollHeight - window.innerHeight), {
        message: "the page overflows the window by this many pixels",
        timeout: 10000,
      })
      .toBeLessThanOrEqual(1);
    await marks.first().click();
    await expect(marks.first()).toHaveAttribute("aria-current", "true");
    // Chat B opens with no reload, as from the sidebar. It ends where it opened, so its last question is the one in view.
    await page.evaluate(() => {
      location.hash = "/ask/look-short-b";
    });
    await expect(page.locator(".px-msg-user").first()).toBeVisible();
    await expect(marks.last()).toHaveAttribute("aria-current", "true");
    await expect(marks.first()).not.toHaveAttribute("aria-current", "true");
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});

test("with a hundred questions the outline stays inside the window, every mark is reachable, and it follows the part in view", async () => {
  test.setTimeout(120000);
  const { app, page, userData } = await launch((db) => seedOutlineChat(db, "look-long", 100));
  try {
    await open(page, "look-long");
    const nav = page.getByRole("navigation", { name: "Indice della conversazione" });
    const marks = nav.getByRole("button");
    await expect(marks).toHaveCount(100);
    const height = await page.evaluate(() => window.innerHeight);
    const box = await nav.boundingBox();
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.y + box!.height).toBeLessThanOrEqual(height);
    const list = nav.locator("ul");
    expect(await list.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
    // Every mark keeps a spacing of at least 8 px, and the last one, in view, is inside the window with the list scrolled to it.
    const inside = async (index: number) => {
      const mark = await marks.nth(index).boundingBox();
      const frame = await list.boundingBox();
      return mark!.y >= frame!.y - 1 && mark!.y + mark!.height <= frame!.y + frame!.height + 1 && mark!.y >= 0 && mark!.y + mark!.height <= height;
    };
    expect((await marks.nth(1).boundingBox())!.y - (await marks.nth(0).boundingBox())!.y).toBeGreaterThanOrEqual(8);
    await expect(marks.last()).toHaveAttribute("aria-current", "true");
    await expect.poll(() => inside(99)).toBe(true);
    // The keys reach the first mark, the list scrolls to it, and Enter loads that question.
    await marks.last().focus();
    await page.keyboard.press("Home");
    await expect(marks.first()).toBeFocused();
    await expect.poll(() => inside(0)).toBe(true);
    await page.keyboard.press("Enter");
    await expect(page.locator(".px-msg-user", { hasText: "Quanto vale la forza normale?" }).first()).toBeInViewport();
    await expect(marks.first()).toHaveAttribute("aria-current", "true");
    await expect.poll(() => inside(0)).toBe(true);
    await saveShot(page, "chat-look/outline-long.png", { animations: "disabled" });
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});
