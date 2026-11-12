import { expect, test, type Page } from "@playwright/test";
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

/** Reads what the page draws, in the canvas's own CSS pixels. */
function readProbes(page: Page): Promise<Probes> {
  return page.evaluate(() => {
    const canvas = document.querySelector<HTMLElement>(".px-map-canvas")!;
    const at = canvas.getBoundingClientRect();
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
      for (const share of [0.2, 0.4, 0.6, 0.8]) {
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
        controlsDiffering: [] as number[],
        linksFound: 0,
        linksLooked: probes.link.points.length,
      };
      if (picture.width !== shot.width || picture.height !== shot.height) return out;
      const differs = (x: number, y: number) => {
        const i = (y * picture.width + x) * 4;
        return [0, 1, 2].some((c) => Math.abs(picture.data[i + c]! - shot.data[i + c]!) > 40);
      };
      let count = 0;
      for (let y = 0; y < picture.height; y++) for (let x = 0; x < picture.width; x++) if (differs(x, y)) count++;
      out.differing = count / (picture.width * picture.height);
      const scale = picture.width / probes.canvas.width;
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
  prepare?: (page: Page) => Promise<void>;
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
];

async function zoom(page: Page, delta: number) {
  const box = (await page.locator(".px-map-canvas").boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, delta);
  await page.keyboard.up("Control");
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
  await page.setViewportSize({ width: 1280, height: 800 });
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

/** A screenshot of the canvas as it is now with the page's own controls (and the toast that says the file is saved) hidden, which is what the picture should be. */
async function plainCanvas(page: Page) {
  await page.addStyleTag({
    content:
      ".px-map-strip, .px-concept-fold, .react-flow__handle, .ant-message { visibility: hidden !important; } * { transition: none !important; }",
  });
  const shot = await page.locator(".px-map-canvas").screenshot({ animations: "disabled" });
  return shot.toString("base64");
}

function keep(name: string, picture: string, reference: string) {
  if (!SHOTS) return;
  mkdirSync(join(SHOTS, "maps-png"), { recursive: true });
  writeFileSync(join(SHOTS, "maps-png", `${name}-export.png`), Buffer.from(picture, "base64"));
  writeFileSync(join(SHOTS, "maps-png", `${name}-canvas.png`), Buffer.from(reference, "base64"));
}

async function checkPicture(page: Page, saved: string, name: string) {
  const probes = await readProbes(page);
  const picture = await exportView(page, saved);
  // Taken without moving the pointer, so a concept under it is drawn the same in both.
  const reference = await plainCanvas(page);
  keep(name, picture, reference);
  const result = await compare(page, picture, reference, probes);
  // The canvas's size times the screen's pixel ratio: sharp on a display with more pixels than CSS pixels.
  // (A canvas on a half pixel is saved with its outer pixels, so the size is within one CSS pixel.)
  const [width, height] = result.picture as [number, number];
  expect(Math.abs(width - probes.canvas.width * probes.canvas.ratio)).toBeLessThanOrEqual(probes.canvas.ratio + 0.5);
  expect(Math.abs(height - probes.canvas.height * probes.canvas.ratio)).toBeLessThanOrEqual(probes.canvas.ratio + 0.5);
  expect(result.shot).toEqual(result.picture);
  // The same concepts in the same places with the app's own fonts and colours: a picture in a fallback font, or without
  // the links, differs from the screen in a few per cent of its pixels.
  expect(result.differing).toBeLessThan(0.003);
  // The links drawn between concepts are in the picture.
  expect(result.linksLooked).toBeGreaterThan(10);
  expect(result.linksFound).toBeGreaterThanOrEqual(Math.ceil(result.linksLooked * 0.95));
  // The tools strip and the fold buttons are not.
  expect(probes.controls.length).toBeGreaterThan(1);
  for (const share of result.controlsDiffering) expect(share).toBeLessThan(0.02);
}

for (const item of cases) {
  test(`MAP png: Solo quello che vedi saves the canvas as drawn, ${item.name}`, async () => {
    test.setTimeout(120_000);
    const { app, page, root, saved } = await start();
    try {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await openMap(page, item.layout, item.theme);
      await item.prepare?.(page);
      await mapAtRest(page);
      await checkPicture(page, saved, item.name);
      expect(errors).toEqual([]);
    } finally {
      await app.close();
      removeTestFolder(root);
    }
  });
}
