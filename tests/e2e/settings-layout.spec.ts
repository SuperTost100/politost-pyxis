import { expect, test } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchPyxis } from "./app-under-test";
import { removeTestFolder } from "./cleanup";
import { fromChiediToExams } from "./doors";
import { expectNoAxeViolations } from "./axe";
import { saveShot } from "./shots";

test("settings show six pages in a sidebar from 960px and drill down below it", async () => {
  const userData = mkdtempSync(join(tmpdir(), "pyxis-settings-layout-"));
  const app = await launchPyxis({ userData });
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Salta" }).click();
    // Skipping setup opens Exams; a route set before that lands is replaced by it.
    await fromChiediToExams(page);
    const sidebar = page.getByRole("navigation", { name: "Impostazioni" });
    // One way back above "Impostazioni", to where the student was. Narrow, with a section open, it reads "Impostazioni"
    // and closes the section instead, so the page never has two.
    const back = page.getByRole("button", { name: "Torna a Impostazioni", exact: true });
    const leave = page.getByRole("button", { name: "Torna a Chiedi", exact: true });

    await page.setViewportSize({ width: 1280, height: 800 });
    await page.evaluate(() => {
      window.location.hash = "#/settings";
    });
    // Two panes: the six pages are in the sidebar, Informazioni at its foot, and one is already open beside it.
    const pages = sidebar.getByRole("button");
    await expect(pages).toHaveText([
      "Profilo",
      "Strumenti AI",
      /^Studio/,
      "Aspetto e lingua",
      "Dati e privacy",
      "Informazioni",
    ]);
    await expect(sidebar.getByRole("button", { name: "Profilo" })).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("heading", { level: 1, name: "Profilo" })).toBeVisible();
    const foot = (await pages.last().boundingBox())!;
    const above = (await pages.nth(4).boundingBox())!;
    expect(foot.y - (above.y + above.height)).toBeGreaterThan(100);
    await expect(back).toHaveCount(0);
    // Wide, the page's own way back sits above both panes, on every section.
    await expect(leave).toBeVisible();
    await expect(leave).toHaveText("Chiedi");

    await sidebar.getByRole("button", { name: "Aspetto e lingua" }).click();
    await expect(page).toHaveURL(/#\/settings\/appearance$/);
    await expect(sidebar.getByRole("button", { name: "Aspetto e lingua" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(page.getByRole("heading", { level: 2, name: "Tema" })).toBeVisible();
    await expect(page.getByRole("radio", { name: "Italiano" })).toBeChecked();
    await expect(back).toHaveCount(0);
    await expect(leave).toBeVisible();

    // A link to one section opens the page that holds it, at that section.
    await page.evaluate(() => {
      window.location.hash = "#/settings/updates";
    });
    await expect(sidebar.getByRole("button", { name: "Informazioni" })).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("heading", { level: 2, name: "Aggiornamenti" })).toBeInViewport();
    // A section that fits in the window opens without scrolling the page's titles away, even in a short window.
    await page.setViewportSize({ width: 1280, height: 600 });
    await page.evaluate(() => {
      window.location.hash = "#/settings/version";
    });
    await expect(page.getByRole("heading", { level: 2, name: "Versione e licenze" })).toBeInViewport();
    await expect(page.getByRole("heading", { level: 1, name: "Informazioni" })).toBeInViewport({ ratio: 1 });
    // With the licences open the version section is taller than the window. From the page's own link, scrolled into the
    // middle of that section, the version link brings its heading back.
    await page.evaluate(() => {
      window.location.hash = "#/settings/about";
    });
    // A disclosure's chevron points right while it is closed and turns down when it opens (global.css), where the
    // browser's own triangle used to be.
    const licences = page.locator(".px-about-notices > summary");
    const turn = () => licences.evaluate((summary) => getComputedStyle(summary, "::before").rotate);
    expect(await licences.evaluate((summary) => getComputedStyle(summary).listStyleType)).toBe("none");
    expect(await turn()).toBe("-45deg");
    await licences.click();
    await expect.poll(turn).toBe("45deg");
    const version = page.locator("#settings-version");
    await expect.poll(async () => (await version.boundingBox())!.height).toBeGreaterThan(1200);
    await page.evaluate(() => {
      const top = document.getElementById("settings-version")!.getBoundingClientRect().top + window.scrollY;
      window.scrollTo({ top: top + 400 });
    });
    await expect(page.getByRole("heading", { level: 2, name: "Versione e licenze" })).not.toBeInViewport();
    await page.evaluate(() => {
      window.location.hash = "#/settings/version";
    });
    await expect(page.getByRole("heading", { level: 2, name: "Versione e licenze" })).toBeInViewport();
    // It stops below the strip that drags the window on macOS, here forced on, not behind it.
    await page.evaluate(() => (document.documentElement.dataset.platform = "darwin"));
    await page.evaluate(() => {
      window.location.hash = "#/settings/updates";
    });
    await page.evaluate(() => {
      const top = document.getElementById("settings-version")!.getBoundingClientRect().top + window.scrollY;
      window.scrollTo({ top: top + 400 });
    });
    await page.evaluate(() => {
      window.location.hash = "#/settings/version";
    });
    const headingTop = () =>
      page.evaluate(() => Math.round(document.querySelector("#settings-version h2")!.getBoundingClientRect().top));
    // The scroll lands near the top, below the strip. Before it, the heading sits above the window, so both bounds are
    // checked together.
    await expect
      .poll(async () => {
        const top = await headingTop();
        return top >= 28 && top < 120;
      })
      .toBe(true);
    await page.evaluate(() => (document.documentElement.dataset.platform = "linux"));
    await page.locator(".px-about-notices > summary").click();
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.evaluate(() => {
      window.location.hash = "#/settings/reminders";
    });
    await expect(sidebar.getByRole("button", { name: /^Studio/ })).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("heading", { level: 2, name: "Promemoria di studio" })).toBeInViewport();
    await page.evaluate(() => {
      window.location.hash = "#/settings/diagnostics";
    });
    await expect(sidebar.getByRole("button", { name: "Strumenti AI" })).toHaveAttribute("aria-current", "page");
    // Diagnostics has no section of its own: the page opens at the engines section, wherever the window was scrolled.
    await expect
      .poll(() => page.evaluate(() => Math.round(document.getElementById("settings-engines")!.getBoundingClientRect().top)))
      .toBeLessThan(200);
    await expect
      .poll(() => page.evaluate(() => Math.round(document.getElementById("settings-engines")!.getBoundingClientRect().top)))
      .toBeGreaterThanOrEqual(0);

    // The buttons under the backups have the mockup's 8px gap between them.
    await sidebar.getByRole("button", { name: "Dati e privacy" }).click();
    const backup = (await page.getByRole("button", { name: "Salva una copia in un file…", exact: true }).boundingBox())!;
    const restore = (await page.getByRole("button", { name: "Ripristina da un file…", exact: true }).boundingBox())!;
    expect(Math.round(restore.x - (backup.x + backup.width))).toBe(8);
    // A link to a group of the Data page opens the page at that group.
    await page.evaluate(() => {
      window.location.hash = "#/settings/privacy";
    });
    await expect(sidebar.getByRole("button", { name: "Dati e privacy" })).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("heading", { level: 2, name: "Privacy" })).toBeInViewport();

    // Crossing 960px re-lays the page out without remounting the open section, so an open drawer stays open.
    await page.evaluate(() =>
      window.pyxis.invoke("engines.acknowledge", {
        providers: ["claude", "codex", "agent", "antigravity"],
      }),
    );
    await sidebar.getByRole("button", { name: "Strumenti AI" }).click();
    await page.getByRole("switch", { name: "Opzioni avanzate" }).click();
    await page.getByRole("button", { name: /^Claude/ }).click();
    const drawer = page.getByRole("dialog", { name: "Claude", exact: true });
    await expect(drawer).toBeVisible();
    await page.setViewportSize({ width: 800, height: 800 });
    await expect(sidebar).toHaveCount(0);
    await expect(drawer).toBeVisible();
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(sidebar).toBeVisible();
    await expect(drawer).toBeVisible();
    await drawer.getByRole("button", { name: /^(Close|Chiudi)$/ }).click();
    await expect(drawer).toHaveCount(0);
    await sidebar.getByRole("button", { name: "Dati e privacy" }).click();

    // Below 960px the sections are pages again, with a way back to the list.
    await page.setViewportSize({ width: 800, height: 800 });
    await expect(sidebar).toHaveCount(0);
    await expect(back).toBeVisible();
    await expect(back).toHaveText("Impostazioni");
    await expect(leave).toHaveCount(0);
    await back.click();
    await expect(page).toHaveURL(/#\/settings$/);
    await expect(page.getByRole("button", { name: /^Studio/ })).toBeVisible();
    // The list has the page's own way back, and the section's is gone.
    await expect(back).toHaveCount(0);
    await expect(leave).toBeVisible();
    await page.getByRole("button", { name: /^Aspetto/ }).click();
    await expect(page).toHaveURL(/#\/settings\/appearance$/);
    await expect(back).toBeVisible();
    await expect(leave).toHaveCount(0);
    // Vai > Indietro does what the control does: it closes the section.
    await app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById("back")?.click());
    await expect(page).toHaveURL(/#\/settings$/);
    // A section is a move inside Settings: one more press leaves it.
    await page.getByRole("button", { name: /^Aspetto/ }).click();
    await back.click();
    await leave.click();
    await expect(page).toHaveURL(/#\/ask$/);
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});

test("Studio: one choice is radio rows, on or off a switch, the text size a segmented control, new cards a stepper", async () => {
  const userData = mkdtempSync(join(tmpdir(), "pyxis-settings-controls-"));
  const app = await launchPyxis({ userData });
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.getByRole("button", { name: "Salta" }).click();
    await fromChiediToExams(page);
    await page.evaluate(() => {
      window.location.hash = "#/settings/study";
    });
    const profile = () => page.evaluate(() => window.pyxis.invoke("profile.get", {} as never)) as Promise<{
      followups: boolean;
      textSize: string;
      dyslexia: boolean;
    }>;

    // Pyxis chooses how to explain on each question, so the section has no default way, only the follow-up questions.
    await expect(page.getByRole("radiogroup", { name: "Come ti spiega" })).toHaveCount(0);
    const followups = page.getByRole("switch", { name: "Proponi domande per approfondire" });
    await expect(followups).toHaveAttribute("aria-checked", "true");
    await followups.click();
    await expect.poll(async () => (await profile()).followups).toBe(false);

    // Reading: the size is a segmented control that arrows move, and the dyslexia spacing a switch.
    const size = page.getByRole("radiogroup", { name: "Dimensione del testo" });
    await expect(size.getByRole("radio", { name: "Normale" })).toHaveAttribute("aria-checked", "true");
    await size.getByRole("radio", { name: "Normale" }).focus();
    await page.keyboard.press("ArrowRight");
    await expect(size.getByRole("radio", { name: "Grande" })).toHaveAttribute("aria-checked", "true");
    await expect(page.locator("html")).toHaveAttribute("data-text", "lg");
    await page.getByRole("switch", { name: "Spaziatura per la dislessia" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-dyslexia", "on");
    await expect(page.getByText("Anteprima", { exact: true })).toBeVisible();

    // New cards a day: − and + step by five and save; a number typed in saves when the field is left.
    const cards = page.getByRole("textbox", { name: "Nuove flashcard giornaliere per ogni esame" });
    await expect(cards).toHaveValue("20");
    await page.getByRole("button", { name: "Più" }).click();
    await expect(cards).toHaveValue("25");
    await cards.fill("7");
    await cards.press("Enter");
    await expect.poll(() => page.evaluate(() => window.pyxis.invoke("study.cardSettings", {} as never))).toEqual(
      expect.objectContaining({ newPerDay: 7 }),
    );
    await expect(page.getByText(/^Con 7 e tre esami, ogni giorno ne iniziano fino a 21\./)).toBeVisible();
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});

test("Profile: text rows save on leaving, the year is a stepper, the level a dropdown and the interests tags", async () => {
  const userData = mkdtempSync(join(tmpdir(), "pyxis-settings-profile-"));
  const app = await launchPyxis({ userData });
  try {
    const page = await app.firstWindow();
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.getByRole("button", { name: "Salta" }).click();
    await fromChiediToExams(page);
    await page.evaluate(() => {
      window.location.hash = "#/settings/profile";
    });
    const profile = () =>
      page.evaluate(() => window.pyxis.invoke("profile.get", {} as never)) as Promise<{
        displayName: string;
        school: string;
        year: string;
        interests: string[];
        interestsOn: boolean;
      }>;
    // The old grid of level buttons is gone.
    await expect(page.locator(".choice")).toHaveCount(0);

    // A name is saved when the field is left, and the head row shows it with its monogram.
    const name = page.getByRole("textbox", { name: "Nome", exact: true });
    await name.fill("  Ada  ");
    await name.press("Tab");
    await expect.poll(async () => (await profile()).displayName).toBe("Ada");
    await expect(page.locator(".px-settings-who")).toContainText("Ada");
    await expect(page.locator(".px-settings-avatar")).toHaveText("A");
    // Escape puts the stored value back and saves nothing.
    const school = page.getByRole("textbox", { name: "Scuola", exact: true });
    await school.fill("Liceo");
    await school.press("Escape");
    await expect(school).toHaveValue("");
    expect((await profile()).school).toBe("");

    // The year starts empty; + starts at 1 and steps by one, and the head names the year.
    const year = page.getByRole("textbox", { name: "Anno", exact: true });
    await expect(year).toHaveValue("");
    const more = page.getByRole("group", { name: "Anno" }).getByRole("button", { name: "Più" });
    await more.click();
    await more.click();
    await expect(year).toHaveValue("2");
    await expect.poll(async () => (await profile()).year).toBe("2");
    await expect(page.locator(".px-settings-who")).toContainText("Università · 2° anno");

    // Interests: Enter and a comma add a tag, a repeat is skipped, × removes one, and each change is saved.
    const add = page.getByRole("textbox", { name: "Aggiungi un interesse" });
    await add.fill("cinema");
    await add.press("Enter");
    await add.pressSequentially("chitarra,");
    await add.fill("Cinema");
    await add.press("Enter");
    await expect.poll(async () => (await profile()).interests).toEqual(["cinema", "chitarra"]);
    await saveShot(page.locator("#settings-profile"), "settings-profile-tags.png");
    await expectNoAxeViolations(page, { include: ["#settings-profile"] });
    await page.getByRole("button", { name: "Togli cinema" }).click();
    await expect.poll(async () => (await profile()).interests).toEqual(["chitarra"]);
    await expect(add).toBeFocused();
    // Text left in the field is added when the field is left.
    await add.fill("Formula 1");
    await add.blur();
    await expect.poll(async () => (await profile()).interests).toEqual(["chitarra", "Formula 1"]);
    // Off hides the tags but keeps them.
    await page.getByRole("switch", { name: "Usa i miei interessi negli esempi" }).click();
    await expect(add).toHaveCount(0);
    await expect.poll(async () => (await profile()).interestsOn).toBe(false);
    expect((await profile()).interests).toEqual(["chitarra", "Formula 1"]);
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});
