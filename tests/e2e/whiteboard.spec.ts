import AxeBuilder from "@axe-core/playwright";
import {
  _electron as electron,
  expect,
  test,
  type Page,
} from "@playwright/test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";

async function draw(page: Page) {
  // A freshly routed board has no layout box yet; measuring it earlier throws "canvas-missing".
  await expect(page.locator(".px-whiteboard canvas")).toBeVisible();
  const rect = await page.locator(".px-whiteboard canvas").boundingBox();
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
    ...process.env,
    PYXIS_USER_DATA: userData,
    PYXIS_E2E: "1",
    PYXIS_E2E_SAVE: output,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({
    args: [
      join(process.cwd(), process.env.PYXIS_OUT ?? "out", "main/index.js"),
    ],
    env,
  });
  try {
    const page = await app.firstWindow();
    // Hidden windows on Windows and Linux can stall CSS/JS motion mid-way (stuck modal leave, half-faded colors); the app honors this setting.
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.getByRole("button", { name: "Salta" }).click();
    await expect(page).toHaveURL(/#\/exams$/);
    mkdirSync(".shots", { recursive: true });
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
          theme === "light" ? [255, 255, 255, 255] : [21, 25, 32, 255],
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
        await page
          .getByRole("button", { name: /Close|Chiudi/, exact: true })
          .click();
        await expect(page.getByRole("dialog")).toBeVisible();
        await page
          .getByRole("button", { name: /Keep drawing|Continua a disegnare/ })
          .click();
        await expect(page.getByRole("dialog")).not.toBeVisible();
        await page
          .getByRole("button", { name: /Save|Salva/, exact: true })
          .click();
        await expect.poll(() => existsSync(output)).toBe(true);
        const png = PNG.sync.read(readFileSync(output));
        expect([png.width, png.height]).toEqual([1200, 700]);
        expect(Array.from(png.data.subarray(0, 4))).toEqual(rgba);
        // Save writes a file only. It must not leave an image for Ask to preview.
        expect(
          await page.evaluate(() => sessionStorage.getItem("pyxis-board-png")),
        ).toBeNull();
        await expect(
          page.getByRole("button", { name: /Save|Salva/, exact: true }),
        ).toBeEnabled();
        expect(
          (await new AxeBuilder({ page }).setLegacyMode(true).analyze())
            .violations,
        ).toEqual([]);
        await page.screenshot({
          path: `.shots/m15-whiteboard-${language}-${theme}.png`,
        });
        await page
          .getByRole("button", { name: /Close|Chiudi/, exact: true })
          .click();
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
    await page.getByRole("button", { name: "Chiudi", exact: true }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.getByRole("button", { name: "Elimina le modifiche" }).click();
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
    await page.getByRole("button", { name: /^(Remove|Rimuovi) .*\.png$/ }).click();
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
    rmSync(userData, { recursive: true, force: true });
  }
});
