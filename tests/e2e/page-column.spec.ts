import { expect, test, type Page } from "@playwright/test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { launchPyxis } from "./app-under-test";
import { removeTestFolder } from "./cleanup";
import { animationsSettled } from "./settled";
import { seedPlan, seedSource, seedSubjects } from "./seed";
import { radialFixtures, storedGraph } from "../fixtures/maps";

/**
 * Every page of the shell sits in the same column: its back control, title, first line and page menu land on the same x
 * on every page, at 1280 and at 960, with the sidebar open and folded, and with large text.
 */

type Seen = {
  /** The arrow of the back control above the title, which hangs to the left of its padding. */
  back: number | null;
  title: number | null;
  titleText: string | null;
  /** The first line under the title (its lead), where the page has one. */
  lead: number | null;
  /** The right edge of the dots that open the page's own menu, where the page has one. */
  menuRight: number | null;
  /** The right edge of the last control on the title's line: the page's menu or its main action. */
  headRight: number | null;
  /** The column the page sits in: where its content starts and ends. */
  columnLeft: number;
  columnRight: number;
  scrollWidth: number;
  innerWidth: number;
};

/** Where each page's parts sit, from the first heading in the page. */
async function measure(page: Page): Promise<Seen> {
  return page.evaluate(() => {
    const visible = (el: Element | null): el is HTMLElement => {
      if (!el) return false;
      const box = el.getBoundingClientRect();
      return box.width > 0 && box.height > 0;
    };
    const main = document.querySelector("main")!;
    const first = (selector: string) => [...main.querySelectorAll(selector)].find(visible) ?? null;
    const back = first(".px-back.is-page");
    const arrow = back?.querySelector("svg") ?? null;
    // Settings names the page in its list, and the open section has a title of its own.
    const title = first(".px-settings-nav h2") ?? first("h1");
    const head = title?.closest("[class*='head']") ?? title?.parentElement ?? null;
    const lead = head ? ([...head.querySelectorAll("p")].find(visible) ?? null) : null;
    const dots = first('button[aria-label^="Altro su"]');
    const band = title?.getBoundingClientRect();
    const onTitleLine = [...main.querySelectorAll("button, a")].filter((el) => {
      if (!visible(el) || el.closest(".px-back")) return false;
      const box = el.getBoundingClientRect();
      const middle = (box.top + box.bottom) / 2;
      return band !== undefined && middle >= band.top - 4 && middle <= band.bottom + 4;
    });
    const column = main.getBoundingClientRect();
    return {
      back: arrow ? arrow.getBoundingClientRect().left : null,
      title: title ? title.getBoundingClientRect().left : null,
      titleText: first("h1")?.textContent ?? null,
      lead: lead ? lead.getBoundingClientRect().left : null,
      menuRight: dots ? dots.getBoundingClientRect().right : null,
      headRight: onTitleLine.length && !first(".px-settings-nav h2") ? Math.max(...onTitleLine.map((el) => el.getBoundingClientRect().right)) : null,
      columnLeft: column.left,
      columnRight: column.right,
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    };
  });
}

/** The pages of the shell with a head: a name for the report, the address, and the heading that tells the page has loaded. */
const PAGES: Array<[string, string, string]> = [
  ["Esami", "/exams", "Esami"],
  ["Pagina di un esame", "/plans/p-phys", "Fisica 1"],
  ["Impostazioni dell'esame", "/plans/p-phys/settings", "Impostazioni dell'esame"],
  ["Materiale dell'esame", "/plans/p-phys/sources", "Materiale"],
  ["Mappe", "/maps", "Mappe"],
  ["Mappa, dall'esame", "/plans/p-phys/map/t-dyn", "Dinamica"],
  ["Mappa, da Mappe", "/maps/s-phys?from=maps&map=m-entry", "Fisica"],
  ["Flashcard", "/flashcards", "Flashcard"],
  ["Tutte le flashcard", "/flashcards/all", "Tutte le flashcard"],
  ["Libreria", "/exams/library", "Libreria"],
  ["Quaderno degli errori", "/exams/mistakes", "Quaderno degli errori"],
  ["Esame condiviso", "/exams/get", "Apri un esame condiviso"],
  ["Impostazioni", "/settings", "Profilo"],
  ...(
    [
      ["profile", "Profilo"],
      ["engines", "Strumenti AI"],
      ["tutor", "Studio"],
      ["reading", "Studio"],
      ["flashcards", "Studio"],
      ["reminders", "Studio"],
      ["appearance", "Aspetto e lingua"],
      ["language", "Aspetto e lingua"],
      ["data", "Dati e privacy"],
      ["privacy", "Dati e privacy"],
      ["updates", "Informazioni"],
      ["about", "Informazioni"],
    ] as const
  ).map(([section, heading]): [string, string, string] => [`Impostazioni: ${section}`, `/settings/${section}`, heading]),
];

function seed(db: DatabaseSync) {
  seedSubjects(db, [
    { id: "s-phys", name: "Fisica", position: 0 },
    { id: "s-chem", name: "Chimica", position: 1 },
  ]);
  seedPlan(db, {
    id: "p-phys",
    subjectId: "s-phys",
    title: "Fisica 1",
    language: "it",
    target: 0.75,
    examAt: Date.now() + 30 * 86_400_000,
    topics: [
      { id: "t-dyn", title: "Dinamica" },
      { id: "t-kin", title: "Cinematica" },
    ],
  });
  seedPlan(db, { id: "p-chem", subjectId: "s-chem", title: "Chimica generale", language: "it", topics: [{ id: "t-atoms", title: "Atomi" }] });
  seedSource(db, { id: "src-1", title: "Fisica 1, dispense", kind: "notes", subjectId: "s-phys", document: { id: "doc-1" } });
  db.prepare("INSERT INTO plan_sources(plan_id,source_id) VALUES('p-phys','src-1')").run();
  db.exec(`
    INSERT INTO cards(id,plan_id,topic_id,front,back,seed_key,grounding,created_at) VALUES
      ('c-1','p-phys','t-dyn','Perché un corpo accelera?','Perché agisce una forza.','k1','sources',1),
      ('c-2','p-chem','t-atoms','Numero atomico?','Protoni nel nucleo.','k2','sources',2);
  `);
  const graph = storedGraph(radialFixtures.twelveLeaves);
  db.prepare("INSERT INTO maps(id,plan_id,topic_id,graph_json,grounding,created_at) VALUES('m-1','p-phys','t-dyn',?,'sources',1)").run(
    JSON.stringify({ version: 1, maps: [{ id: "m-entry", title: "Dinamica", passageIds: [], graph }] }),
  );
  db.prepare("INSERT INTO maps(id,subject_id,graph_json,grounding,created_at) VALUES('m-2','s-phys',?,'sources',1)").run(
    JSON.stringify({ version: 1, maps: [{ id: "m-entry", title: "Fisica", passageIds: [], graph }] }),
  );
}

type Setup = { name: string; width: number; fold: boolean; large: boolean };
const SETUPS: Setup[] = [
  { name: "1280 open", width: 1280, fold: false, large: false },
  { name: "1280 folded", width: 1280, fold: true, large: false },
  { name: "1280 open, large text", width: 1280, fold: false, large: true },
  // Below 1100 px the sidebar folds by itself, so 960 has no open one.
  { name: "960 folded", width: 960, fold: true, large: false },
  { name: "960 folded, large text", width: 960, fold: true, large: true },
];

test("every page of the shell starts in the same place and ends at the same edge", async () => {
  test.setTimeout(600_000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-page-column-"));
  const app = await launchPyxis({ userData });
  const report: Record<string, Record<string, Seen>> = {};
  const failures: string[] = [];
  try {
    const page = await app.firstWindow();
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.getByRole("button", { name: "Salta" }).click({ timeout: 90_000 });
    await page.evaluate(() => window.pyxis.invoke("plans.list", {}));
    await page.evaluate(() => localStorage.setItem("pyxis.lang", "it"));
    // PYXIS_COLUMN_THEME=dark takes the pictures in the dark theme.
    const theme = process.env.PYXIS_COLUMN_THEME === "dark" ? "dark" : "light";
    await page.evaluate((theme) => window.pyxis.setAppearance(theme), theme);
    const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), { timeout: 10000 });
    seed(db);
    db.close();

    const shots = process.env.PYXIS_COLUMN_SHOTS;
    for (const setup of SETUPS) {
      await page.evaluate(
        async ({ fold, large }) => {
          localStorage.setItem("pyxis.side", fold ? "folded" : "open");
          await window.pyxis.invoke("profile.save", { dyslexia: false, textSize: large ? "lg" : "md" });
        },
        { fold: setup.fold, large: setup.large },
      );
      await page.setViewportSize({ width: setup.width, height: 800 });
      await page.reload();
      const seen: Record<string, Seen> = {};
      for (const [name, route, heading] of PAGES) {
        await page.evaluate((route) => (location.hash = route), route);
        await expect(page.locator("main h1:visible").first()).toHaveText(heading);
        // The page's own data is in: a skeleton has the page's width, but its head is not yet whole.
        await expect(page.locator("main .px-skeleton")).toHaveCount(0);
        if (name.startsWith("Mappa,")) await expect(page.locator(".react-flow__node").first()).toBeVisible();
        await page.evaluate(() => document.fonts.ready);
        // A page that stays mounted between two addresses (Settings) keeps the scroll of the one before.
        await page.evaluate(() => window.scrollTo(0, 0));
        await animationsSettled(page);
        seen[name] = await measure(page);
        if (shots) {
          mkdirSync(shots, { recursive: true });
          const slug = route.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "");
          await page.screenshot({ path: join(shots, `${setup.width}${setup.fold ? "f" : "o"}${setup.large ? "L" : ""}-${slug}${theme === "dark" ? "-dark" : ""}.png`) });
        }
      }
      report[setup.name] = seen;

      // Each part lands on one x across the pages, and nothing runs sideways.
      const across = (part: "back" | "title" | "lead" | "headRight") => {
        const values = Object.entries(seen).flatMap(([name, value]) => (value[part] === null ? [] : [[name, Math.round(value[part]!)] as const]));
        for (const [name, x] of values)
          if (Math.abs(x - values[0][1]) > 1) failures.push(`${setup.name}: ${part} of ${name} at ${x}, ${values[0][0]} at ${values[0][1]}`);
      };
      for (const part of ["back", "title", "lead", "headRight"] as const) across(part);
      for (const [name, value] of Object.entries(seen)) {
        // The page starts where its column does, its way back and its title on that line, and its head ends at the column's end.
        if (value.back !== null && Math.abs(value.back - value.columnLeft) > 1) failures.push(`${setup.name}: back of ${name} at ${Math.round(value.back)}, its column at ${Math.round(value.columnLeft)}`);
        if (Math.abs(value.title! - value.columnLeft) > 1) failures.push(`${setup.name}: title of ${name} at ${Math.round(value.title!)}, its column at ${Math.round(value.columnLeft)}`);
        if (value.headRight !== null && Math.abs(value.headRight - value.columnRight) > 1) failures.push(`${setup.name}: head of ${name} ends at ${Math.round(value.headRight)}, its column at ${Math.round(value.columnRight)}`);
        // Wide windows have room for the whole column; narrower ones shrink it and keep it as it is.
        if (setup.width >= 1280 && Math.round(value.columnRight - value.columnLeft) !== 920)
          failures.push(`${setup.name}: ${name} is ${Math.round(value.columnRight - value.columnLeft)}px wide, not 920`);
        if (value.scrollWidth > value.innerWidth + 1) failures.push(`${setup.name}: ${name} scrolls sideways`);
      }
    }
  } finally {
    if (process.env.PYXIS_COLUMN_REPORT) {
      mkdirSync(join(process.env.PYXIS_COLUMN_REPORT, ".."), { recursive: true });
      writeFileSync(process.env.PYXIS_COLUMN_REPORT, JSON.stringify(report, null, 1));
    }
    await app.close();
    removeTestFolder(userData);
  }
  expect(failures).toEqual([]);
});
