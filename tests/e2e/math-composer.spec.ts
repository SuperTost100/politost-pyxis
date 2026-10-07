import AxeBuilder from "@axe-core/playwright";
import { _electron as electron, expect, test, type Page } from "@playwright/test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MAIN = join(process.cwd(), process.env.PYXIS_OUT ?? "out", "main/index.js");

async function launch() {
  const userData = mkdtempSync(join(tmpdir(), "pyxis-math-composer-"));
  const env = { ...process.env, PYXIS_USER_DATA: userData, PYXIS_E2E: "1", PYXIS_E2E_REPLY: "Ecco." };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: [MAIN], env });
  const page = await app.firstWindow();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.getByRole("button", { name: "Salta" }).click();
  await expect(page).toHaveURL(/#\/exams$/);
  await page.evaluate(() => {
    location.hash = "/ask";
  });
  return { app, page, userData };
}

const draft = (page: Page) => page.evaluate(() => sessionStorage.getItem("pyxis-draft"));

async function shoot(page: Page, name: string) {
  mkdirSync(".shots", { recursive: true });
  for (const theme of ["light", "dark"] as const) {
    await page.evaluate((theme) => window.pyxis.setAppearance(theme), theme);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await page.locator(".px-composer").screenshot({ path: `.shots/math-composer-${name}-${theme}.png` });
  }
}

test("Ask composer: a formula sits inline in the text, leaves as $...$ and renders in the bubble", async () => {
  test.setTimeout(120000);
  const { app, page, userData } = await launch();
  try {
    const box = page.getByRole("textbox", { name: "Messaggio" });
    await expect(box).toHaveAttribute("aria-multiline", "true");
    await box.click();
    await page.keyboard.type("Quanto vale ");

    // The sigma button opens a formula at the caret and the keyboard under the field.
    const toggle = page.getByRole("button", { name: "Inserisci formula" });
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    const keys = page.getByRole("group", { name: "Tastiera per formule" });
    await expect(keys).toBeVisible();
    const field = box.locator(".px-mathchip math-field");
    await expect(field).toBeFocused();
    await page.keyboard.type("x^2");
    await expect.poll(() => draft(page)).toMatch(/^Quanto vale \$x\^\{?2\}?\$$/);
    // The keyboard types into the same formula.
    await keys.getByRole("button", { name: "Più" }).click();
    await keys.getByRole("button", { name: "1", exact: true }).click();
    await expect(field).toBeFocused();
    await expect.poll(() => draft(page)).toMatch(/^Quanto vale \$x\^\{?2\}?\+1\$$/);
    await expect(page.getByText("Anteprima")).toHaveCount(0);
    await shoot(page, "editing");

    // Esc closes the keyboard and returns to the text after the formula.
    await page.keyboard.press("Escape");
    await expect(keys).toHaveCount(0);
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await expect(box).toBeFocused();
    await page.keyboard.type(" se x vale 3?");
    const chip = box.locator(".px-mathchip");
    await expect(chip).toHaveCount(1);
    await expect(chip).toHaveAttribute("role", "img");
    await expect(chip).toHaveAttribute("aria-label", /^Formula/);
    await expect(chip.locator(".katex")).toBeVisible();
    // No LaTeX anywhere in the field.
    expect(await box.innerText()).not.toMatch(/[$^\\]/);
    await shoot(page, "text-and-chip");
    expect((await new AxeBuilder({ page }).setLegacyMode(true).analyze()).violations).toEqual([]);

    // From the text, the first Backspace selects the formula and the second removes it; undo brings it back.
    for (let i = 0; i < " se x vale 3?".length; i += 1) await page.keyboard.press("Backspace");
    await page.keyboard.press("Backspace");
    await expect(chip).toHaveClass(/is-selected/);
    await page.keyboard.press("Backspace");
    await expect(chip).toHaveCount(0);
    expect(await draft(page)).toBe("Quanto vale ");
    await page.keyboard.press("Control+z");
    await expect(chip).toHaveCount(1);
    await page.keyboard.press("End");
    await page.keyboard.type(" se x vale 3?");
    await expect.poll(() => draft(page)).toMatch(/\+1\$ se x vale 3\?$/);

    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/#\/ask\/.+/);
    const bubble = page.locator(".px-msg-user .px-msg-bubble");
    await expect(bubble.locator(".katex")).toBeVisible();
    expect(await bubble.innerText()).not.toContain("$");
    await bubble.screenshot({ path: ".shots/math-composer-bubble-dark.png" });
    const stored = (await page.evaluate(() =>
      window.pyxis.invoke("chats.read", { chatId: location.hash.split("/").at(-1)! }),
    )) as { messages: Array<{ role: string; body: string }> };
    expect(stored.messages[0]!.body).toMatch(/^Quanto vale \$x\^\{?2\}?\+1\$ se x vale 3\?$/);
    await expect(box).toHaveText("");
    expect(await draft(page)).toBeNull();
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
});

test("Ask composer: typing $ opens a formula, arrows move in and out, paste and drafts keep formulas", async () => {
  test.setTimeout(120000);
  const { app, page, userData } = await launch();
  try {
    const box = page.getByRole("textbox", { name: "Messaggio" });
    const field = box.locator(".px-mathchip math-field");
    const chips = box.locator(".px-mathchip");
    await box.click();
    await page.keyboard.type("a $");
    await expect(field).toBeFocused();
    await page.keyboard.type("y/2");
    // Out of the denominator, then out of the formula.
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await expect(box).toBeFocused();
    await page.keyboard.type(" b");
    await expect.poll(() => draft(page)).toBe("a $\\frac{y}{2}$ b");

    // ArrowLeft from the text enters the formula at its end; Tab leaves it after.
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowLeft");
    await expect(field).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(box).toBeFocused();
    await expect(chips.first()).not.toHaveClass(/is-editing/);

    // A click edits the formula; Shift+Enter in the text is a new line, not a send.
    await chips.first().click();
    await expect(field).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(box).toBeFocused();
    await page.keyboard.press("End");
    await page.keyboard.press("Shift+Enter");
    await page.keyboard.type("riga");
    await expect.poll(() => draft(page)).toBe("a $\\frac{y}{2}$ b\nriga");

    // Pasted text turns its $...$ into formulas.
    await page.evaluate(() => navigator.clipboard.writeText(" e $\\sqrt{2}$"));
    await page.keyboard.press("Control+v");
    await expect(chips).toHaveCount(2);
    await expect.poll(() => draft(page)).toBe("a $\\frac{y}{2}$ b\nriga e $\\sqrt{2}$");

    // A dollar sign typed and taken back with Backspace stays a plain sign.
    await page.keyboard.type(" 5$");
    await expect(field).toBeFocused();
    await page.keyboard.press("Backspace");
    await expect(box).toBeFocused();
    await expect(chips).toHaveCount(2);
    await expect.poll(() => draft(page)).toBe("a $\\frac{y}{2}$ b\nriga e $\\sqrt{2}$ 5\\$");

    // Copying the field gives back the message with its formulas.
    await page.keyboard.press("Control+a");
    await page.keyboard.press("Control+c");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      "a $\\frac{y}{2}$ b\nriga e $\\sqrt{2}$ 5\\$",
    );

    // The draft survives a reload as text and formulas, never as LaTeX.
    await page.reload();
    await expect(chips).toHaveCount(2);
    expect(await box.innerText()).not.toMatch(/\\frac|\\sqrt|\$\\/);
    await expect(box).toContainText("riga");
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
});
