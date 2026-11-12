import { expect, test, type Page } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { launchPyxis } from "./app-under-test";
import { removeTestFolder } from "./cleanup";
import { fromChiediToExams, toLibrary } from "./doors";
import { seedSource } from "./seed";
import { atRest } from "./settled";
import { saveShot } from "./shots";

type Box = { left: number; top: number; right: number; bottom: number };
type Frame = { t: number; art: Box | null; row: Box | null; card: Box | null; shelf: Box | null };

/**
 * Chooses a subject for a file in "Da sistemare" and records, on every animation frame for a second, the box of the
 * file's cover picture on its shelf, the box of its row and the box of the shelf. The boxes are in the window's
 * coordinates, so a cover that flew in from the wrong place shows as a frame outside its shelf.
 */
async function sortAndRecord(page: Page, title: string, subjectId: string, subjectName: string): Promise<Frame[]> {
  await page.evaluate(
    ({ id, subject }) => {
      const box = (element: Element | null): Box | null => {
        if (!element) return null;
        const { left, top, right, bottom } = element.getBoundingClientRect();
        return { left, top, right, bottom };
      };
      const frames: Frame[] = [];
      const start = performance.now();
      const global = window as unknown as { frames: Frame[]; framesDone: boolean };
      global.frames = frames;
      global.framesDone = false;
      const tick = () => {
        const t = performance.now() - start;
        frames.push({
          t,
          art: box(document.querySelector(`.px-shelf .px-cover[data-source-id="${id}"] .px-cover-art`)),
          row: box(document.querySelector(`.px-unsorted-row[data-source-id="${id}"]`)),
          card: box(document.querySelector(".px-unsorted-card")),
          shelf: box(document.querySelector(`[data-subject-id="${subject}"] .px-shelf`)),
        });
        if (t < 1000) requestAnimationFrame(tick);
        else global.framesDone = true;
      };
      requestAnimationFrame(tick);
    },
    { id: title, subject: subjectId },
  );
  await page
    .getByRole("region", { name: "Da sistemare" })
    .getByRole("combobox", { name: `Materia di ${title}` })
    .selectOption({ label: subjectName });
  await expect.poll(() => page.evaluate(() => (window as unknown as { framesDone: boolean }).framesDone)).toBe(true);
  return page.evaluate(() => (window as unknown as { frames: Frame[] }).frames);
}

const describeFrames = (frames: Frame[]) =>
  frames
    .map(
      (f) =>
        `${f.t.toFixed(0)}ms art=${f.art ? `${f.art.left.toFixed(0)},${f.art.top.toFixed(0)} ${(f.art.right - f.art.left).toFixed(0)}w` : "-"} ` +
        `row=${f.row ? `${f.row.left.toFixed(0)},${f.row.top.toFixed(0)} ${(f.row.bottom - f.row.top).toFixed(0)}h` : "-"}`,
    )
    .join("\n");

/** Files waiting in "Da sistemare", and subjects with shelves: one short, one with fourteen files, so a landing is behind "Mostra tutti". */
function seedLibrary(userData: string, subjects: Array<{ id: string; name: string }>) {
  const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), { timeout: 10_000 });
  for (let n = 1; n <= 3; n++) seedSource(db, { id: `analisi-${n}`, title: `Dispensa ${n}`, subjectId: subjects[0]!.id });
  for (let n = 1; n <= 14; n++)
    seedSource(db, { id: `fisica-${n}`, title: `Appunti ${String(n).padStart(2, "0")}`, subjectId: subjects[1]!.id });
  for (const title of ["Alfa", "Beta", "Gamma", "Delta", "Epsilon", "Zeta"]) seedSource(db, { id: title, title });
  db.close();
}

const configs = [
  { name: "1280 with the sidebar open", width: 1280, folded: false, darwin: false, scroll: false, subject: 0 },
  { name: "1280 with the sidebar folded", width: 1280, folded: true, darwin: false, scroll: false, subject: 0 },
  { name: "960", width: 960, folded: true, darwin: false, scroll: false, subject: 0 },
  { name: "1280 on the Mac's wider sidebar", width: 1280, folded: false, darwin: true, scroll: false, subject: 0 },
  { name: "1280 scrolled", width: 1280, folded: false, darwin: false, scroll: true, subject: 0 },
  { name: "960 behind Mostra tutti", width: 960, folded: true, darwin: false, scroll: false, subject: 1 },
] as const;

test("A file chosen a subject in Da sistemare grows on its shelf where it lands, and its row closes where it was", async () => {
  test.setTimeout(240_000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-sort-motion-"));
  const app = await launchPyxis({ userData });
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Salta" }).click();
    await fromChiediToExams(page);
    const subjects: Array<{ id: string; name: string }> = [];
    for (const name of ["Analisi 1", "Fisica 2"])
      subjects.push(await page.evaluate((name) => window.pyxis.invoke("subjects.add", { name }), name));
    seedLibrary(userData, subjects);

    for (const [index, config] of configs.entries()) {
      const title = ["Alfa", "Beta", "Gamma", "Delta", "Epsilon", "Zeta"][index]!;
      await page.setViewportSize({ width: config.width, height: 832 });
      await page.evaluate((folded) => localStorage.setItem("pyxis.side", folded ? "folded" : "open"), config.folded);
      await page.evaluate((darwin) => {
        if (darwin) document.documentElement.dataset.platform = "darwin";
        else delete document.documentElement.dataset.platform;
      }, config.darwin);
      await page.evaluate(() => {
        location.hash = "/exams";
      });
      await toLibrary(page);
      const subject = subjects[config.subject]!;
      const row = page.locator(`.px-unsorted-row[data-source-id="${title}"]`);
      await expect(row).toBeVisible();
      if (config.scroll) await page.getByRole("region", { name: new RegExp(`^${subject.name} `) }).scrollIntoViewIfNeeded();
      // The window was just resized or scrolled: the row's start is measured once it stops moving.
      await atRest(row);
      const originalRow = (await row.boundingBox())!;
      const originalCard = (await page.locator(".px-unsorted-card").boundingBox())!;

      const frames = await sortAndRecord(page, title, subject.id, subject.name);
      const where = `${config.name}:\n${describeFrames(frames)}`;

      // The cover is on its shelf for every frame it exists, from the first, so it did not fly in from elsewhere.
      const onShelf = frames.filter((frame) => frame.art);
      expect(onShelf.length, where).toBeGreaterThan(3);
      const slack = 2;
      for (const frame of onShelf) {
        const { art, shelf } = frame;
        expect(shelf, where).not.toBeNull();
        expect(art!.left, where).toBeGreaterThanOrEqual(shelf!.left - slack);
        expect(art!.right, where).toBeLessThanOrEqual(shelf!.right + slack);
        expect(art!.top, where).toBeGreaterThanOrEqual(shelf!.top - slack);
        expect(art!.bottom, where).toBeLessThanOrEqual(shelf!.bottom + slack);
      }
      // It grows: the first frame is smaller than the last, around the same centre on the shelf (the shelf itself moves up
      // while the row above it closes, so the centre is measured from the shelf's corner).
      const centre = ({ art, shelf }: Frame) => [(art!.left + art!.right) / 2 - shelf!.left, (art!.top + art!.bottom) / 2 - shelf!.top];
      const first = onShelf[0]!;
      const last = onShelf.at(-1)!;
      expect(first.art!.right - first.art!.left, where).toBeLessThan((last.art!.right - last.art!.left) * 0.95);
      expect(Math.abs(centre(first)[0]! - centre(last)[0]!), where).toBeLessThan(slack);
      expect(Math.abs(centre(first)[1]! - centre(last)[1]!), where).toBeLessThan(slack);

      // The row stays where it was in its list and closes: same left and right edge, top never above its start, height
      // shrinking to nothing. It is measured from the list's corner, since focus can scroll the page to the new cover.
      const rowFrames = frames.filter((frame) => frame.row && frame.card);
      expect(rowFrames.length, where).toBeGreaterThan(3);
      const startTop = originalRow.y - originalCard.y;
      for (const { row: box, card } of rowFrames) {
        expect(box!.left - card!.left, where).toBeCloseTo(originalRow.x - originalCard.x, 0);
        expect(box!.right - card!.left, where).toBeCloseTo(originalRow.x + originalRow.width - originalCard.x, 0);
        expect(box!.top - card!.top, where).toBeGreaterThanOrEqual(startTop - slack);
        expect(box!.bottom - card!.top, where).toBeLessThanOrEqual(startTop + originalRow.height + slack);
      }
      const heights = rowFrames.map(({ row: box }) => box!.bottom - box!.top);
      expect(Math.min(...heights), where).toBeLessThan(originalRow.height / 2);
      // Never taller than the frame before, to within the rounding of a box's edges.
      heights.forEach((height, at) => {
        if (at > 0) expect(height, where).toBeLessThanOrEqual(heights[at - 1]! + 0.5);
      });
      if (index === 0) await saveShot(page, "library-sort-motion/landed.png");
    }
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});

test("With reduced motion the file is on its shelf and its row gone at once", async () => {
  test.setTimeout(120_000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-sort-still-"));
  const app = await launchPyxis({ userData });
  try {
    const page = await app.firstWindow();
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.getByRole("button", { name: "Salta" }).click();
    await fromChiediToExams(page);
    const subjects: Array<{ id: string; name: string }> = [];
    for (const name of ["Analisi 1", "Fisica 2"])
      subjects.push(await page.evaluate((name) => window.pyxis.invoke("subjects.add", { name }), name));
    seedLibrary(userData, subjects);
    await page.setViewportSize({ width: 1280, height: 832 });
    await toLibrary(page);
    await expect(page.locator('.px-unsorted-row[data-source-id="Alfa"]')).toBeVisible();
    const frames = await sortAndRecord(page, "Alfa", subjects[0]!.id, subjects[0]!.name);
    const where = describeFrames(frames);
    const onShelf = frames.filter((frame) => frame.art);
    expect(onShelf.length, where).toBeGreaterThan(3);
    const first = onShelf[0]!.art!;
    const last = onShelf.at(-1)!.art!;
    expect([first.left, first.top, first.right, first.bottom], where).toEqual([last.left, last.top, last.right, last.bottom]);
    expect(frames.filter((frame) => frame.row && frame.art).length, where).toBe(0);
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});
