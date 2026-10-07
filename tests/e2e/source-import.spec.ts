import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The native picker is answered by main's real handler, so grants for files and folders go through the same path
 * a student's pick takes. Only the system dialog itself is replaced, and the options it was given are recorded.
 */
async function answerPicker(app: ElectronApplication, paths: string[]) {
  await app.evaluate(({ dialog }, answer) => {
    delete process.env["PYXIS_E2E_FILE"];
    const host = globalThis as unknown as { __pickerOptions?: unknown[] };
    host.__pickerOptions = [];
    dialog.showOpenDialog = (async (...args: unknown[]) => {
      host.__pickerOptions!.push(args[args.length - 1]);
      return { canceled: false, filePaths: answer };
    }) as typeof dialog.showOpenDialog;
  }, paths);
}

async function pickerProperties(app: ElectronApplication) {
  return app.evaluate(() => {
    const host = globalThis as unknown as {
      __pickerOptions?: Array<{ properties?: string[] }>;
    };
    return host.__pickerOptions?.at(-1)?.properties ?? [];
  });
}

async function start() {
  const userData = mkdtempSync(join(tmpdir(), "pyxis-import-"));
  const notes = join(userData, "notes");
  mkdirSync(join(notes, "esami"), { recursive: true });
  const files = {
    cinematica: join(notes, "cinematica.txt"),
    dinamica: join(notes, "dinamica.md"),
    vecchio: join(notes, "esami", "vecchio.txt"),
  };
  writeFileSync(files.cinematica, "La velocità descrive lo spostamento.\n");
  writeFileSync(files.dinamica, "# Dinamica\n\nLa forza è massa per accelerazione.\n");
  writeFileSync(files.vecchio, "Un tema d'esame di fisica con soluzione.\n");
  mkdirSync(join(userData, "vuota"));
  writeFileSync(join(userData, "vuota", "foto.xyz"), "not a source");
  const env = { ...process.env, PYXIS_USER_DATA: userData, PYXIS_E2E: "1" };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.PYXIS_E2E_FILE;
  const app = await electron.launch({
    args: [join(process.cwd(), "out/main/index.js")],
    env,
  });
  const page = await app.firstWindow();
  await page.getByRole("button", { name: "Salta" }).click();
  // Skipping setup navigates to Exams on its own; wait so it cannot override a later route.
  await expect(page).toHaveURL(/#\/exams$/);
  return { app, page, userData, notes, files };
}

async function openAdd(page: Page, tab?: string) {
  await page.getByRole("button", { name: "Aggiungi fonti", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  if (tab) await dialog.getByRole("radio", { name: tab }).locator("..").click();
  return dialog;
}

test("SRC-07 picking a folder lists its files, imports the ticked ones and says what happened", async () => {
  test.setTimeout(180000);
  const { app, page, userData, notes, files } = await start();
  try {
    await page.getByText("Fonti", { exact: true }).click();

    // A file already in the library comes back unticked when its folder is read.
    await answerPicker(app, [files.cinematica]);
    let dialog = await openAdd(page);
    await dialog.getByRole("button", { name: "Scegli i file", exact: true }).click();
    // A single clean import closes the dialog.
    await expect(dialog).toBeHidden();
    await expect(page.getByRole("button", { name: "cinematica", exact: true })).toBeVisible();
    expect(await pickerProperties(app)).toEqual(["openFile", "multiSelections"]);

    await answerPicker(app, [notes]);
    dialog = await openAdd(page, "Cartella");
    await dialog.getByRole("button", { name: "Aggiungi una cartella" }).click();
    expect(await pickerProperties(app)).toEqual(["openDirectory"]);
    const rows = dialog.getByRole("checkbox");
    await expect(rows).toHaveCount(3);
    await expect(dialog.getByText("3 file trovati.")).toBeVisible();
    await expect(dialog.getByText("Già in libreria", { exact: true })).toBeVisible();
    // A file already in the library is ticked too and says so. Adding it uses the source that is there.
    for (const name of ["cinematica.txt", "dinamica.md", "vecchio.txt"])
      await expect(
        dialog.locator("label", { hasText: name }).getByRole("checkbox"),
      ).toBeChecked();
    await dialog.getByRole("button", { name: "Aggiungi 3 file", exact: true }).click();

    await expect(dialog.getByText("2 file importati.")).toBeVisible();
    await expect(
      dialog.getByText(/cinematica\.txt.*Già in libreria: uso quella/),
    ).toBeVisible();
    // Every file handled leaves the checklist.
    await expect(rows).toHaveCount(0);
    await dialog.getByRole("button", { name: "Fatto", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect
      .poll(async () =>
        (await page.evaluate(() => window.pyxis.invoke("sources.list", {})))
          .map((row) => row.title)
          .sort(),
      )
      .toEqual(["cinematica", "dinamica", "vecchio"]);

    // A folder with nothing Pyxis can read says so instead of showing nothing.
    await answerPicker(app, [join(userData, "vuota")]);
    dialog = await openAdd(page, "Cartella");
    await dialog.getByRole("button", { name: "Aggiungi una cartella" }).click();
    await expect(dialog.getByText(/Nella cartella vuota non ci sono file/)).toBeVisible();
    await expect(dialog.getByRole("button", { name: /^(Importa|Aggiungi) \d+ file/ })).toHaveCount(0);
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
});

test("SRC-07 the file picker takes several files and the result lists them", async () => {
  test.setTimeout(180000);
  const { app, page, userData, files } = await start();
  try {
    await page.getByText("Fonti", { exact: true }).click();
    await answerPicker(app, [files.cinematica, files.dinamica, files.cinematica]);
    const dialog = await openAdd(page);
    await dialog.getByRole("button", { name: "Scegli i file", exact: true }).click();
    // The same file twice makes one source. The second is named as already in the library.
    await expect(dialog.getByText("2 file importati.")).toBeVisible();
    await expect(
      dialog.getByText(/cinematica\.txt.*Già in libreria: uso quella/),
    ).toBeVisible();
    await dialog.getByRole("button", { name: "Fatto", exact: true }).click();
    await expect(dialog).toBeHidden();
    // Choosing the same file again later changes nothing in the library either.
    await answerPicker(app, [files.cinematica]);
    const again = await openAdd(page);
    await again.getByRole("button", { name: "Scegli i file", exact: true }).click();
    await expect(again.getByText("Nessun file nuovo.")).toBeVisible();
    await again.getByRole("button", { name: "Fatto", exact: true }).click();
    const titles = await page.evaluate(() =>
      window.pyxis.invoke("sources.list", {}),
    );
    expect(titles.map((row) => row.title).sort()).toEqual(["cinematica", "dinamica"]);
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
});

test("PLAN-01 the wizard starts with no sources and includes whatever is imported there", async () => {
  test.setTimeout(180000);
  const { app, page, userData, files } = await start();
  try {
    // One older source sits in the library, unrelated to the plan, and is not offered until asked for.
    await answerPicker(app, [files.vecchio]);
    await page.getByText("Fonti", { exact: true }).click();
    let dialog = await openAdd(page);
    await dialog.getByRole("button", { name: "Scegli i file", exact: true }).click();
    await expect(dialog).toBeHidden();

    await page.getByTitle("Piani", { exact: true }).click();
    await page.getByRole("button", { name: "Nuovo piano", exact: true }).click();
    await page.locator("#plan-title").fill("Fisica");
    for (let step = 0; step < 3; step++)
      await page.getByRole("button", { name: "Continua", exact: true }).click();
    await expect(page.getByText("0 fonti nel piano")).toBeVisible();
    await expect(page.getByRole("button", { name: "Non ho materiale" })).toBeVisible();
    await expect(page.getByRole("button", { name: "vecchio", exact: true })).toHaveCount(0);

    // Two files imported here are in the plan with no ticking.
    await answerPicker(app, [files.cinematica, files.dinamica]);
    dialog = await openAdd(page);
    await dialog.getByRole("button", { name: "Scegli i file", exact: true }).click();
    await dialog.getByRole("button", { name: "Fatto", exact: true }).click();
    await expect(page.getByText("2 fonti nel piano")).toBeVisible();
    const list = page.getByRole("list", { name: "Fonti del piano" });
    await expect(list.getByRole("listitem")).toHaveCount(2);
    await expect(page.getByRole("button", { name: "Non ho materiale" })).toHaveCount(0);

    // A file already in the library is not copied: its source joins the plan.
    await answerPicker(app, [files.vecchio]);
    dialog = await openAdd(page);
    await dialog.getByRole("button", { name: "Scegli i file", exact: true }).click();
    await expect(dialog.getByText("Nessun file nuovo.")).toBeVisible();
    await dialog.getByRole("button", { name: "Fatto", exact: true }).click();
    await expect(page.getByText("3 fonti nel piano")).toBeVisible();
    await expect(list.getByText("vecchio")).toBeVisible();
    expect(
      (await page.evaluate(() => window.pyxis.invoke("sources.list", {}))).length,
    ).toBe(3);

    // Taking them out leaves them in the library, where the picker finds them again.
    await list.getByRole("button", { name: "Togli dinamica dal piano" }).click();
    await list.getByRole("button", { name: "Togli vecchio dal piano" }).click();
    await expect(page.getByText("1 fonte nel piano")).toBeVisible();
    await page.getByRole("button", { name: "Dalla tua libreria", exact: true }).click();
    dialog = page.getByRole("dialog", { name: "Aggiungi dalla libreria" });
    await expect(dialog.getByRole("checkbox")).toHaveCount(2);
    await dialog.getByRole("textbox", { name: "Cerca nella libreria" }).fill("vecc");
    await expect(dialog.getByRole("checkbox")).toHaveCount(1);
    await dialog.getByRole("checkbox").check();
    await dialog.getByRole("button", { name: "Aggiungi 1 fonte", exact: true }).click();
    await expect(page.getByText("2 fonti nel piano")).toBeVisible();
    await expect(list.getByRole("listitem")).toHaveCount(2);
    await expect(list.getByText("vecchio")).toBeVisible();

    // The summary on the last step counts the same sources.
    for (let step = 0; step < 2; step++)
      await page.getByRole("button", { name: "Continua", exact: true }).click();
    await expect(page.getByText(/2 fonti nel piano/)).toBeVisible();
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
});
