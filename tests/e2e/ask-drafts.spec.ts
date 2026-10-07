import { _electron as electron, expect, test } from "@playwright/test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MAIN = join(
  process.cwd(),
  process.env.PYXIS_OUT ?? "out",
  "main/index.js",
);

async function launch(extra: Record<string, string> = {}) {
  const userData = mkdtempSync(join(tmpdir(), "pyxis-ask-drafts-"));
  const env = {
    ...process.env,
    PYXIS_USER_DATA: userData,
    PYXIS_E2E: "1",
    ...extra,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: [MAIN], env });
  const page = await app.firstWindow();
  await page.getByRole("button", { name: "Salta" }).click();
  await expect(page).toHaveURL(/#\/exams$/);
  return { app, page, userData };
}

const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

test("R14-3 a suggestion sends only its own text and leaves the draft and photos in the composer", async () => {
  test.setTimeout(90000);
  const dir = mkdtempSync(join(tmpdir(), "pyxis-ask-files-"));
  const note = join(dir, "appunti.txt");
  writeFileSync(note, "La forza è massa per accelerazione.");
  const { app, page, userData } = await launch({
    PYXIS_E2E_REPLY: "Ecco.\n<followups>\nPerché?\nEsempio?\nAltro?\n</followups>",
    PYXIS_E2E_FILE: note,
  });
  try {
    await page.evaluate(() => {
      location.hash = "/ask";
    });
    const box = page.getByRole("textbox", { name: "Messaggio" });
    await box.fill("Prima domanda");
    await box.press("Enter");
    await expect(page).toHaveURL(/#\/ask\/.+/);
    const chat = () =>
      page.evaluate(
        () =>
          window.pyxis.invoke("chats.read", {
            chatId: location.hash.split("/").at(-1)!,
          }) as Promise<{
            messages: Array<{ role: string }>;
            held: Array<{ id: string }>;
          }>,
      );
    const chip = page.getByRole("button", { name: "Perché?" });
    await expect(chip).toBeVisible();

    await page.getByRole("button", { name: "Allega file o immagine" }).click();
    await expect(page.getByText("appunti.txt")).toBeVisible();
    await box.fill("Bozza da tenere");

    await chip.click();
    await expect.poll(async () => (await chat()).messages.length).toBe(4);
    // The note stayed pending, so the chip's turn did not carry it.
    expect((await chat()).held).toEqual([]);
    await expect(box).toHaveText("Bozza da tenere");
    await expect(page.getByText("appunti.txt")).toBeVisible();
    expect(
      await page.evaluate(() => sessionStorage.getItem("pyxis-draft")),
    ).toBe("Bozza da tenere");

    // Remove is a real control with the file's name.
    await page.getByRole("button", { name: /appunti\.txt/ }).click();
    await expect(page.getByText("appunti.txt")).toHaveCount(0);

    // A normal send still carries the draft and the file, then clears both.
    await page.getByRole("button", { name: "Allega file o immagine" }).click();
    await expect(page.getByText("appunti.txt")).toBeVisible();
    await box.press("Enter");
    // The fixture reply cites nothing, so a turn that carries a note is "not covered": the question is stored and the answer is not.
    await expect.poll(async () => (await chat()).messages.length).toBe(5);
    expect((await chat()).held).toHaveLength(1);
    await expect(box).toHaveText("");
    await expect(page.getByText("appunti.txt")).toHaveCount(0);
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

const KEYS = ["pyxis-draft", "pyxis-board", "pyxis-board-png", "pyxis-board-file"];

async function seed(page: import("@playwright/test").Page) {
  await page.evaluate(
    ({ png, keys }) => {
      for (const key of keys) sessionStorage.setItem(key, key === "pyxis-board-png" ? png : "x");
      (window as unknown as { marker: number }).marker = 1;
    },
    { png: PNG, keys: KEYS },
  );
}
async function cleared(page: import("@playwright/test").Page) {
  await expect
    .poll(
      () =>
        page
          .evaluate(
            (keys) => ({
              reloaded: (window as unknown as { marker?: number }).marker === undefined,
              left: keys.filter((key) => sessionStorage.getItem(key) !== null),
            }),
            KEYS,
          )
          .catch(() => null),
      { timeout: 20000 },
    )
    .toEqual({ reloaded: true, left: [] });
}

test("R14-4 deleting all data and restoring a backup clear the session before the reload", async () => {
  test.setTimeout(120000);
  const out = mkdtempSync(join(tmpdir(), "pyxis-ask-backup-"));
  const zip = join(out, "backup.zip");
  const { app, page, userData } = await launch({
    PYXIS_E2E_SAVE: zip,
    PYXIS_E2E_ZIP: zip,
  });
  try {
    await page.evaluate(() => {
      location.hash = "/settings/data";
    });
    await page.getByRole("button", { name: "Copia di sicurezza", exact: true }).click();
    await expect(page.getByText("La copia è pronta.")).toBeVisible();

    await seed(page);
    await page.getByRole("button", { name: "Ripristina", exact: true }).click();
    await page.getByRole("button", { name: /^Sostituisci/ }).click();
    await cleared(page);

    await page.evaluate(() => {
      location.hash = "/settings/data";
    });
    await seed(page);
    await page.getByRole("button", { name: "Cancella tutti i dati", exact: true }).click();
    await page.getByRole("button", { name: "Cancella per sempre", exact: true }).click();
    await cleared(page);
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
});
