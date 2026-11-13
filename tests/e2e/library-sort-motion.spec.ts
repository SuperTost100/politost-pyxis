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
import { drawSlowly } from "./slow-window";
import { saveShot } from "./shots";

type Box = { left: number; top: number; right: number; bottom: number };
/**
 * `row` is the file's row in "Da sistemare": `leaving` once its exit has started, `active` while it still works.
 * `exit` is the row's own animation of its height, as the page holds it: its length and the heights its keyframes give.
 */
type Exit = { duration: number; heights: Array<{ offset: number; height: number }> };
type Frame = {
  t: number;
  art: Box | null;
  row: Box | null;
  rowState: "active" | "leaving" | null;
  exit: Exit | null;
  card: Box | null;
  shelf: Box | null;
};

/** How long a row of "Da sistemare" takes to fade and close: `ROW_EXIT_MS` in LibraryShelf.tsx. */
const ROW_EXIT_MS = 420;

/** The recording ends once the page has been still for this many frames after the move. */
const STILL_FRAMES = 5;

/**
 * Chooses a subject for a file in "Da sistemare" and records the box of the file's cover picture on its shelf, the box
 * of its row and the box of the shelf. The boxes are in the window's coordinates, so a cover that flew in from the
 * wrong place shows as a frame outside its shelf.
 *
 * A frame is recorded at the moment of the choice, on every animation frame after it, and at every change of what is
 * on the page (the row starts to leave, the row is gone, the cover is there), so the start, the first sight of the
 * cover and the end are recorded however few frames a slow window draws. The number of frames between them is a
 * property of the machine, not of the app, and no check here depends on it.
 *
 * The recording starts inside the page, from the picker's own `change` event, so a slow test runner that takes long to
 * find and change the picker still records the whole move. It ends when the cover is on its shelf, the row is gone, no
 * finite animation is running and the cover has kept its box for STILL_FRAMES frames in a row, however long the file takes
 * to get there. If that never happens it fails with the frames it did record.
 */
async function sortAndRecord(page: Page, title: string, subjectId: string, subjectName: string): Promise<Frame[]> {
  await page.evaluate(
    ({ id, subject, stillFrames }) => {
      const box = (element: Element | null): Box | null => {
        if (!element) return null;
        const { left, top, right, bottom } = element.getBoundingClientRect();
        return { left, top, right, bottom };
      };
      const frames: Frame[] = [];
      const global = window as unknown as { frames: Frame[]; framesDone: boolean };
      global.frames = frames;
      global.framesDone = false;
      const picker = document.querySelector(`.px-unsorted-row[data-source-id="${id}"] select`);
      if (!picker) throw new Error(`no picker for ${id}`);
      picker.addEventListener(
        "change",
        () => {
          const start = performance.now();
          let covered = false;
          let still = 0;
          let finished = false;
          // The animation on the row that changes its height, read from the page and not from what a frame happened to draw.
          const exitOf = (row: Element | null): Exit | null => {
            for (const animation of row?.getAnimations() ?? []) {
              const effect = animation.effect as KeyframeEffect | null;
              const keyframes = (effect?.getKeyframes() ?? []).filter((keyframe) => keyframe.height !== undefined);
              if (!effect || keyframes.length === 0) continue;
              return {
                duration: Number(effect.getComputedTiming().duration),
                heights: keyframes.map((keyframe) => ({ offset: Number(keyframe.computedOffset), height: parseFloat(String(keyframe.height)) })),
              };
            }
            return null;
          };
          const sample = (): Frame => {
            const row = document.querySelector(`.px-unsorted-row[data-source-id="${id}"]`);
            const art = document.querySelector(`.px-shelf .px-cover[data-source-id="${id}"] .px-cover-art`);
            const frame: Frame = {
              t: performance.now() - start,
              art: box(art),
              row: box(row),
              rowState: row ? (row.hasAttribute("data-leaving") ? "leaving" : "active") : null,
              exit: exitOf(row),
              card: box(document.querySelector(".px-unsorted-card")),
              shelf: box(document.querySelector(`[data-subject-id="${subject}"] .px-shelf`)),
            };
            frames.push(frame);
            if (art) covered = true;
            return frame;
          };
          sample();
          // The page's own changes arrive before the frame that draws them, so the first sight of the cover is
          // recorded as it is when it appears, not as it is a frame later.
          const watcher = new MutationObserver(() => {
            if (finished) return;
            const last = frames.at(-1)!;
            const row = document.querySelector(`.px-unsorted-row[data-source-id="${id}"]`);
            const art = document.querySelector(`.px-shelf .px-cover[data-source-id="${id}"] .px-cover-art`);
            const rowState = row ? (row.hasAttribute("data-leaving") ? "leaving" : "active") : null;
            if (Boolean(art) !== Boolean(last.art) || rowState !== last.rowState) sample();
          });
          watcher.observe(document.body, { childList: true, subtree: true, attributes: true });
          const tick = () => {
            const before = frames.at(-1)!;
            const frame = sample();
            // Looping animations (a spinner) never end, so they are not waited for.
            const running = document
              .getAnimations()
              .some((a) => a.playState === "running" && a.effect?.getComputedTiming().iterations !== Infinity);
            const unmoved = JSON.stringify(frame.art) === JSON.stringify(before.art);
            still = covered && !frame.row && !running && unmoved ? still + 1 : 0;
            if (still >= stillFrames) {
              finished = true;
              watcher.disconnect();
              global.framesDone = true;
            } else requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        },
        { once: true },
      );
    },
    { id: title, subject: subjectId, stillFrames: STILL_FRAMES },
  );
  await page
    .getByRole("region", { name: "Da sistemare" })
    .getByRole("combobox", { name: `Materia di ${title}` })
    .selectOption({ label: subjectName });
  const recorded = () => page.evaluate(() => (window as unknown as { frames: Frame[] }).frames);
  try {
    await expect.poll(() => page.evaluate(() => (window as unknown as { framesDone: boolean }).framesDone), { timeout: 60_000 }).toBe(true);
  } catch (error) {
    throw new Error(`${title} was not on its shelf with its row gone and the page still after 60 s:\n${describeFrames(await recorded())}`, {
      cause: error,
    });
  }
  return recorded();
}

const describeFrames = (frames: Frame[]) =>
  frames
    .map(
      (f) =>
        `${f.t.toFixed(0)}ms art=${f.art ? `${f.art.left.toFixed(0)},${f.art.top.toFixed(0)} ${(f.art.right - f.art.left).toFixed(0)}w` : "-"} ` +
        `row=${f.row ? `${f.row.left.toFixed(0)},${f.row.top.toFixed(0)} ${(f.row.bottom - f.row.top).toFixed(0)}h ${f.rowState} ${f.exit ? `exit ${f.exit.duration}ms ${f.exit.heights.map((h) => `${h.offset}:${h.height}`).join(" ")}` : "no exit"}` : "-"}`,
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

/** One layout of the sort motion: sorts the file `index` names into a subject and checks every recorded frame. */
async function checkSort(page: Page, subjects: Array<{ id: string; name: string }>, index: number, config: (typeof configs)[number]) {
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
  expect(onShelf.length, `no frame saw the cover:\n${where}`).toBeGreaterThan(0);
  const slack = 2;
  for (const frame of onShelf) {
    const { art, shelf } = frame;
    expect(shelf, where).not.toBeNull();
    expect(art!.left, where).toBeGreaterThanOrEqual(shelf!.left - slack);
    expect(art!.right, where).toBeLessThanOrEqual(shelf!.right + slack);
    expect(art!.top, where).toBeGreaterThanOrEqual(shelf!.top - slack);
    expect(art!.bottom, where).toBeLessThanOrEqual(shelf!.bottom + slack);
  }
  // It grows: the first sight of it is smaller than the last, around the same centre on the shelf (the shelf itself
  // moves up while the row above it closes, so the centre is measured from the shelf's corner).
  const centre = ({ art, shelf }: Frame) => [(art!.left + art!.right) / 2 - shelf!.left, (art!.top + art!.bottom) / 2 - shelf!.top];
  const first = onShelf[0]!;
  const last = onShelf.at(-1)!;
  expect(first.art!.right - first.art!.left, where).toBeLessThan((last.art!.right - last.art!.left) * 0.95);
  expect(Math.abs(centre(first)[0]! - centre(last)[0]!), where).toBeLessThan(slack);
  expect(Math.abs(centre(first)[1]! - centre(last)[1]!), where).toBeLessThan(slack);

  // The row stays where it was in its list and closes: same left and right edge, top never above its start, height
  // shrinking to nothing. It is measured from the list's corner, since focus can scroll the page to the new cover.
  // The first frame is taken at the choice itself, so the row is in it whatever the window draws after.
  const rowFrames = frames.filter((frame) => frame.row && frame.card);
  expect(rowFrames.length, `no frame saw the row:\n${where}`).toBeGreaterThan(0);
  const startTop = originalRow.y - originalCard.y;
  for (const { row: box, card } of rowFrames) {
    expect(box!.left - card!.left, where).toBeCloseTo(originalRow.x - originalCard.x, 0);
    expect(box!.right - card!.left, where).toBeCloseTo(originalRow.x + originalRow.width - originalCard.x, 0);
    expect(box!.top - card!.top, where).toBeGreaterThanOrEqual(startTop - slack);
    expect(box!.bottom - card!.top, where).toBeLessThanOrEqual(startTop + originalRow.height + slack);
  }
  const heights = rowFrames.map(({ row: box }) => box!.bottom - box!.top);
  // Never taller than the frame before, to within the rounding of a box's edges.
  heights.forEach((height, at) => {
    if (at > 0) expect(height, where).toBeLessThanOrEqual(heights[at - 1]! + 0.5);
  });
  // It closes: from the moment it starts to leave, the row has an animation of its height that runs from the height it
  // had to nothing in the time the Library gives a row's exit. This is read from the animation, so it holds however few
  // frames a slow window drew, and a row that only fades or is removed in one step does not pass.
  const leaving = rowFrames.filter((frame) => frame.rowState === "leaving");
  expect(leaving.length, `no frame saw the row leave:\n${where}`).toBeGreaterThan(0);
  for (const { exit } of leaving) {
    expect(exit, `the leaving row has no animation of its height:\n${where}`).not.toBeNull();
    expect(exit!.duration, where).toBe(ROW_EXIT_MS);
    const offsets = exit!.heights.map((step) => step.offset);
    expect([offsets[0], offsets.at(-1)], where).toEqual([0, 1]);
    expect(Math.abs(exit!.heights[0]!.height - originalRow.height), where).toBeLessThanOrEqual(1);
    expect(exit!.heights.at(-1)!.height, where).toBe(0);
    exit!.heights.forEach((step, at) => {
      if (at > 0) expect(step.height, where).toBeLessThanOrEqual(exit!.heights[at - 1]!.height);
    });
  }
  // Focus went on with the file, to the next row's choice or the new cover, and was not left on the row that closed.
  const focus = await page.evaluate(() => ({
    onPage: document.activeElement !== document.body,
    inLeaving: Boolean(document.activeElement?.closest("[data-leaving]")),
  }));
  expect(focus, where).toEqual({ onPage: true, inLeaving: false });
  if (index === 0) await saveShot(page, "library-sort-motion/landed.png");
}

/**
 * Starts the app with a profile, the two subjects and the seeded files, and opens the Library in Italian. With `fps` the
 * window draws that many frames a second at most, as a hidden window on a busy Mac runner does.
 */
async function openLibrary(prefix: string, env: Record<string, string> = {}, fps?: number) {
  const userData = mkdtempSync(join(tmpdir(), prefix));
  const app = await launchPyxis({ userData, env });
  const page = await app.firstWindow();
  if (fps) await drawSlowly(page, fps);
  await page.getByRole("button", { name: "Salta" }).click();
  await fromChiediToExams(page);
  const subjects: Array<{ id: string; name: string }> = [];
  for (const name of ["Analisi 1", "Fisica 2"])
    subjects.push(await page.evaluate((name) => window.pyxis.invoke("subjects.add", { name }), name));
  seedLibrary(userData, subjects);
  return { app, page, subjects, userData };
}

test("A file chosen a subject in Da sistemare grows on its shelf where it lands, and its row closes where it was", async () => {
  test.setTimeout(240_000);
  const { app, page, subjects, userData } = await openLibrary("pyxis-sort-motion-");
  try {
    for (const [index, config] of configs.entries()) await checkSort(page, subjects, index, config);
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});

test("The same holds on a processor four times slower, where finding and changing the picker takes long", async () => {
  test.setTimeout(240_000);
  const { app, page, subjects, userData } = await openLibrary("pyxis-sort-slow-");
  try {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
    for (const index of [0, configs.length - 1]) await checkSort(page, subjects, index, configs[index]!);
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});

test("The same holds in a window that draws five frames a second, where the move is seen in a few frames", async () => {
  test.setTimeout(240_000);
  const { app, page, subjects, userData } = await openLibrary("pyxis-sort-frames-", {}, 5);
  try {
    for (const index of [0, configs.length - 1]) await checkSort(page, subjects, index, configs[index]!);
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});

test("A sorted file does not come back to Da sistemare while the list of files is still on its way", async () => {
  test.setTimeout(120_000);
  // The list of files is held back for 1.5 seconds, which is longer than the row takes to close (420 ms).
  const { app, page, subjects, userData } = await openLibrary("pyxis-sort-late-", { PYXIS_E2E_READ_DELAY: "sources.list=1500" });
  try {
    await page.setViewportSize({ width: 1280, height: 832 });
    await toLibrary(page);
    await expect(page.locator('.px-unsorted-row[data-source-id="Alfa"]')).toBeVisible({ timeout: 30_000 });
    const frames = await sortAndRecord(page, "Alfa", subjects[0]!.id, subjects[0]!.name);
    const where = describeFrames(frames);
    const states = frames.map((frame) => frame.rowState);
    const leavingAt = frames.find((frame) => frame.rowState === "leaving")?.t;
    const coverAt = frames.find((frame) => frame.art)?.t;
    expect(leavingAt, `the row never started to leave:\n${where}`).toBeDefined();
    // The move was accepted, and the answer with the new list came later than the row's exit took.
    expect(coverAt! - leavingAt!, `the list arrived before the row had closed:\n${where}`).toBeGreaterThan(450);
    // From its exit on, the row is never again a row that works.
    expect(states.slice(states.indexOf("leaving")), where).not.toContain("active");
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});

// The window draws as often as it likes, and at five frames a second: the cover and the row are checked in whatever
// frames it draws.
for (const fps of [undefined, 5]) {
  test(`With reduced motion the file is on its shelf and its row gone at once${fps ? ` in a window that draws ${fps} frames a second` : ""}`, async () => {
    test.setTimeout(120_000);
    const userData = mkdtempSync(join(tmpdir(), "pyxis-sort-still-"));
    const app = await launchPyxis({ userData });
    try {
      const page = await app.firstWindow();
      await page.emulateMedia({ reducedMotion: "reduce" });
      if (fps) await drawSlowly(page, fps);
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
      // From the first frame in which the cover exists, it is at its final place and size and stays there. How many
      // frames the window drew is not checked, but at least one has to have seen the cover.
      const onShelf = frames.filter((frame) => frame.art);
      expect(onShelf.length, `no frame saw the cover:\n${where}`).toBeGreaterThan(0);
      const final = onShelf.at(-1)!.art!;
      for (const { art } of onShelf) expect([art!.left, art!.top, art!.right, art!.bottom], where).toEqual([final.left, final.top, final.right, final.bottom]);
      // The row is gone in the frame in which the cover first exists, and it never closes by degrees: every frame that
      // saw it saw it whole and working.
      expect(frames.filter((frame) => frame.row && frame.art).length, where).toBe(0);
      const rows = frames.filter((frame) => frame.row);
      expect(rows.length, `no frame saw the row:\n${where}`).toBeGreaterThan(0);
      const height = (frame: Frame) => frame.row!.bottom - frame.row!.top;
      for (const frame of rows) {
        expect(frame.rowState, where).toBe("active");
        expect(height(frame), where).toBe(height(rows[0]!));
      }
    } finally {
      await app.close();
      removeTestFolder(userData);
    }
  });
}
