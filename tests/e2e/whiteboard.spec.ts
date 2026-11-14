import {
  expect,
  test,
  type Page,
} from "@playwright/test";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { launchPyxis } from "./app-under-test";
import { expectNoAxeViolations } from "./axe";
import { saveShot } from "./shots";
import { removeTestFolder } from "./cleanup";
import { fromChiediToExams } from "./doors";

async function draw(page: Page) {
  // A freshly routed board has no layout box yet; measuring it earlier throws "canvas-missing".
  await expect(page.locator(".px-whiteboard canvas")).toBeVisible();
  // Routing can replace the canvas between visibility and measurement.
  let rect = await page.locator(".px-whiteboard canvas").boundingBox();
  await expect
    .poll(async () => {
      rect = await page.locator(".px-whiteboard canvas").boundingBox();
      return Boolean(rect && rect.width > 0 && rect.height > 0);
    })
    .toBe(true);
  if (!rect) throw new Error("canvas-missing");
  await page.mouse.move(rect.x + 100, rect.y + 200);
  await page.mouse.down();
  await page.mouse.move(rect.x + 250, rect.y + 300, { steps: 12 });
  await page.mouse.up();
}
async function strokes(page: Page) {
  return page.evaluate(
    () => JSON.parse(sessionStorage.getItem("pyxis-board") ?? "[]").length,
  );
}

test("ASK-05 themes, drawing shortcuts, unsaved guard and current PNG attachment", async () => {
  test.setTimeout(120000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-whiteboard-"));
  const output = join(userData, "drawing.png");
  const env = {
    PYXIS_E2E_SAVE: output,
  };
  const app = await launchPyxis({ userData, env });
  try {
    const page = await app.firstWindow();
    // Hidden windows on Windows and Linux can stall CSS/JS motion mid-way (stuck modal leave, half-faded colors); the app honors this setting.
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.getByRole("button", { name: "Salta" }).click();
    await fromChiediToExams(page);
    for (const language of ["en", "it"] as const)
      for (const theme of ["light", "dark"] as const) {
        await page.evaluate(
          async ({ language, theme }) => {
            localStorage.setItem("pyxis.lang", language);
            sessionStorage.removeItem("pyxis-board");
            await window.pyxis.setAppearance(theme);
            location.hash = "/tools/whiteboard";
          },
          { language, theme },
        );
        await page.reload();
        await expect(page.locator(".px-whiteboard canvas")).toBeVisible();
        const rgba = await page
          .locator(".px-whiteboard canvas")
          .evaluate((canvas) =>
            Array.from(
              (canvas as HTMLCanvasElement)
                .getContext("2d")!
                .getImageData(0, 0, 1, 1).data,
            ),
          );
        expect(rgba).toEqual(
          theme === "light" ? [255, 255, 255, 255] : [23, 27, 34, 255],
        );
        await page.keyboard.press("e");
        await expect(
          page.getByRole("button", { name: /Eraser|Gomma/ }),
        ).toHaveAttribute("aria-pressed", "true");
        await page.keyboard.press("p");
        await draw(page);
        expect(await strokes(page)).toBe(1);
        await page.keyboard.press("Control+z");
        expect(await strokes(page)).toBe(0);
        await page.keyboard.press("Control+Shift+z");
        expect(await strokes(page)).toBe(1);
        await page.getByRole("button", { name: /^(Back to|Torna a) / }).click();
        await expect(page.getByRole("dialog")).toBeVisible();
        await page
          .getByRole("button", { name: /Stay here|Resta qui/ })
          .click();
        await expect(page.getByRole("dialog")).not.toBeVisible();
        await page
          .getByRole("button", { name: /Save|Salva/, exact: true })
          .click();
        // Windows shows the file before the write has finished, so wait until it decodes.
        const readPng = () => {
          try {
            return PNG.sync.read(readFileSync(output));
          } catch {
            return null;
          }
        };
        await expect.poll(readPng, { timeout: 20000 }).not.toBeNull();
        const png = readPng()!;
        // The picture is the board as drawn: the canvas's own size.
        expect([png.width, png.height]).toEqual(
          await page.locator(".px-whiteboard canvas").evaluate((canvas) => [(canvas as HTMLCanvasElement).width, (canvas as HTMLCanvasElement).height]),
        );
        expect(Array.from(png.data.subarray(0, 4))).toEqual(rgba);
        // Save writes a file only. It must not leave an image for Ask to preview.
        expect(
          await page.evaluate(() => sessionStorage.getItem("pyxis-board-png")),
        ).toBeNull();
        await expect(
          page.getByRole("button", { name: /Save|Salva/, exact: true }),
        ).toBeEnabled();
        await expectNoAxeViolations(page);
        await saveShot(page, `m15-whiteboard-${language}-${theme}.png`);
        await page.getByRole("button", { name: /^(Back to|Torna a) / }).click();
        await expect(page).toHaveURL(/#\/ask$/);
        rmSync(output);
      }
    await page.evaluate(() => {
      location.hash = "/tools/whiteboard";
    });
    await draw(page);
    await app.evaluate(({ dialog }) => {
      delete process.env.PYXIS_E2E_SAVE;
      dialog.showSaveDialog = async () => ({ canceled: true, filePath: "" });
    });
    await page.getByRole("button", { name: "Salva", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Salva", exact: true }),
    ).toBeEnabled();
    await page.getByRole("button", { name: "Torna a Chiedi" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.getByRole("button", { name: "Esci senza salvare" }).click();
    await expect(page).toHaveURL(/#\/ask$/);
    await page.evaluate(() => {
      location.hash = "/tools/whiteboard";
    });
    await draw(page);
    const current = await page
      .locator(".px-whiteboard canvas")
      .evaluate((canvas) => (canvas as HTMLCanvasElement).toDataURL());
    await page.getByRole("button", { name: "Allega alla chat" }).click();
    await expect(page).toHaveURL(/#\/ask$/);
    await expect(page.getByAltText("Lavagna")).toHaveAttribute("src", current);
    await expect(page.getByRole("dialog")).not.toBeVisible();
    // Ask consumed both keys into its own state.
    expect(
      await page.evaluate(() => [
        sessionStorage.getItem("pyxis-board-file"),
        sessionStorage.getItem("pyxis-board-png"),
      ]),
    ).toEqual([null, null]);
    // The preview survives a visit to another view of Ask only while the file is pending, and Remove drops both.
    await page
      .getByRole("button", { name: /^(Remove|Rimuovi) .*\.png$/ })
      .click();
    await expect(page.getByAltText("Lavagna")).toHaveCount(0);
    // A board that was only saved never shows up in Ask, even next to a later attachment.
    await page.evaluate(() => {
      location.hash = "/tools/whiteboard";
    });
    await draw(page);
    await page.getByRole("button", { name: "Salva", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Salva", exact: true }),
    ).toBeEnabled();
    await page.evaluate(() => {
      location.hash = "/ask";
    });
    await expect(page.getByAltText("Lavagna")).toHaveCount(0);
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});

test("ASK-05 an empty board cannot be saved, one eraser drag removes what it crosses and Clear can be undone", async () => {
  test.setTimeout(120000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-whiteboard-empty-"));
  const app = await launchPyxis({ userData });
  try {
    const page = await app.firstWindow();
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.getByRole("button", { name: "Salta" }).click();
    await fromChiediToExams(page);
    await page.evaluate(() => {
      sessionStorage.removeItem("pyxis-board");
      location.hash = "/tools/whiteboard";
    });
    const save = page.getByRole("button", { name: "Salva", exact: true });
    const attach = page.getByRole("button", { name: "Allega alla chat" });
    const clear = page.getByRole("button", { name: "Cancella tutto" });
    await expect(page.locator(".px-whiteboard canvas")).toBeVisible();
    // Nothing drawn: there is nothing to save or send to Ask, and nothing to clear.
    for (const button of [save, attach, clear]) await expect(button).toBeDisabled();

    await draw(page);
    const rect = (await page.locator(".px-whiteboard canvas").boundingBox())!;
    await page.mouse.move(rect.x + 100, rect.y + 500);
    await page.mouse.down();
    await page.mouse.move(rect.x + 250, rect.y + 600, { steps: 12 });
    await page.mouse.up();
    expect(await strokes(page)).toBe(2);
    for (const button of [save, attach, clear]) await expect(button).toBeEnabled();

    // Dragging the eraser across both strokes removes both, as one step.
    await page.keyboard.press("e");
    await page.mouse.move(rect.x + 100, rect.y + 200);
    await page.mouse.down();
    await page.mouse.move(rect.x + 250, rect.y + 300, { steps: 12 });
    await page.mouse.move(rect.x + 100, rect.y + 500, { steps: 12 });
    await page.mouse.move(rect.x + 250, rect.y + 600, { steps: 12 });
    await page.mouse.up();
    expect(await strokes(page)).toBe(0);
    await expect(save).toBeDisabled();
    await page.keyboard.press("Control+z");
    expect(await strokes(page)).toBe(2);

    // Clear empties the board and can be undone like any other change.
    await clear.click();
    expect(await strokes(page)).toBe(0);
    await expect(save).toBeDisabled();
    await page.keyboard.press("Control+z");
    expect(await strokes(page)).toBe(2);
    await page.getByRole("button", { name: "Torna a Chiedi" }).click();
    await page.getByRole("button", { name: "Esci senza salvare" }).click();
    await expect(page).toHaveURL(/#\/ask$/);
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});

const SIZES = [
  { width: 960, height: 640 },
  { width: 1280, height: 720 },
  { width: 1280, height: 1000 },
] as const;

type Box = { x: number; y: number; width: number; height: number };
const boxOf = async (page: Page, selector: string): Promise<Box> => {
  const box = await page.locator(selector).first().boundingBox();
  if (!box) throw new Error(`${selector} has no box`);
  return box;
};
function expectSame(inner: Box, outer: Box, what: string, edge = 1) {
  for (const key of ["x", "y", "width", "height"] as const)
    expect(Math.abs(inner[key] - outer[key]), `${what}: ${key} ${inner[key]} against ${outer[key]}`).toBeLessThanOrEqual(edge);
}

test("the board fills its window at every size, and a drawing is neither cut nor stretched when the window changes", async () => {
  test.setTimeout(120000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-whiteboard-size-"));
  const app = await launchPyxis({ userData });
  try {
    const page = await app.firstWindow();
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.getByRole("button", { name: "Salta" }).click();
    await fromChiediToExams(page);
    for (const size of SIZES) {
      await page.setViewportSize(size);
      await page.evaluate(() => {
        sessionStorage.removeItem("pyxis-board");
        location.hash = "/tools/whiteboard";
      });
      await page.reload();
      await expect(page.locator(".px-whiteboard canvas")).toBeVisible();
      // The canvas is the whole board, with no strip where drawing does nothing, and nothing runs below the window.
      const board = await boxOf(page, ".px-whiteboard");
      expectSame(await boxOf(page, ".px-whiteboard canvas"), board, `${size.width}x${size.height}`);
      expect(board.y + board.height, `${size.width}x${size.height}: the board ends inside the window`).toBeLessThanOrEqual(size.height + 1);
      expect(board.height, `${size.width}x${size.height}: the board is most of the window`).toBeGreaterThan(size.height - 140);
    }
    // A stroke drawn at one size is where it was drawn after the window changes and changes back.
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.evaluate(() => {
      sessionStorage.removeItem("pyxis-board");
      location.hash = "/tools/whiteboard";
    });
    await page.reload();
    await draw(page);
    const stored = () => page.evaluate(() => sessionStorage.getItem("pyxis-board"));
    const drawn = await stored();
    const start = await page.evaluate(() => {
      const first = (JSON.parse(sessionStorage.getItem("pyxis-board") ?? "[]") as Array<{ points: Array<{ x: number; y: number }> }>)[0]!.points[0]!;
      return first;
    });
    const inkAtStart = () =>
      page.evaluate(({ x, y }) => {
        const canvas = document.querySelector<HTMLCanvasElement>(".px-whiteboard canvas")!;
        const ratio = canvas.width / canvas.getBoundingClientRect().width;
        const [r, g, b] = canvas.getContext("2d")!.getImageData(Math.round(x * ratio), Math.round(y * ratio), 1, 1).data;
        const surface = getComputedStyle(document.documentElement).getPropertyValue("--surface").trim();
        const probe = document.createElement("canvas").getContext("2d")!;
        probe.fillStyle = surface;
        probe.fillRect(0, 0, 1, 1);
        const [sr, sg, sb] = probe.getImageData(0, 0, 1, 1).data;
        return Math.abs(r! - sr!) + Math.abs(g! - sg!) + Math.abs(b! - sb!) > 60;
      }, start);
    await expect.poll(inkAtStart).toBe(true);
    for (const size of [{ width: 960, height: 640 }, { width: 1280, height: 1000 }, { width: 1280, height: 800 }]) {
      await page.setViewportSize(size);
      await expect(page.locator(".px-whiteboard canvas")).toBeVisible();
      expect(await stored()).toBe(drawn);
    }
    await expect.poll(inkAtStart).toBe(true);
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});

test("the graph and Python fill their window at every size", async () => {
  test.setTimeout(120000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-tools-size-"));
  const app = await launchPyxis({ userData });
  try {
    const page = await app.firstWindow();
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.getByRole("button", { name: "Salta" }).click();
    await fromChiediToExams(page);
    for (const size of SIZES) {
      await page.setViewportSize(size);
      await page.evaluate(() => {
        location.hash = "/tools/graph";
      });
      await page.reload();
      await expect(page.locator(".px-graph")).toBeVisible();
      const stage = await boxOf(page, ".focus-main.is-stage");
      // The stage's border is one pixel on each side.
      expectSame(await boxOf(page, ".px-graph"), stage, `graph ${size.width}x${size.height}`, 2);
      expect(stage.y + stage.height, `graph ${size.width}x${size.height}: the stage ends inside the window`).toBeLessThanOrEqual(size.height + 1);
      expect(stage.height).toBeGreaterThan(size.height - 140);
      await page.evaluate(() => {
        location.hash = "/tools/python";
      });
      await page.reload();
      await expect(page.getByRole("textbox", { name: "Codice" })).toBeVisible();
      // The editor sits inside the window's width, with nothing pushing the page sideways.
      const editor = await boxOf(page, "textarea");
      expect(editor.x).toBeGreaterThanOrEqual(0);
      expect(editor.x + editor.width).toBeLessThanOrEqual(size.width);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    }
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});
