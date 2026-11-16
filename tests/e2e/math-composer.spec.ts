import { expect, test, type Page } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchPyxis, setUp } from "./app-under-test";
import { expectNoAxeViolations } from "./axe";
import { saveShot } from "./shots";
import { removeTestFolder } from "./cleanup";
import { fromChiediToExams } from "./doors";

async function launch() {
  const userData = mkdtempSync(join(tmpdir(), "pyxis-math-composer-"));
  const app = await launchPyxis({ userData, env: { PYXIS_E2E_REPLY: "Ecco." } });
  return setUp(app, userData, async () => {
    const page = await app.firstWindow();
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.getByRole("button", { name: "Salta" }).click();
    await fromChiediToExams(page);
    await page.evaluate(() => {
      location.hash = "/ask";
    });
    return { app, page, userData };
  });
}

const draft = (page: Page) => page.evaluate(() => sessionStorage.getItem("pyxis-draft"));

async function shoot(page: Page, name: string) {
  for (const theme of ["light", "dark"] as const) {
    await page.evaluate((theme) => window.pyxis.setAppearance(theme), theme);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await saveShot(page.locator(".px-composer"), `math-composer-${name}-${theme}.png`);
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

    // "Scrivi una formula" in the plus menu opens a formula at the caret and the keyboard under the field.
    await page.getByRole("button", { name: "Aggiungi un file o una formula" }).click();
    await page.getByRole("menuitem", { name: "Scrivi una formula" }).click();
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
    await expectNoAxeViolations(page);

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
    // The bubble can still move while KaTeX fonts load and the thread scrolls; shoot once its box holds still.
    let last = "";
    await expect
      .poll(async () => {
        const now = JSON.stringify(await bubble.boundingBox());
        const still = now === last;
        last = now;
        return still;
      }, { intervals: [100] })
      .toBe(true);
    await saveShot(bubble, "math-composer-bubble-dark.png");
    const stored = (await page.evaluate(() =>
      window.pyxis.invoke("chats.read", { chatId: location.hash.split("/").at(-1)! }),
    )) as { messages: Array<{ role: string; body: string }> };
    expect(stored.messages[0]!.body).toMatch(/^Quanto vale \$x\^\{?2\}?\+1\$ se x vale 3\?$/);
    await expect(box).toHaveText("");
    expect(await draft(page)).toBeNull();
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});

/** One step of a typed sequence: keys to type, a key to press, a click in or beside the open formula, or a paste. */
type Step = string | { press: string } | { click: "inside" | "outside" } | { paste: string };

/**
 * What the student types into a formula, key by key, and the text the message keeps. A brace groups as in LaTeX, `\{`
 * is a brace that shows, and where the caret is (arrows, Home, End, a click, a deletion, a selection) decides what a
 * `}` closes.
 */
const TYPED: Array<[name: string, steps: Step[], stored: string]> = [
  ["exponents with braces", ["$x(t)=t^{3}-t^{2}$"], "$x\\left(t\\right)=t^3-t^2$"],
  ["an exponent of two digits", ["$t^{12}+1$"], "$t^{12}+1$"],
  ["an index with a sum", ["$x_{n+1}-y_{2}$"], "$x_{n+1}-y_2$"],
  ["an exponent inside an exponent", ["$e^{-x^{2}}$"], "$e^{-x^2}$"],
  ["a fraction", ["$\\frac{a+1}{b}$"], "$\\frac{a+1}{b}$"],
  ["a bare group with an exponent", ["${x+1}^2$"], "${x+1}^2$"],
  ["a closing brace with nothing open", ["$a}b$"], "$ab$"],
  ["a brace that shows", ["$A=\\{1,2\\} $"], "$A=\\{1,2\\}$"],
  // An unbraced script inside a braced one still ends after its digit, as it does with no braces at all.
  ["an unbraced exponent inside a braced one", ["$e^{-x^2+1}$"], "$e^{-x^2+1}$"],
  ["an index then an unbraced exponent", ["$x_{i}^2+1$"], "$x_{i}^2+1$"],
  ["a braced exponent holding an unbraced one", ["$a^{b^c}d$"], "$a^{b^{c}}d$"],
  ["an exponent in a fraction", ["$\\frac{x^2}{y}+1$"], "$\\frac{x^2}{y}+1$"],
  ["a root", ["$\\sqrt{x+1}+1$"], "$\\sqrt{x+1}+1$"],
  ["a bare group holding braced scripts", ["${a^{b}+c_{d}}e$"], "${a^{b}+c_{d}}e$"],
  ["an index and an exponent on one letter", ["$x^{a}_{b}$"], "$x_{b}^{a}$"],
  ["no braces at all", ["$t^3-t^2$"], "$t^3-t^2$"],
  ["no braces, two scripts", ["$x^2+1$"], "$x^2+1$"],
  ["a formula pasted whole", [{ paste: "$t^{3}-t^{2}$" }], "$t^{3}-t^{2}$"],
  // Where the caret is decides what a closing brace closes.
  ["arrows left and right inside the group", ["$t^{12", { press: "ArrowLeft" }, { press: "ArrowRight" }, "}+1$"], "$t^{12}+1$"],
  ["arrows out of the group and back in", ["$t^{12", { press: "ArrowRight" }, { press: "ArrowLeft" }, "}+1$"], "$t^{12}+1$"],
  ["Home then End, which leaves the group", ["$t^{1", { press: "Home" }, { press: "End" }, "2}+1$"], "$t^12+1$"],
  ["a click inside the group", ["$t^{12", { click: "inside" }, "}+1$"], "$t^{12}+1$"],
  ["a click beside the group", ["$t^{12", { click: "outside" }, "}+1$"], "$+1t^{12}$"],
  ["Backspace over the whole group", ["$t^{12", { press: "Backspace" }, { press: "Backspace" }, { press: "Backspace" }, "}+1$"], "$t+1$"],
  ["a selection inside the group replaced", ["$t^{12", { press: "Shift+ArrowLeft" }, { press: "Shift+ArrowLeft" }, "3}+1$"], "$t^3+1$"],
  ["everything selected and replaced", ["$t^{12", { press: "ControlOrMeta+a" }, "x}+1$"], "$x+1$"],
];

test("Ask composer: braces typed in a formula group as in LaTeX, and \\{ is a literal brace", async () => {
  test.setTimeout(240000);
  const { app, page, userData } = await launch();
  try {
    const box = page.getByRole("textbox", { name: "Messaggio" });
    await box.click();
    // MathLive loads shortly after the field appears; keys typed before that wait in a queue of their own.
    await page.waitForFunction(() => customElements.get("math-field") !== undefined);
    const failures: string[] = [];
    for (const [name, steps, stored] of TYPED) {
      // Every sequence starts in an empty field, whatever the one before left behind.
      await page.evaluate(() => sessionStorage.removeItem("pyxis-draft"));
      await page.reload();
      await box.click();
      await page.waitForFunction(() => customElements.get("math-field") !== undefined);
      for (const step of steps) {
        if (typeof step === "string") await page.keyboard.type(step);
        else if ("press" in step) await page.keyboard.press(step.press);
        else if ("paste" in step) {
          await page.evaluate((text) => navigator.clipboard.writeText(text), step.paste);
          await page.keyboard.press("ControlOrMeta+v");
        } else {
          // The caret goes before the first digit of the exponent (inside the group) or before the letter it belongs to.
          const glyph = step.click === "inside" ? "1" : "t";
          const at = await page.evaluate((text) => {
            const spans = [...document.querySelector("math-field")!.shadowRoot!.querySelectorAll(".ML__content span")];
            const rect = spans.find((span) => span.children.length === 0 && span.textContent === text)!.getBoundingClientRect();
            return { x: rect.x + 1, y: rect.y + rect.height / 2 };
          }, glyph);
          await page.mouse.click(at.x, at.y);
        }
      }
      try {
        await expect.poll(() => draft(page), { timeout: 3000 }).toBe(stored);
        expect(await box.innerText()).not.toMatch(/lbrace|rbrace/);
      } catch {
        failures.push(`${name}: expected ${stored}, got ${await draft(page)}`);
      }
    }
    expect(failures).toEqual([]);
  } finally {
    await app.close();
    removeTestFolder(userData);
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
    await page.keyboard.press("ControlOrMeta+v");
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
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.press("ControlOrMeta+c");
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
    removeTestFolder(userData);
  }
});
