import { expect, test, type Page } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchPyxis } from "./app-under-test";

async function launch() {
  const userData = mkdtempSync(join(tmpdir(), "pyxis-ask-remount-"));
  const env = {
    // No signed-in AI command-line tools from the machine running the test: their notice would cover the page.
    HOME: userData,
    PYXIS_E2E_REPLY: "Ecco la risposta.\n<followups>\nUn esempio?\n</followups>",
    PYXIS_E2E_REPLY_DELAY: "8000",
  };
  const app = await launchPyxis({ userData, env });
  const page = await app.firstWindow();
  await page.getByRole("button", { name: "Salta" }).click();
  await expect(page).toHaveURL(/#\/exams$/);
  return { app, page, userData };
}

const go = (page: Page, hash: string) =>
  page.evaluate((path) => {
    location.hash = path;
  }, hash);

const messages = (page: Page, chatId: string) =>
  page.evaluate(
    async (id) =>
      ((await window.pyxis.invoke("chats.read", { chatId: id })) as { messages: unknown[] }).messages.length,
    chatId,
  );

test("a reply sent before leaving Ask does not pull the student back to it", async () => {
  test.setTimeout(90000);
  const { app, page, userData } = await launch();
  try {
    await go(page, "/ask");
    const box = page.getByRole("textbox", { name: "Messaggio" });
    await box.fill("Che cos'è un integrale?");
    await box.press("Enter");
    await expect(page.getByText("Sto pensando…")).toBeVisible();
    await go(page, "/exams");
    await expect(page).toHaveURL(/#\/exams$/);

    // The reply is saved while the student is elsewhere, and the page stays where they went.
    const chats = () =>
      page.evaluate(async () => (await window.pyxis.invoke("chats.list", {})) as Array<{ id: string }>);
    await expect.poll(async () => (await chats()).length, { timeout: 20000 }).toBe(1);
    const [chat] = await chats();
    await expect.poll(() => messages(page, chat!.id), { timeout: 20000 }).toBe(2);
    await page.waitForTimeout(500);
    await expect(page).toHaveURL(/#\/exams$/);
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
});

test("coming back while a reply is written shows it running, and core refuses a second turn into it", async () => {
  test.setTimeout(120000);
  const { app, page, userData } = await launch();
  try {
    await go(page, "/ask");
    const box = page.getByRole("textbox", { name: "Messaggio" });
    await box.fill("Prima domanda");
    await box.press("Enter");
    await expect(page).toHaveURL(/#\/ask\/.+/, { timeout: 20000 });
    await expect(page.getByText("Un esempio?")).toBeVisible();
    const chatId = await page.evaluate(() => location.hash.split("/").at(-1)!);

    await box.fill("Seconda domanda");
    await box.press("Enter");
    const stop = page.getByRole("button", { name: "Interrompi", exact: true });
    await expect(stop).toBeVisible();
    await go(page, "/exams");
    await expect(page).toHaveURL(/#\/exams$/);
    await go(page, `/ask/${chatId}`);

    // The question and the reply in progress are back, with Stop instead of an idle Send. Core stored the question
    // before the reply, so the chat read again holds it: it shows once.
    await expect.poll(() => messages(page, chatId)).toBe(3);
    await go(page, "/exams");
    await go(page, `/ask/${chatId}`);
    await expect(page.locator(".px-msg-bubble", { hasText: "Seconda domanda" })).toHaveCount(1);
    await expect(page.locator(".px-msg-bubble", { hasText: "Prima domanda" })).toBeVisible();
    await page.waitForTimeout(500);
    await expect(page.locator(".px-msg-bubble", { hasText: "Seconda domanda" })).toHaveCount(1);
    await expect(stop).toBeVisible();
    await expect(page.getByRole("button", { name: "Invia", exact: true })).toHaveCount(0);

    const refused = await page.evaluate(
      (id) =>
        window.pyxis.invoke("chats.ask", { chatId: id, text: "Terza domanda" }).then(
          () => null,
          (err: { code?: string; messageKey?: string }) => ({ code: err.code, messageKey: err.messageKey }),
        ),
      chatId,
    );
    expect(refused).toEqual({ code: "chat-busy", messageKey: "errors.chatBusy" });

    await expect.poll(() => messages(page, chatId), { timeout: 20000 }).toBe(4);
    await expect(stop).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Invia", exact: true })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`#/ask/${chatId}$`));
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
});

test("a question sent again after Stop shows once while its reply is written", async () => {
  test.setTimeout(120000);
  const { app, page, userData } = await launch();
  try {
    await go(page, "/ask");
    const box = page.getByRole("textbox", { name: "Messaggio" });
    await box.fill("Prima domanda");
    await box.press("Enter");
    await expect(page).toHaveURL(/#\/ask\/.+/, { timeout: 20000 });
    await expect(page.getByText("Un esempio?")).toBeVisible();
    const chatId = await page.evaluate(() => location.hash.split("/").at(-1)!);

    // Stopped mid-reply, the chat keeps the stored question and the composer gets it back.
    await box.fill("Seconda domanda");
    await box.press("Enter");
    const stop = page.getByRole("button", { name: "Interrompi", exact: true });
    await expect.poll(() => messages(page, chatId)).toBe(3);
    await stop.click();
    await expect(stop).toHaveCount(0);
    await expect(box).toHaveText("Seconda domanda");
    const bubbles = page.locator(".px-msg-bubble", { hasText: "Seconda domanda" });
    await expect(bubbles).toHaveCount(1);

    // Sent again, core answers the stored question rather than storing a second one, and the page shows it once.
    await box.press("Enter");
    await expect(stop).toBeVisible();
    await page.waitForTimeout(1000);
    await expect(bubbles).toHaveCount(1);
    expect(await messages(page, chatId)).toBe(3);
    await expect.poll(() => messages(page, chatId), { timeout: 20000 }).toBe(4);
    await expect(bubbles).toHaveCount(1);
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
});

test("a first question's chat opened from the list while its reply is written shows that reply", async () => {
  test.setTimeout(120000);
  const { app, page, userData } = await launch();
  try {
    await go(page, "/ask");
    const box = page.getByRole("textbox", { name: "Messaggio" });
    await box.fill("Che cos'è un integrale?");
    await box.press("Enter");
    await expect(page.getByText("Sto pensando…")).toBeVisible();
    // Core created the chat with the question, so the list already holds it: the student opens it there.
    const chats = () =>
      page.evaluate(async () => (await window.pyxis.invoke("chats.list", {})) as Array<{ id: string }>);
    await expect.poll(async () => (await chats()).length).toBe(1);
    const [chat] = await chats();
    await go(page, `/ask/${chat!.id}`);
    await expect(page).toHaveURL(new RegExp(`#/ask/${chat!.id}$`));
    await expect(page.locator(".px-msg-bubble", { hasText: "Che cos'è un integrale?" })).toHaveCount(1);
    await expect(page.getByText("Sto pensando…").or(page.getByText("Ecco la risposta."))).toBeVisible();
    await expect(page.getByRole("button", { name: "Interrompi", exact: true })).toBeVisible();
    await expect(page.getByText("Un esempio?")).toBeVisible({ timeout: 20000 });
    await expect(page.locator(".px-msg-bubble", { hasText: "Che cos'è un integrale?" })).toHaveCount(1);
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
});
