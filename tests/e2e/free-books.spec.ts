import AxeBuilder from "@axe-core/playwright";
import {
  _electron as electron,
  expect,
  test,
  type Page,
} from "@playwright/test";
import { strToU8, zipSync } from "fflate";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MAIN = join(
  process.cwd(),
  process.env.PYXIS_OUT ?? "out",
  "main/index.js",
);

// A folder laid out like books.politost.it: the catalog and one package. `tamper` lists a checksum that does not match.
function booksSite(options: { tamper?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pyxis-books-"));
  const pkg = zipSync({
    "smartbook.json": strToU8(
      JSON.stringify({
        id: "fisica-demo",
        title: "Fisica di prova",
        access: "public",
        chapters: [{ id: "c1", number: 1, title: "Moti", file: "01.md" }],
      }),
    ),
    "chapters/01.md": strToU8(
      "## p1 | Velocità\nLa velocità media è lo spazio percorso diviso il tempo impiegato.\n",
    ),
  });
  mkdirSync(join(dir, "books"));
  writeFileSync(join(dir, "books", "fisica-demo@1.0.0.ptsb"), pkg);
  const sha = createHash("sha256").update(pkg).digest("hex");
  writeFileSync(
    join(dir, "catalog.json"),
    JSON.stringify({
      catalogVersion: 1,
      books: [
        {
          id: "fisica-demo",
          title: "Fisica di prova",
          subject: "Fisica",
          authors: ["PoliTost"],
          version: "1.0.0",
          chapters: 1,
          package: "books/fisica-demo@1.0.0.ptsb",
          bytes: pkg.byteLength,
          sha256: options.tamper ? sha.replace(/^./, sha[0] === "0" ? "1" : "0") : sha,
        },
      ],
    }),
  );
  return dir;
}

async function launch(userData: string, books: string) {
  const env = {
    ...process.env,
    PYXIS_USER_DATA: userData,
    PYXIS_E2E: "1",
    PYXIS_E2E_BOOKS: books,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  return electron.launch({ args: [MAIN], env });
}

async function noAxeViolations(page: Page) {
  const found = (await new AxeBuilder({ page }).setLegacyMode(true).analyze())
    .violations;
  expect(
    found.map(
      (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`,
    ),
  ).toEqual([]);
}

const button = (page: Page, name: string | RegExp) =>
  page.getByRole("button", { name, exact: typeof name === "string" });

/** With sources in the Library, the free books sit in the toolbar's More menu. */
async function openBooksFromMenu(page: Page) {
  await button(page, "Altro").click();
  await page
    .getByRole("menuitem", { name: "Libri PoliTost gratuiti", exact: true })
    .click();
}

test("Free books: from the end of setup a book goes into a new exam, and the Library shows it as already there", async () => {
  test.setTimeout(180000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-books-user-"));
  const books = booksSite();
  const app = await launch(userData, books);
  try {
    const page = await app.firstWindow();
    await page.emulateMedia({ reducedMotion: "reduce" });
    await button(page, "Inizia").click();
    await page.getByLabel("Nome", { exact: true }).fill("Ada");
    await button(page, "Continua").click();
    await button(page, /^(Lo farò dopo|Continua)$/).click();
    await button(page, "Continua").click();
    await button(page, "Continua").click();
    await expect(page.getByRole("heading", { name: "Tutto pronto" })).toBeVisible();

    // The wizard opens with the books already showing.
    await button(page, "Parti da un libro PoliTost gratuito").click();
    const dialog = page.getByRole("dialog", { name: "Libri PoliTost gratuiti" });
    await expect(dialog.getByText("Fisica di prova")).toBeVisible({
      timeout: 30000,
    });
    await expect(
      dialog.getByText("Fisica · 1 capitolo · ", { exact: false }),
    ).toBeVisible();
    await noAxeViolations(page);
    await dialog.getByRole("button", { name: "Aggiungi Fisica di prova" }).click();
    await expect(dialog.getByText("Aggiunto")).toBeVisible({ timeout: 30000 });
    await dialog.getByRole("button", { name: /Close|Chiudi/ }).click();
    // The first book names the exam.
    await expect(page.locator("#plan-title")).toHaveValue("Fisica di prova");
    await expect(page.locator("#plan-subject")).toHaveValue("Fisica");

    const imported = async () =>
      (
        (await page.evaluate(() =>
          window.pyxis.invoke("sources.list", {}),
        )) as Array<{ title: string; kind: string; status: string }>
      ).filter((row) => row.title === "Fisica di prova");
    await expect
      .poll(async () => (await imported()).map((row) => `${row.kind}:${row.status}`), {
        timeout: 60000,
      })
      .toEqual(["smartbook:ready"]);

    // The Library offers the same list, and a book already imported is not downloaded twice.
    await page.evaluate(() => {
      location.hash = "/exams/library";
    });
    await openBooksFromMenu(page);
    const again = page.getByRole("dialog", { name: "Libri PoliTost gratuiti" });
    await expect(again.getByText("Nella tua libreria")).toBeVisible({
      timeout: 30000,
    });
    await expect(again.getByRole("button", { name: /^Aggiungi/ })).toHaveCount(0);
    expect(await imported()).toHaveLength(1);

    // Removed from the Library, the book can be added again: the dialog no longer calls it in the library.
    await again.getByRole("button", { name: /Close|Chiudi/ }).click();
    page.on("dialog", (prompt) => void prompt.accept());
    await button(page, "Azioni per Fisica di prova").click();
    await page.getByRole("menuitem", { name: "Rimuovi" }).click();
    await expect.poll(async () => (await imported()).length).toBe(0);
    await button(page, "Libri PoliTost gratuiti").click();
    await expect(
      again.getByRole("button", { name: "Aggiungi Fisica di prova" }),
    ).toBeVisible({ timeout: 30000 });
    await expect(again.getByText("Nella tua libreria")).toHaveCount(0);
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
    rmSync(books, { recursive: true, force: true });
  }
});

test("Free books: a package that does not match the catalog is refused and nothing is imported", async () => {
  test.setTimeout(120000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-books-user-"));
  const books = booksSite({ tamper: true });
  const app = await launch(userData, books);
  try {
    const page = await app.firstWindow();
    await button(page, "Salta").click();
    // The hash, not the whole URL: a checkout path can contain "exams" too.
    await expect(page).toHaveURL(/#\/exams$/);
    await page.evaluate(() => {
      location.hash = "/exams/library";
    });
    await button(page, "Libri PoliTost gratuiti").click();
    const dialog = page.getByRole("dialog", { name: "Libri PoliTost gratuiti" });
    await dialog.getByRole("button", { name: "Aggiungi Fisica di prova" }).click();
    await expect(
      dialog.getByRole("alert").filter({
        hasText: "Il libro scaricato non corrisponde all'elenco",
      }),
    ).toBeVisible({ timeout: 30000 });
    expect(
      await page.evaluate(() => window.pyxis.invoke("sources.list", {})),
    ).toEqual([]);
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
    rmSync(books, { recursive: true, force: true });
  }
});
