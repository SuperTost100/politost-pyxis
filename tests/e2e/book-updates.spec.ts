import {
  expect,
  test,
  type Page,
} from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { launchPyxis } from "./app-under-test";
import { makeBook } from "./book";
import { expectNoAxeViolations } from "./axe";
import { animationsSettled } from "./settled";

const SPEED =
  "La velocità media è lo spazio percorso diviso il tempo impiegato.";
const ACCEL_V1 = "L'accelerazione è la variazione di velocità nel tempo.";
const ACCEL_V2 =
  "L'accelerazione misura quanto cambia la velocità in un secondo.";

/** Version 1 has two chapters. Version 2 rewrites one paragraph and adds a third chapter. */
function pack(version: string) {
  const v2 = version !== "1.0.0";
  return makeBook({
    id: "fisica-demo",
    title: "Fisica di prova",
    version,
    chapters: [
      { id: "moti", title: "Moti", text: `## p1 | Velocità\n${SPEED}\n\n## p2 | Accelerazione\n${v2 ? ACCEL_V2 : ACCEL_V1}\n` },
      { id: "forze", title: "Forze", text: "## p1 | Dinamica\nLa forza risultante è uguale alla massa per l'accelerazione.\n" },
      ...(v2
        ? [{ id: "energia", title: "Energia", text: "## p1 | Lavoro\nIl lavoro di una forza costante è forza per spostamento.\n" }]
        : []),
    ],
  });
}

/** Lays out books.politost.it in `dir` with the book at `version`. */
function publish(dir: string, version: string) {
  const pkg = pack(version);
  mkdirSync(join(dir, "books"), { recursive: true });
  writeFileSync(join(dir, "books", `fisica-demo@${version}.ptsb`), pkg);
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
          version,
          chapters: version === "1.0.0" ? 2 : 3,
          package: `books/fisica-demo@${version}.ptsb`,
          bytes: pkg.byteLength,
          sha256: createHash("sha256").update(pkg).digest("hex"),
        },
      ],
    }),
  );
}

function launch(userData: string, books: string) {
  // Recorded replies for the plan's introduction and diagnostic; no model is called.
  const env = {
    PYXIS_E2E_BOOKS: books,
    PYXIS_E2E_PLAN_REPLIES: JSON.stringify({
      markdown: { markdown: "## Introduzione\n\nStudierai il moto." },
      questions: {
        questions: Array.from({ length: 10 }, (_, i) => ({
          stem: `Domanda ${i + 1}?`,
          options: ["Uno", "Due", "Tre", "Quattro"],
          correct: 0,
          topicIndex: i % 2,
          passageIds: [],
          explanation: "Perché sì.",
        })),
      },
    }),
  };
  return launchPyxis({ userData, env });
}

/** Reads the workspace database next to the running app; WAL lets a second reader see committed rows. */
function rows<T>(userData: string, sql: string, ...args: string[]): T[] {
  const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), {
    readOnly: true,
    timeout: 10000,
  });
  try {
    return db.prepare(sql).all(...args) as T[];
  } finally {
    db.close();
  }
}

const invoke = <T>(page: Page, channel: string, input: object) =>
  page.evaluate(
    ([c, i]) =>
      window.pyxis.invoke(c as never, i as never).catch((error: unknown) => {
        throw new Error(JSON.stringify(error));
      }),
    [channel, input] as const,
  ) as Promise<T>;

async function noAxeViolations(page: Page) {
  // Let a modal finish its entrance before measuring contrast.
  await animationsSettled(page);
  await expectNoAxeViolations(page);
}

test("Book updates: a newer free book updates the same source in place, flags changed citations and offers its new chapter", async () => {
  test.setTimeout(240000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-book-updates-"));
  const books = mkdtempSync(join(tmpdir(), "pyxis-books-site-"));
  publish(books, "1.0.0");
  let sourceId = "";
  let planId = "";
  let app = await launch(userData, books);
  try {
    const page = await app.firstWindow();
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.getByRole("button", { name: "Salta" }).click();
    sourceId = (
      await invoke<{ sourceId: string }>(page, "sources.importBook", {
        id: "fisica-demo",
      })
    ).sourceId;
    await expect
      .poll(
        async () =>
          (
            await invoke<Array<{ id: string; status: string }>>(
              page,
              "sources.list",
              {},
            )
          ).find((row) => row.id === sourceId)?.status,
        { timeout: 60000 },
      )
      .toBe("ready");
    planId = (
      await invoke<{ planId: string }>(page, "plans.create", {
        title: "Fisica",
        sourceIds: [sourceId],
      })
    ).planId;
    await expect
      .poll(
        async () =>
          (
            await invoke<{ state: string } | null>(page, "plans.build", {
              planId,
            })
          )?.state,
        { timeout: 60000 },
      )
      .toBe("succeeded");
    // Two lessons: one cites the paragraph version 2 rewrites, one a paragraph it keeps.
    const passage = (text: string) =>
      rows<{ id: string }>(
        userData,
        "SELECT id FROM passages WHERE source_id = ? AND text = ?",
        sourceId,
        text,
      )[0]!.id;
    const seed = new DatabaseSync(join(userData, "workspace", "pyxis.db"), {
      timeout: 10000,
    });
    seed
      .prepare(
        "INSERT INTO items(id,plan_id,kind,body_json,created_at) VALUES('cites-changed',?,'lesson','{}',1),('cites-same',?,'lesson','{}',1)",
      )
      .run(planId, planId);
    seed
      .prepare(
        "INSERT INTO item_passages(item_id,passage_id) VALUES('cites-changed',?),('cites-same',?)",
      )
      .run(passage(ACCEL_V1), passage(SPEED));
    seed.close();
  } finally {
    await app.close();
  }

  // The books site publishes version 2; the student opens Pyxis again.
  publish(books, "1.1.0");
  app = await launch(userData, books);
  try {
    const page = await app.firstWindow();
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.evaluate(() => {
      location.hash = "/exams/library";
    });
    await expect(
      page.getByText("Nuova versione disponibile: 1.1.0"),
    ).toBeVisible({ timeout: 30000 });

    // The books list says the same, with Update in place of Add.
    await page.getByRole("button", { name: "Altro", exact: true }).click();
    await page
      .getByRole("menuitem", { name: "Libri PoliTost gratuiti", exact: true })
      .click();
    const dialog = page.getByRole("dialog", {
      name: "Libri PoliTost gratuiti",
    });
    await expect(dialog.getByText("Nuova versione disponibile")).toBeVisible({
      timeout: 30000,
    });
    await expect(
      dialog.getByRole("button", { name: "Aggiorna Fisica di prova" }),
    ).toBeVisible();
    await expect(dialog.getByRole("button", { name: /^Aggiungi/ })).toHaveCount(
      0,
    );
    await noAxeViolations(page);
    await dialog.getByRole("button", { name: /Close|Chiudi/ }).click();
    await expect(dialog).toBeHidden();

    // A plan uses the book, so Update asks first. Declining starts nothing.
    const asked: string[] = [];
    let answer: "accept" | "dismiss" = "dismiss";
    page.on("dialog", (prompt) => {
      asked.push(prompt.message());
      void (answer === "accept" ? prompt.accept() : prompt.dismiss());
    });
    const update = page.getByRole("button", {
      name: "Aggiorna Fisica di prova",
    });
    await update.click();
    await expect.poll(() => asked.length).toBe(1);
    expect(asked[0]).toMatch(/1 piano usa questo libro/);
    // Declining must start nothing. A job that never starts has no signal to wait for, so this is a fixed wait.
    await page.waitForTimeout(500);
    const versions = () =>
      rows<{ version: number }>(
        userData,
        "SELECT version FROM source_documents WHERE source_id = ? ORDER BY version",
        sourceId,
      ).map((row) => row.version);
    expect(versions()).toEqual([1]);
    await noAxeViolations(page);

    answer = "accept";
    await update.click();
    await expect(
      page.getByText(
        "Fisica di prova si sta aggiornando alla versione 1.1.0.",
        { exact: false },
      ),
    ).toBeVisible({ timeout: 30000 });
    await expect.poll(versions, { timeout: 60000 }).toEqual([1, 2]);
    await expect
      .poll(() =>
        rows(
          userData,
          "SELECT status, catalog_version AS version FROM sources",
        ),
      )
      .toEqual([{ status: "ready", version: "1.1.0" }]);
    await expect(
      page.getByText("Nuova versione disponibile: 1.1.0"),
    ).toHaveCount(0);
    await page.getByRole("button", { name: "Altro", exact: true }).click();
    await page
      .getByRole("menuitem", { name: "Libri PoliTost gratuiti", exact: true })
      .click();
    await expect(dialog.getByText("Nella tua libreria")).toBeVisible();
    await expect(dialog.getByText("Nuova versione disponibile")).toBeHidden();
    await dialog.getByRole("button", { name: /Close|Chiudi/ }).click();

    // Still one source; the lesson citing rewritten text is flagged, the other is not.
    expect(
      rows(
        userData,
        "SELECT item_id, stale FROM item_passages WHERE item_id LIKE 'cites-%' ORDER BY item_id",
      ),
    ).toEqual([
      { item_id: "cites-changed", stale: 1 },
      { item_id: "cites-same", stale: 0 },
    ]);
    expect(
      rows(
        userData,
        "SELECT p.text FROM item_passages ip JOIN passages p ON p.id = ip.passage_id WHERE ip.item_id = 'cites-changed'",
      ),
    ).toEqual([{ text: ACCEL_V1 }]);

    // The plan still opens, suggests Rebuild topics, and the review offers the new chapter.
    const titles = async () =>
      (
        await invoke<{ topics: Array<{ title: string }> }>(page, "plans.read", {
          planId,
        })
      ).topics.map((topic) => topic.title);
    expect(await titles()).toEqual(["1. Moti", "2. Forze"]);
    await page.evaluate((id) => {
      location.hash = `/plans/${id}/sources`;
    }, planId);
    await expect(
      page.getByText(
        "Le fonti sono cambiate da quando hai creato gli argomenti.",
        { exact: false },
      ),
    ).toBeVisible({ timeout: 30000 });
    await page
      .getByRole("button", { name: "Ricostruisci gli argomenti" })
      .first()
      .click();
    const rebuild = page.getByRole("dialog");
    await rebuild
      .getByRole("button", { name: "Confronta con le fonti" })
      .click();
    await expect(rebuild.getByText("2 argomenti mantenuti")).toBeVisible({
      timeout: 60000,
    });
    await expect(
      rebuild.getByText("3. Energia", { exact: true }),
    ).toBeVisible();
    await rebuild.getByRole("button", { name: "Applica le modifiche" }).click();
    await expect(rebuild).toBeHidden();
    expect(await titles()).toEqual(["1. Moti", "2. Forze", "3. Energia"]);
    mkdirSync(".shots", { recursive: true });
    await page.screenshot({
      path: ".shots/book-update-rebuilt-it.png",
      animations: "disabled",
    });
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
    rmSync(books, { recursive: true, force: true });
  }
});
