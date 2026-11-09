import { expect, test } from "@playwright/test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { launchPyxis } from "./app-under-test";
import { seedPlan, seedSubjects } from "./seed";
import { removeTestFolder } from "./cleanup";
import { fromChiediToExams } from "./doors";

function graph(labels: string[]) {
  return {
    layout: "tree",
    undo: null,
    nodes: labels.map((label, i) => ({
      id: `n${i}`,
      label,
      parent: i ? "n0" : null,
      x: 0,
      y: 0,
      pinned: false,
    })),
    edges: [
      ...labels.slice(1).map((_, i) => ({ from: "n0", to: `n${i + 1}` })),
      { from: "n1", to: "n2", label: "dipende da" },
    ],
  };
}

test("the Maps section lists maps by subject, searches, opens one in the shell and exports it", async () => {
  test.setTimeout(180_000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-maps-section-"));
  const saved = join(userData, "export.bin");
  const env = {
    PYXIS_E2E_SAVE: saved,
  };
  const app = await launchPyxis({ userData, env });
  try {
    const page = await app.firstWindow();
    await page.emulateMedia({ reducedMotion: "reduce" });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.getByRole("button", { name: "Salta" }).click();
    await fromChiediToExams(page);
    await page.evaluate(() => window.pyxis.invoke("plans.list", {}));

    // The header door opens the section. With no exam yet, the empty state sends the student to create one.
    await page.getByText("Mappe", { exact: true }).click();
    await expect(page).toHaveURL(/#\/maps$/);
    await expect(
      page.getByRole("heading", { name: "Ancora nessuna mappa" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Nuovo esame" }),
    ).toBeVisible();

    const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), {
      timeout: 10000,
    });
    seedSubjects(db, [{ id: "phys", name: "Fisica" }, { id: "chem", name: "Chimica" }]);
    seedPlan(db, {
      id: "p-phys",
      subjectId: "phys",
      title: "Meccanica",
      topics: [{ id: "t-motion", title: "Moto" }, { id: "t-forces", title: "Forze" }],
    });
    seedPlan(db, {
      id: "p-chem",
      subjectId: "chem",
      title: "Chimica generale",
      topics: [{ id: "t-atoms", title: "Atomi" }],
    });
    const insert = db.prepare(
      "INSERT INTO maps(id,plan_id,topic_id,graph_json,grounding,created_at) VALUES(?,?,?,?,'sources',1)",
    );
    const collection = (id: string, title: string, labels: string[]) =>
      JSON.stringify({
        version: 1,
        maps: [{ id, title, passageIds: ["x"], graph: graph(labels) }],
      });
    insert.run(
      "row-motion",
      "p-phys",
      "t-motion",
      collection("m-motion", "Moto rettilineo", [
        "Moto",
        "Velocità",
        "Accelerazione",
      ]),
    );
    insert.run(
      "row-atoms",
      "p-chem",
      "t-atoms",
      collection("m-atoms", "Struttura dell’atomo", [
        "Atomo",
        "Protoni",
        "Elettroni",
      ]),
    );
    db.close();

    await page.reload();
    await expect(
      page.getByRole("heading", { level: 2, name: "Fisica" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { level: 2, name: "Chimica" }),
    ).toBeVisible();
    await expect(page.getByRole("status")).toHaveText("2 mappe");

    const search = page.getByRole("textbox", { name: "Cerca nelle mappe" });
    await search.fill("velocita");
    await expect(page.getByRole("status")).toHaveText("1 mappa");
    await expect(
      page.getByRole("heading", { level: 3, name: "Moto rettilineo" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { level: 3, name: "Struttura dell’atomo" }),
    ).toHaveCount(0);
    await search.fill("zzzz");
    await expect(page.getByText("Nessuna mappa corrisponde.")).toBeVisible();
    await search.fill("");

    // A map opens inside the shell under Mappe, says which exam it belongs to, and Mappe leads back to the section.
    // Each map is a tile with a drawing of its branches; the whole tile opens it.
    const tile = page.getByRole("link", { name: /^Moto rettilineo Meccanica · Moto/ });
    await expect(tile.locator("svg rect")).toHaveCount(3);
    await tile.click();
    await expect(page).toHaveURL(
      /#\/plans\/p-phys\/map\/t-motion\?from=maps&map=m-motion$/,
    );
    await expect(page.locator(".react-flow__node")).toHaveCount(3);
    await expect(
      page.getByRole("heading", { level: 1, name: "Moto rettilineo" }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Apri l’esame Meccanica" }),
    ).toBeVisible();

    const exportAs = async (item: string) => {
      rmSync(saved, { force: true });
      await page.getByRole("button", { name: "Altro", exact: true }).click();
      await page.getByRole("menuitem", { name: item }).click();
      // The notice from the previous export may still show, so wait for the file itself.
      await expect
        .poll(() => existsSync(saved), { timeout: 30_000 })
        .toBe(true);
      await expect(page.getByText("File salvato")).toBeVisible();
      return readFileSync(saved);
    };
    const markdown = (await exportAs("Schema (Markdown)")).toString("utf8");
    expect(markdown).toBe(
      [
        "# Moto rettilineo",
        "",
        "Esame: Meccanica · Argomento: Moto",
        "",
        "- Moto",
        "  - Velocità",
        "  - Accelerazione",
        "",
        "## Collegamenti",
        "",
        "- Velocità → Accelerazione: *dipende da*",
        "",
      ].join("\n"),
    );
    const svg = (await exportAs("Mappa intera (SVG)")).toString("utf8");
    expect(svg).toMatch(/^<svg /);
    expect(svg).toContain(">Accelerazione</tspan>");
    expect(svg).toContain(">dipende da</tspan>");
    const pdf = await exportAs("Mappa e schema (PDF)");
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    // The drawing gets a page of its own size; the outline follows on A4.
    const boxes = new Set(
      [...pdf.toString("latin1").matchAll(/\/MediaBox \[([^\]]+)\]/g)].map(
        (match) => match[1]!.trim(),
      ),
    );
    expect(boxes.size).toBeGreaterThanOrEqual(2);

    const mapsDoor = page.getByRole("link", { name: /^Mappe/ });
    await expect(mapsDoor).toHaveAttribute("aria-current", "page");
    await mapsDoor.click();
    await expect(page).toHaveURL(/#\/maps$/);

    // A new map starts from an exam and a topic, and opens that topic's map page.
    await page.getByRole("button", { name: "Nuova mappa" }).click();
    const dialog = page.getByRole("dialog", { name: "Nuova mappa" });
    const choose = async (field: string, option: string) => {
      await dialog.getByLabel(field).click();
      await page
        .locator(
          `.ant-select-dropdown:visible .ant-select-item-option[title="${option}"]`,
        )
        .click();
    };
    await choose("Esame", "Meccanica");
    await choose("Argomento", "Forze");
    await dialog.getByRole("button", { name: "Continua" }).click();
    await expect(page).toHaveURL(/#\/plans\/p-phys\/map\/t-forces\?from=maps$/);
    await expect(
      page.getByRole("button", { name: "Crea mappe" }),
    ).toBeVisible();
    // Before a map exists the line under the title names the exam alone, with no dot left hanging after it.
    await expect(page.locator(".px-map-title p")).toHaveText("Meccanica");
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});
