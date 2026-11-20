import { expect, test, type Page } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchPyxis } from "./app-under-test";
import { expectNoAxeViolations } from "./axe";
import { removeTestFolder } from "./cleanup";
import { saveShot } from "./shots";
import { jobsNow, makeCards, RECORDED_CARDS, seedChimica, standInTools, useTools } from "./tools";
import { clickSettled } from "./settled";

/** The names of the connected tools, top to bottom. */
const listed = (page: Page) => page.locator(".engines-tools .engines-tool-name");
const order = (page: Page) =>
  page.evaluate(async () => ((await window.pyxis.invoke("engines.choice", {})) as { order: string[] | null }).order);

async function openTools(page: Page, language: "it" | "en" = "it") {
  await page.evaluate((lang) => {
    localStorage.setItem("pyxis.lang", lang);
    location.hash = "/settings/engines";
  }, language);
  await page.reload();
  await expect(page.locator(".engines-tools .engines-tool").first()).toBeVisible({ timeout: 30_000 });
}

test("Strumenti AI: the connected tools are put in order with the mouse, the keyboard and the row's menu", async () => {
  // The stand-in tools are POSIX shell scripts. Windows runs the order's rules in the unit tests.
  test.skip(process.platform === "win32", "stand-in tools are shell scripts");
  test.setTimeout(180_000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-tools-order-"));
  const tools = standInTools(["claude", "codex", "antigravity"]);
  const app = await launchPyxis({ userData, env: tools.env });
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Salta" }).click();
    await expect(page).toHaveURL(/#\/ask$/);
    await useTools(page, ["claude", "codex", "antigravity"]);
    await openTools(page);

    // Never put in order: the tools are listed as Pyxis found them, without a place, and the page says the work is shared.
    await expect(listed(page)).toHaveText(["Claude", "ChatGPT", "Gemini"]);
    await expect(page.locator(".engines-tool-n")).toHaveCount(0);
    await expect(page.locator(".engines-summary")).toContainText("Pyxis sceglie da solo lo strumento adatto a ogni lavoro");
    await expect(page.getByRole("button", { name: "Lascia decidere a Pyxis" })).toHaveCount(0);
    expect(await order(page)).toBeNull();
    // Every tool is connected, so nothing waits under "Da collegare".
    await expect(page.getByRole("region", { name: "Da collegare" })).toHaveCount(0);
    await saveShot(page, "tools/order-shared-it.png", { fullPage: true });

    // ---- The mouse: Gemini's grip is dragged above Claude.
    const grip = (name: string) => page.getByRole("button", { name: `Riordina ${name}` });
    const from = (await grip("Gemini").boundingBox())!;
    const to = (await page.locator('.engines-tool[data-tool="claude"]').boundingBox())!;
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(from.x + from.width / 2, from.y - 20, { steps: 5 });
    await page.mouse.move(from.x + from.width / 2, to.y + 4, { steps: 10 });
    await page.mouse.up();
    await expect(listed(page)).toHaveText(["Gemini", "Claude", "ChatGPT"]);
    // Each tool now has its place, and the page says the first one does the work.
    await expect(page.locator(".engines-tool-n")).toHaveText(["1", "2", "3"]);
    await expect(page.locator(".engines-summary")).toHaveText(
      "Pyxis usa il primo della lista. Se finisce le richieste del giorno, passa al successivo.",
    );
    await expect.poll(() => order(page)).toEqual(["antigravity", "claude", "codex"]);
    // The tasks follow: lessons go to the first tool, and photos to the next one, since Gemini reads no pictures.
    await expect
      .poll(async () => {
        const features = (await page.evaluate(() => window.pyxis.invoke("engines.features", {}))) as Record<
          string,
          { provider: string }
        >;
        return [features.lesson?.provider, features.chat?.provider, features.vision?.provider];
      })
      .toEqual(["antigravity", "antigravity", "claude"]);
    await saveShot(page, "tools/order-listed-it.png", { fullPage: true });

    // ---- The keyboard: Space picks ChatGPT up, the arrows move it to the top, Space drops it. Each step is said.
    const live = page.locator('[id^="DndLiveRegion"]');
    // The list starts listening for the arrows one timer after the pick-up, so the test lets that timer run first.
    const pickUp = async () => {
      await page.keyboard.press("Space");
      await page.evaluate(() => new Promise((done) => setTimeout(done, 0)));
    };
    await grip("ChatGPT").focus();
    await pickUp();
    await expect(live).toHaveText("ChatGPT preso, posizione 3 di 3.");
    await page.keyboard.press("ArrowUp");
    await expect(live).toHaveText("ChatGPT, posizione 2 di 3.");
    await page.keyboard.press("ArrowUp");
    await expect(live).toHaveText("ChatGPT, posizione 1 di 3.");
    await page.keyboard.press("Space");
    await expect(live).toHaveText("ChatGPT è in posizione 1 di 3.");
    await expect(listed(page)).toHaveText(["ChatGPT", "Gemini", "Claude"]);
    await expect.poll(() => order(page)).toEqual(["codex", "antigravity", "claude"]);
    // The grip keeps the focus, so the next move starts from where the hands are.
    await expect(grip("ChatGPT")).toBeFocused();

    // Escape puts a tool that was picked up back where it was.
    await pickUp();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Escape");
    await expect(live).toHaveText("Riordino annullato, ChatGPT torna dov'era.");
    await expect(listed(page)).toHaveText(["ChatGPT", "Gemini", "Claude"]);
    expect(await order(page)).toEqual(["codex", "antigravity", "claude"]);

    // ---- The row's menu, on a right-click as on its dots, moves a tool one place and says where it is now.
    // A menu that closes stays on the page while it shrinks away, so each one is found by the tool it belongs to.
    const menu = (name: string) => page.getByRole("region", { name: `Azioni su ${name}` });
    await page.locator('.engines-tool[data-tool="claude"] .px-ctl-title').click({ button: "right" });
    await clickSettled(page, menu("Claude").getByRole("menuitem", { name: "Sposta su" }));
    await expect(listed(page)).toHaveText(["ChatGPT", "Claude", "Gemini"]);
    await expect(page.locator(".engines-panel p[role=status].visually-hidden")).toHaveText(
      "Claude è in posizione 2 di 3.",
    );
    await expect.poll(() => order(page)).toEqual(["codex", "claude", "antigravity"]);
    // The first tool cannot go further up, nor the last one further down.
    await page.getByRole("button", { name: "Azioni su ChatGPT" }).click();
    await expect(menu("ChatGPT").getByRole("menuitem", { name: "Sposta su" })).toBeDisabled();
    await expect(menu("ChatGPT").getByRole("menuitem", { name: "Sposta giù" })).toBeEnabled();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Azioni su Gemini" }).click();
    await expect(menu("Gemini").getByRole("menuitem", { name: "Sposta giù" })).toBeDisabled();
    await page.keyboard.press("Escape");
    await expectNoAxeViolations(page, { tags: ["wcag2a", "wcag2aa", "wcag21aa"] });

    // The order is kept: the page read again shows it.
    await page.reload();
    await expect(listed(page)).toHaveText(["ChatGPT", "Claude", "Gemini"], { timeout: 30_000 });
    await expect(page.locator(".engines-tool-n")).toHaveText(["1", "2", "3"]);

    // ---- Handing the order back: Pyxis shares the work among the tools again.
    await page.getByRole("button", { name: "Lascia decidere a Pyxis" }).click();
    await expect(page.locator(".engines-tool-n")).toHaveCount(0);
    await expect(page.locator(".engines-summary")).toContainText("Pyxis sceglie da solo lo strumento adatto a ogni lavoro");
    await expect.poll(() => order(page)).toBeNull();
  } finally {
    await app.close();
    removeTestFolder(userData);
    rmSync(tools.bin, { recursive: true, force: true });
  }
});

test("Strumenti AI: work goes on with the next tool when the first is out of requests, and a restart remembers it", async () => {
  test.skip(process.platform === "win32", "stand-in tools are shell scripts");
  test.setTimeout(240_000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-tools-limit-"));
  const tools = standInTools(["claude", "codex"]);
  // ChatGPT is out of requests until six tomorrow morning, as its program would report; Claude answers.
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(6, 0, 0, 0);
  const env = {
    ...tools.env,
    PYXIS_E2E_PLAN_REPLIES: JSON.stringify({
      limited: { codex: { resetAt: tomorrow.toISOString() } },
      cards: { cards: RECORDED_CARDS },
    }),
  };
  const jobOf = async (page: Page, id: string) => (await jobsNow(page)).find((job) => job.id === id);
  let app = await launchPyxis({ userData, env });
  try {
    let page = await app.firstWindow();
    await page.getByRole("button", { name: "Salta" }).click();
    await expect(page).toHaveURL(/#\/ask$/);
    await useTools(page, ["claude", "codex"]);
    seedChimica(userData);
    // ChatGPT first, Claude second: flashcards are ChatGPT's work now.
    await page.evaluate(() => window.pyxis.invoke("engines.reorder", { order: ["codex", "claude"] }));
    await expect
      .poll(async () => {
        const features = (await page.evaluate(() => window.pyxis.invoke("engines.features", {}))) as Record<
          string,
          { provider: string }
        >;
        return features.cards?.provider;
      })
      .toBe("codex");

    // ---- The first job meets the limit: Claude writes the flashcards, and Pyxis says so once, in one quiet line.
    const first = await makeCards(page, "legami");
    await expect.poll(async () => (await jobOf(page, first))?.state, { timeout: 30_000 }).toBe("succeeded");
    expect((await jobOf(page, first))?.fallback).toEqual({ from: "ChatGPT", to: "Claude", reason: "limit" });
    const told = page.getByText("ChatGPT ha finito le richieste, quindi ha risposto Claude.");
    await expect(told).toHaveCount(1);
    // The flashcards are there: the work was done.
    expect(
      await page.evaluate(
        async () =>
          ((await window.pyxis.invoke("study.cards", { planId: "chimica", topicId: "legami" })) as unknown[]).length,
      ),
    ).toBe(RECORDED_CARDS.length);

    // ---- The next job goes straight to Claude: ChatGPT is not tried again, and nothing more is said.
    const second = await makeCards(page, "mole");
    await expect.poll(async () => (await jobOf(page, second))?.state, { timeout: 30_000 }).toBe("succeeded");
    expect((await jobOf(page, second))?.fallback).toBeUndefined();

    // ---- Settings says which tool is out, and until when.
    await openTools(page);
    const chatgpt = page.locator('.engines-tool[data-tool="codex"]');
    await expect(chatgpt.locator(".engines-tool-state")).toHaveText("Richieste finite");
    // The row keeps its three roles and says when the requests return on a line of its own under them.
    await expect(chatgpt.locator("[data-roles] [data-role]")).toHaveCount(3);
    await expect(chatgpt.locator(".px-ctl-description").filter({ hasText: "Le richieste tornano" })).toHaveText(
      "Le richieste tornano domani alle 06:00.",
    );
    // ChatGPT runs the chat on its balanced model, which its row says on a line of its own.
    await expect(chatgpt).toContainText("Qui «Chat» usa il modello equilibrato.");
    await expect(page.locator('.engines-tool[data-tool="claude"] .engines-tool-state')).toHaveText("Collegato");
    await saveShot(page, "tools/limit-it.png", { fullPage: true });
    await expectNoAxeViolations(page, { tags: ["wcag2a", "wcag2aa", "wcag21aa"] });

    // ---- Pyxis is closed and opened again: the tool is still known to be out, so it is not tried first.
    await app.close();
    app = await launchPyxis({ userData, env });
    page = await app.firstWindow();
    await expect(page).toHaveURL(/#\/ask$/, { timeout: 30_000 });
    const limited = await page.evaluate(async () => {
      const rows = (await window.pyxis.invoke("engines.overview", {})) as Array<{ id: string; limitedUntil: number | null }>;
      return rows.find((row) => row.id === "codex")?.limitedUntil;
    });
    expect(limited).toBe(tomorrow.getTime());
    await openTools(page);
    await expect(page.locator('.engines-tool[data-tool="codex"] .engines-tool-state')).toHaveText("Richieste finite");
    await expect(
      page.locator('.engines-tool[data-tool="codex"] .px-ctl-description').filter({ hasText: "Le richieste tornano" }),
    ).toHaveText("Le richieste tornano domani alle 06:00.");
  } finally {
    await app.close();
    removeTestFolder(userData);
    rmSync(tools.bin, { recursive: true, force: true });
  }
});

test("Strumenti AI: a tool the student turns off keeps its row and takes no work until it is used again", async () => {
  test.skip(process.platform === "win32", "stand-in tools are shell scripts");
  test.setTimeout(180_000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-tools-off-"));
  const tools = standInTools(["claude", "codex"]);
  const app = await launchPyxis({ userData, env: tools.env });
  const providers = async (page: Page) => {
    const features = (await page.evaluate(() => window.pyxis.invoke("engines.features", {}))) as Record<
      string,
      { provider: string }
    >;
    return [...new Set(Object.values(features).map((row) => row.provider))].sort();
  };
  const allowed = (page: Page) =>
    page.evaluate(
      async () => ((await window.pyxis.invoke("engines.choice", {})) as { allowed: string[] | null }).allowed,
    );
  const menu = (page: Page, name: string) => page.getByRole("region", { name: `Azioni su ${name}` });
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Salta" }).click();
    await expect(page).toHaveURL(/#\/ask$/);
    await useTools(page, ["claude", "codex"]);
    await page.evaluate(() => window.pyxis.invoke("engines.reorder", { order: ["codex", "claude"] }));
    await openTools(page);
    await expect(listed(page)).toHaveText(["ChatGPT", "Claude"]);
    await expect.poll(() => providers(page)).toEqual(["codex"]);

    // ---- Turned off from its menu: the first tool keeps its row, loses its place and takes no work.
    await page.getByRole("button", { name: "Azioni su ChatGPT" }).click();
    await clickSettled(page, menu(page, "ChatGPT").getByRole("menuitem", { name: "Non usare" }));
    const chatgpt = page.locator('.engines-tool[data-tool="codex"]');
    await expect(chatgpt.locator(".engines-tool-state")).toHaveText("Non in uso");
    await expect(chatgpt.locator(".engines-tool-n")).toHaveCount(0);
    await expect(page.locator('.engines-tool[data-tool="claude"] .engines-tool-n')).toHaveText("1");
    await expect.poll(() => allowed(page)).toEqual(["claude"]);
    await expect.poll(() => providers(page)).toEqual(["claude"]);
    await expect(page.locator(".engines-summary")).toContainText("Pyxis usa Claude per tutto");
    await saveShot(page, "tools/off-it.png", { fullPage: true });
    // One tool has to stay in use: the last one cannot be turned off.
    await page.getByRole("button", { name: "Azioni su Claude" }).click();
    await expect(menu(page, "Claude").getByRole("menuitem", { name: "Non usare" })).toBeDisabled();
    await page.keyboard.press("Escape");
    await expectNoAxeViolations(page, { tags: ["wcag2a", "wcag2aa", "wcag21aa"] });

    // ---- Used again: it takes its place back, and with it the work, since it is first in the list.
    await page.getByRole("button", { name: "Azioni su ChatGPT" }).click();
    await clickSettled(page, menu(page, "ChatGPT").getByRole("menuitem", { name: "Usa di nuovo" }));
    await expect(chatgpt.locator(".engines-tool-state")).toHaveText("Collegato");
    await expect(page.locator(".engines-tool-n")).toHaveText(["1", "2"]);
    // Every tool is in use again, also one connected later.
    await expect.poll(() => allowed(page)).toBeNull();
    await expect.poll(() => providers(page)).toEqual(["codex"]);

    // ---- Scollega asks first, since coming back takes a sign-in in the browser.
    await page.getByRole("button", { name: "Scollega ChatGPT" }).click();
    const ask = page.getByRole("dialog", { name: "Scollegare ChatGPT?" });
    await expect(ask).toBeVisible();
    await clickSettled(page, ask.getByRole("button", { name: "Annulla" }));
    await expect(ask).toHaveCount(0);
    await expect(chatgpt.locator(".engines-tool-state")).toHaveText("Collegato");
  } finally {
    await app.close();
    removeTestFolder(userData);
    rmSync(tools.bin, { recursive: true, force: true });
  }
});

test("Strumenti AI: connecting a tool the student had left out puts it back in use, also when no tool works yet", async () => {
  test.skip(process.platform === "win32", "stand-in tools are shell scripts");
  test.setTimeout(120_000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-tools-connect-"));
  // Nothing is signed in. The student had left everything but Claude out, and Claude is not signed in either.
  const tools = standInTools([]);
  const app = await launchPyxis({ userData, env: tools.env });
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Salta" }).click();
    await expect(page).toHaveURL(/#\/ask$/);
    await page.evaluate(() => window.pyxis.invoke("engines.choose", { allowed: ["claude"] }));
    await page.evaluate(() => {
      localStorage.setItem("pyxis.lang", "it");
      location.hash = "/settings/engines";
    });
    await page.reload();
    const allowed = () =>
      page.evaluate(
        async () => ((await window.pyxis.invoke("engines.choice", {})) as { allowed: string[] | null }).allowed,
      );
    expect(await allowed()).toEqual(["claude"]);
    await page.getByRole("button", { name: "Installa e accedi a ChatGPT" }).click();
    await expect(page.getByRole("dialog", { name: "Configura ChatGPT" })).toBeVisible();
    // ChatGPT is in use before its sign-in: the sign-in that follows leaves a tool Pyxis can use.
    await expect.poll(allowed).toBeNull();
  } finally {
    await app.close();
    removeTestFolder(userData);
    rmSync(tools.bin, { recursive: true, force: true });
  }
});
