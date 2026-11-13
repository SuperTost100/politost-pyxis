import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { launchPyxis } from "./app-under-test";
import { removeTestFolder } from "./cleanup";
import { fromChiediToExams } from "./doors";
import { seedSubjects } from "./seed";
import { atRest } from "./settled";
import { SHOTS } from "./shots";
import { radialFixtures, storedGraph } from "../fixtures/maps";

/**
 * Esporta > Solo quello che vedi saves the canvas as the window draws it. The picture is checked against a screenshot of
 * the same canvas taken with the page's own controls hidden, and against the links the page draws.
 */

type Theme = "light" | "dark";
type Layout = "tree" | "radial";

/** What the page draws, read before the export: the canvas, the links to look for and the controls that must be gone. */
type Probes = {
  canvas: { width: number; height: number; ratio: number; background: [number, number, number] };
  link: { color: [number, number, number]; points: Array<{ x: number; y: number }> };
  controls: Array<{ what: string; x: number; y: number; width: number; height: number }>;
};

async function openMap(page: Page, layout: Layout, theme: Theme) {
  await page.evaluate((id) => {
    location.hash = `/maps/cinema?from=maps&map=${id}`;
  }, layout);
  await page.reload();
  await page.evaluate((theme) => window.pyxis.setAppearance(theme), theme);
  await expect(page.locator(".react-flow__node").first()).toBeVisible();
  await mapAtRest(page);
}

/** Waits until the map has stopped moving and its view and boxes hold still. */
async function mapAtRest(page: Page) {
  await expect(page.locator(".px-map-canvas[data-moving]")).toHaveCount(0);
  let seen = "";
  await expect
    .poll(async () => {
      const next = await page.locator(".px-map-canvas").evaluate((canvas) =>
        JSON.stringify([
          getComputedStyle(canvas.querySelector(".react-flow__viewport")!).transform,
          [...canvas.querySelectorAll(".react-flow__node")].map((node) => {
            const box = node.getBoundingClientRect();
            return [box.x, box.y, box.width, box.height];
          }),
        ]),
      );
      const still = next === seen;
      seen = next;
      return still;
    })
    .toBe(true);
  await atRest(page.locator(".px-map-canvas"));
}

/**
 * Reads what the page draws, in the canvas's own CSS pixels. Only the part of the canvas inside the window counts: the
 * export saves what the student sees, and the canvas can run past the window's edge: below it at 200% in the shorter
 * window of a Mac runner, past its right side in the narrower one of a Windows runner. Each link is looked for at nine
 * points along it, so a small window still leaves enough of them in the open.
 */
function readProbes(page: Page): Promise<Probes> {
  return page.evaluate(() => {
    const canvas = document.querySelector<HTMLElement>(".px-map-canvas")!;
    const box = canvas.getBoundingClientRect();
    // The window's own size in CSS pixels, unrounded: at 200% a window 689 pixels tall shows 344.5 of them, and
    // `innerHeight` says 344.
    const view = visualViewport!;
    const at = DOMRect.fromRect({
      x: Math.max(0, box.left),
      y: Math.max(0, box.top),
      width: Math.min(view.width, box.right) - Math.max(0, box.left),
      height: Math.min(view.height, box.bottom) - Math.max(0, box.top),
    });
    const rgb = (value: string) => (value.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number) as [number, number, number];
    const inside = (box: DOMRect, x: number, y: number, margin: number) =>
      x > box.left - margin && x < box.right + margin && y > box.top - margin && y < box.bottom + margin;
    const covers = [...canvas.querySelectorAll(".px-concept-node, .px-map-strip, .px-concept-fold")].map((el) =>
      el.getBoundingClientRect(),
    );
    const paths = [...canvas.querySelectorAll<SVGPathElement>(".px-tree-edge .react-flow__edge-path")];
    const points: Array<{ x: number; y: number }> = [];
    for (const path of paths) {
      const length = path.getTotalLength();
      const matrix = path.getScreenCTM()!;
      for (const share of [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]) {
        const local = path.getPointAtLength(length * share);
        const x = matrix.a * local.x + matrix.c * local.y + matrix.e;
        const y = matrix.b * local.x + matrix.d * local.y + matrix.f;
        // A link can run under a concept or under the tools, and only the part in the open can be looked for.
        if (!inside(at, x, y, -4) || covers.some((box) => inside(box, x, y, 4))) continue;
        points.push({ x: x - at.left, y: y - at.top });
      }
    }
    const controls = [...canvas.querySelectorAll(".px-map-strip, .px-concept-fold")].map((el) => {
      const box = el.getBoundingClientRect();
      return {
        what: el.className.toString(),
        x: box.left - at.left,
        y: box.top - at.top,
        width: box.width,
        height: box.height,
      };
    });
    return {
      canvas: {
        width: at.width,
        height: at.height,
        ratio: devicePixelRatio,
        background: rgb(getComputedStyle(canvas).backgroundColor),
      },
      link: { color: rgb(getComputedStyle(paths[0]!).stroke), points },
      controls,
    };
  });
}

/**
 * Compares the exported picture with the reference screenshot, in the page, where PNGs decode without a library. A pixel
 * differs when one channel is more than 40 off. A link shows at a probe when a pixel near it is at least a third of the
 * way from the background to the link's colour and on that line.
 */
function compare(page: Page, exported: string, reference: string, probes: Probes) {
  return page.evaluate(
    async ({ exported, reference, probes }) => {
      const decode = async (base64: string) => {
        const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
        const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const context = canvas.getContext("2d")!;
        context.drawImage(bitmap, 0, 0);
        return context.getImageData(0, 0, bitmap.width, bitmap.height);
      };
      const picture = await decode(exported);
      const shot = await decode(reference);
      const out = {
        picture: [picture.width, picture.height],
        shot: [shot.width, shot.height],
        differing: 1,
        regions: [] as Array<{ x: number; y: number; width: number; height: number; pixels: number }>,
        controlsDiffering: [] as number[],
        linksFound: 0,
        linksLooked: probes.link.points.length,
      };
      if (picture.width !== shot.width || picture.height !== shot.height) return out;
      const differs = (x: number, y: number) => {
        const i = (y * picture.width + x) * 4;
        return [0, 1, 2].some((c) => Math.abs(picture.data[i + c]! - shot.data[i + c]!) > 40);
      };
      // The differing pixels are counted in cells of 8 by 8, and touching cells are joined into regions, so a failure
      // says where the picture differs: the tools strip sits at the canvas's bottom right, the fold buttons on the
      // concepts, the Esporta menu at the top right.
      const CELL = 8;
      const columns = Math.ceil(picture.width / CELL);
      const rows = Math.ceil(picture.height / CELL);
      const cells = new Uint32Array(columns * rows);
      let count = 0;
      for (let y = 0; y < picture.height; y++)
        for (let x = 0; x < picture.width; x++)
          if (differs(x, y)) {
            count++;
            cells[Math.floor(y / CELL) * columns + Math.floor(x / CELL)]!++;
          }
      out.differing = count / (picture.width * picture.height);
      const scale = picture.width / probes.canvas.width;
      const seen = new Uint8Array(cells.length);
      for (let start = 0; start < cells.length; start++) {
        if (!cells[start] || seen[start]) continue;
        const region = { left: columns, top: rows, right: 0, bottom: 0, pixels: 0 };
        const stack = [start];
        seen[start] = 1;
        while (stack.length) {
          const at = stack.pop()!;
          const cx = at % columns;
          const cy = Math.floor(at / columns);
          region.left = Math.min(region.left, cx);
          region.top = Math.min(region.top, cy);
          region.right = Math.max(region.right, cx + 1);
          region.bottom = Math.max(region.bottom, cy + 1);
          region.pixels += cells[at]!;
          for (let ny = cy - 1; ny <= cy + 1; ny++)
            for (let nx = cx - 1; nx <= cx + 1; nx++) {
              const next = ny * columns + nx;
              if (nx < 0 || ny < 0 || nx >= columns || ny >= rows || seen[next] || !cells[next]) continue;
              seen[next] = 1;
              stack.push(next);
            }
        }
        // The box in the canvas's CSS pixels, as the probes are, so it reads against the page's own layout; the count
        // in the picture's pixels.
        out.regions.push({
          x: Math.round((region.left * CELL) / scale),
          y: Math.round((region.top * CELL) / scale),
          width: Math.round(((region.right - region.left) * CELL) / scale),
          height: Math.round(((region.bottom - region.top) * CELL) / scale),
          pixels: region.pixels,
        });
      }
      out.regions.sort((a, b) => b.pixels - a.pixels);
      for (const box of probes.controls) {
        let n = 0;
        let all = 0;
        for (let y = Math.floor(box.y * scale); y < Math.min(picture.height, Math.ceil((box.y + box.height) * scale)); y++)
          for (let x = Math.floor(box.x * scale); x < Math.min(picture.width, Math.ceil((box.x + box.width) * scale)); x++) {
            all++;
            if (differs(x, y)) n++;
          }
        out.controlsDiffering.push(all ? n / all : 0);
      }
      const [bg, link] = [probes.canvas.background, probes.link.color];
      const line = link.map((c, k) => c - bg[k]!);
      const lineLength = line.reduce((sum, c) => sum + c * c, 0);
      const reach = Math.ceil(2 * scale) + 1;
      for (const point of probes.link.points) {
        const cx = Math.round(point.x * scale);
        const cy = Math.round(point.y * scale);
        let found = false;
        for (let y = cy - reach; y <= cy + reach && !found; y++)
          for (let x = cx - reach; x <= cx + reach && !found; x++) {
            if (x < 0 || y < 0 || x >= picture.width || y >= picture.height) continue;
            const i = (y * picture.width + x) * 4;
            const away = [0, 1, 2].map((c) => picture.data[i + c]! - bg[c]!);
            const along = away.reduce((sum, c, k) => sum + c * line[k]!, 0) / lineLength;
            const off = Math.max(...away.map((c, k) => Math.abs(c - along * line[k]!)));
            if (along >= 0.33 && off < 30) found = true;
          }
        if (found) out.linksFound++;
      }
      return out;
    },
    { exported, reference, probes },
  );
}

const cases: Array<{
  name: string;
  layout: Layout;
  theme: Theme;
  prepare?: (page: Page, app: ElectronApplication) => Promise<void>;
}> = [
  { name: "tree-light", layout: "tree", theme: "light" },
  { name: "tree-dark", layout: "tree", theme: "dark" },
  { name: "radial-light", layout: "radial", theme: "light" },
  { name: "radial-dark", layout: "radial", theme: "dark" },
  {
    name: "tree-light-zoomed-in-selected",
    layout: "tree",
    theme: "light",
    prepare: async (page) => {
      await zoom(page, -500);
      await page.locator('.react-flow__node[data-id="b3"]').click();
    },
  },
  {
    name: "radial-dark-zoomed-out-folded",
    layout: "radial",
    theme: "dark",
    prepare: async (page) => {
      await page.locator('.react-flow__node[data-id="b2"] .px-concept-fold').click();
      await zoom(page, 400);
    },
  },
  // The app's own zoom (View > Zoom in, Zoom out) scales the window, so the page's pixels are no longer the window's.
  { name: "tree-light-app-zoom-150", layout: "tree", theme: "light", prepare: appZoom(1.5) },
  {
    // The window is 640 x 400 CSS pixels here, so the map is zoomed out to leave links in the open.
    name: "radial-dark-app-zoom-200",
    layout: "radial",
    theme: "dark",
    prepare: async (page, app) => {
      await appZoom(2)(page, app);
      await zoom(page, 400);
    },
  },
  { name: "tree-light-app-zoom-80", layout: "tree", theme: "light", prepare: appZoom(0.8) },
];

/** Sets the app's zoom the way the View menu's Zoom in, Zoom out and Actual size do, which scale the whole window. */
function appZoom(factor: number) {
  return async (page: Page, app: ElectronApplication) => {
    const before = await page.evaluate(() => devicePixelRatio);
    await app.evaluate(({ BrowserWindow }, factor) => {
      BrowserWindow.getAllWindows()[0]!.webContents.setZoomFactor(factor);
    }, factor);
    // The window keeps its size, so at 200% the page is about 640 x 400 CSS pixels and scrolls. Its scroll bars would be
    // drawn over the canvas, which this test is not about, so they are hidden.
    await page.addStyleTag({ content: "* { scrollbar-width: none !important; } *::-webkit-scrollbar { display: none !important; }" });
    // The page's pixel ratio carries the zoom, so the checks below read the zoomed ratio.
    await expect.poll(() => page.evaluate(() => devicePixelRatio)).toBeCloseTo(before * factor, 2);
    await mapAtRest(page);
  };
}

/**
 * Zooms the map with the mouse wheel. A plain wheel, because the map takes Ctrl with the wheel on a Mac as a trackpad
 * pinch and zooms ten times as far, which would take every Mac run to the map's smallest zoom.
 */
async function zoom(page: Page, delta: number) {
  const box = (await page.locator(".px-map-canvas").boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, delta);
  await mapAtRest(page);
}

/** Starts Pyxis with the film-history fixture stored as a tree map and as a radial one. */
async function start() {
  const root = mkdtempSync(join(tmpdir(), "pyxis-map-png-"));
  // Saved files go next to the app's data: Pyxis refuses to save a backup inside it.
  const userData = join(root, "userData");
  const saved = join(root, "map.png");
  const app = await launchPyxis({ userData, env: { PYXIS_E2E_SAVE: saved } });
  const page = await app.firstWindow();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.getByRole("button", { name: "Salta" }).click();
  await fromChiediToExams(page);
  await page.evaluate(() => window.pyxis.invoke("plans.list", {}));
  const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), { timeout: 10000 });
  try {
    seedSubjects(db, [{ id: "cinema", name: "Cinema" }]);
    db.prepare("INSERT INTO maps(id,subject_id,graph_json,grounding,created_at) VALUES('row-cinema','cinema',?,'general',1)").run(
      JSON.stringify({
        version: 1,
        maps: (["tree", "radial"] as const).map((layout) => ({
          id: layout,
          title: radialFixtures.filmHistory.title,
          passageIds: [],
          grounding: "general",
          graph: storedGraph(radialFixtures.filmHistory, layout),
        })),
      }),
    );
  } finally {
    db.close();
  }
  // The page keeps the window's own size. A viewport set by the test would lay the page out for a size the window may not
  // have (a Mac runner's window is shorter than 800 pixels), while the export takes the window's pixels.
  return { app, page, root, saved };
}

/** Picks Esporta > Solo quello che vedi and returns the saved picture, in base64. */
async function exportView(page: Page, saved: string) {
  rmSync(saved, { force: true });
  await page.locator(".px-map-actions").getByRole("button", { name: "Altro", exact: true }).click();
  await page.getByRole("menuitem", { name: "Esporta" }).click();
  await page.getByRole("menuitem", { name: "Solo quello che vedi" }).click();
  await expect(page.getByText("File salvato")).toBeVisible();
  expect(existsSync(saved)).toBe(true);
  return readFileSync(saved).toString("base64");
}

/**
 * A screenshot of the part of the canvas inside the window as it is now, with the page's own controls (and the toast that
 * says the file is saved) hidden, which is what the picture should be. Playwright's own screenshot is in CSS pixels
 * whatever the window's zoom. Chromium's screenshot clip is in the window's pixels (a CSS pixel times the zoom) and its
 * scale is the screen's pixels per window pixel, so this asks for the canvas's box in the window's pixels, grown to whole
 * ones the way the export grows it, at the size the canvas has on screen.
 */
async function plainCanvas(page: Page) {
  await page.addStyleTag({
    content:
      ".px-map-strip, .px-concept-fold, .react-flow__handle, .ant-message { visibility: hidden !important; } * { transition: none !important; }",
  });
  const session = await page.context().newCDPSession(page);
  try {
    const { visualViewport } = await session.send("Page.getLayoutMetrics");
    const zoom = visualViewport.zoom ?? 1;
    const clip = await page.evaluate((zoom) => {
      const box = document.querySelector(".px-map-canvas")!.getBoundingClientRect();
      const left = Math.floor(Math.max(0, box.left) * zoom + 1e-6);
      const top = Math.floor(Math.max(0, box.top) * zoom + 1e-6);
      return {
        x: left,
        y: top,
        width: Math.ceil(Math.min(window.visualViewport!.width, box.right) * zoom - 1e-6) - left,
        height: Math.ceil(Math.min(window.visualViewport!.height, box.bottom) * zoom - 1e-6) - top,
        scale: Math.round((devicePixelRatio / zoom) * 1000) / 1000,
      };
    }, zoom);
    return (await session.send("Page.captureScreenshot", { format: "png", clip })).data;
  } finally {
    await session.detach();
  }
}

function roundBox(box: { x: number; y: number; width: number; height: number }) {
  return { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) };
}

function keep(name: string, picture: string, reference: string) {
  if (!SHOTS) return;
  mkdirSync(join(SHOTS, "maps-png"), { recursive: true });
  writeFileSync(join(SHOTS, "maps-png", `${name}-export.png`), Buffer.from(picture, "base64"));
  writeFileSync(join(SHOTS, "maps-png", `${name}-canvas.png`), Buffer.from(reference, "base64"));
}

async function checkPicture(page: Page, saved: string, name: string) {
  const probes = await readProbes(page);
  const fonts = await page.evaluate(() => document.fonts.status);
  const picture = await exportView(page, saved);
  // Taken without moving the pointer, so a concept under it is drawn the same in both.
  const reference = await plainCanvas(page);
  keep(name, picture, reference);
  // Both pictures go into the test's own output folder, which CI uploads when a test fails.
  for (const [what, base64] of [["export", picture], ["canvas", reference]] as const) {
    const path = test.info().outputPath(`${name}-${what}.png`);
    writeFileSync(path, Buffer.from(base64, "base64"));
    await test.info().attach(`${name}-${what}.png`, { path, contentType: "image/png" });
  }
  const result = await compare(page, picture, reference, probes);
  // The visible canvas's size times the screen's pixel ratio: sharp on a display with more pixels than CSS pixels.
  // (A canvas on a fraction of a pixel is saved with its outer pixels, so the size is off by less than two: one on each side.)
  const [width, height] = result.picture as [number, number];
  expect(Math.abs(width - probes.canvas.width * probes.canvas.ratio)).toBeLessThanOrEqual(2);
  expect(Math.abs(height - probes.canvas.height * probes.canvas.ratio)).toBeLessThanOrEqual(2);
  expect(result.shot).toEqual(result.picture);
  // The same concepts in the same places with the app's own fonts and colours: a picture in a fallback font, or without
  // the links, differs from the screen in a few per cent of its pixels.
  // A failed comparison says whether the page was still loading fonts when the picture was saved, where the controls in
  // sight were, and where the pictures differ (the largest regions first), in the canvas's CSS pixels.
  const inSight = probes.controls.filter(
    (box) => box.x + box.width > 0 && box.y + box.height > 0 && box.x < probes.canvas.width && box.y < probes.canvas.height,
  );
  const where = [
    `fonts were ${fonts} at the export`,
    `controls ${JSON.stringify(inSight.map(({ what, ...box }) => ({ what: what.split(" ")[0], ...roundBox(box) })))}`,
    `differing regions ${JSON.stringify(result.regions.slice(0, 8))}`,
  ].join("; ");
  expect(result.differing, where).toBeLessThan(0.003);
  // The links drawn between concepts are in the picture.
  expect(result.linksLooked).toBeGreaterThan(10);
  expect(result.linksFound).toBeGreaterThanOrEqual(Math.ceil(result.linksLooked * 0.95));
  // The tools strip and the fold buttons are not.
  expect(probes.controls.length).toBeGreaterThan(1);
  for (const share of result.controlsDiffering) expect(share, where).toBeLessThan(0.02);
}

for (const item of cases) {
  test(`MAP png: Solo quello che vedi saves the canvas as drawn, ${item.name}`, async () => {
    test.setTimeout(120_000);
    const { app, page, root, saved } = await start();
    try {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await openMap(page, item.layout, item.theme);
      await item.prepare?.(page, app);
      await mapAtRest(page);
      await checkPicture(page, saved, item.name);
      expect(errors).toEqual([]);
    } finally {
      await app.close();
      removeTestFolder(root);
    }
  });
}
