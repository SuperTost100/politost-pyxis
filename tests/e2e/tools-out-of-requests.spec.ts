import { expect, test, type Page } from "@playwright/test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchPyxis } from "./app-under-test";
import { expectNoAxeViolations } from "./axe";
import { removeTestFolder } from "./cleanup";
import { saveShot } from "./shots";
import { jobsNow, makeCards, RECORDED_CARDS, seedChimica, standInTools, useTools, type ToolId } from "./tools";

/** Starts Pyxis with the given tools signed in and ChatGPT out of requests, as its program reports it. */
async function start(
  tools: readonly ToolId[],
  options: { resetAt: string; until?: string; order?: string[]; pin?: boolean },
) {
  const stand = standInTools(tools);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-out-of-requests-"));
  const app = await launchPyxis({
    userData,
    env: {
      ...stand.env,
      PYXIS_E2E_PLAN_REPLIES: JSON.stringify({
        limited: { codex: { resetAt: options.resetAt, ...(options.until ? { until: options.until } : {}) } },
        cards: { cards: RECORDED_CARDS },
      }),
    },
  });
  const page = await app.firstWindow();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.getByRole("button", { name: "Salta" }).click();
  await expect(page).toHaveURL(/#\/ask$/);
  await useTools(page, tools);
  seedChimica(userData);
  if (options.order) await page.evaluate((order) => window.pyxis.invoke("engines.reorder", { order: order as never }), options.order);
  // A task the student set to a model by hand stays on its tool: when that tool runs out, the job stops and asks.
  if (options.pin)
    await page.evaluate(() =>
      window.pyxis.invoke("engines.setFeature", { feature: "cards", provider: "codex", model: "gpt-5.6-terra" }),
    );
  await page.evaluate(() => {
    localStorage.setItem("pyxis.lang", "it");
    location.hash = "/ask";
  });
  await page.reload();
  const close = async () => {
    await app.close();
    removeTestFolder(userData);
    rmSync(stand.bin, { recursive: true, force: true });
  };
  return { app, page, close };
}

const tomorrow = () => {
  const day = new Date();
  day.setDate(day.getDate() + 1);
  day.setHours(6, 0, 0, 0);
  return day;
};

const jobState = async (page: Page, id: string) => (await jobsNow(page)).find((job) => job.id === id);

async function openActivity(page: Page) {
  const list = page.locator(".px-jobs");
  if (!(await list.isVisible())) await page.getByRole("button", { name: /^Attività/ }).click();
  await expect(list).toBeVisible();
  return list;
}

test("Attività: a job whose tool ran out of requests asks, and each choice does what it says", async () => {
  test.skip(process.platform === "win32", "stand-in tools are shell scripts");
  test.setTimeout(240_000);
  const reset = tomorrow();
  const { page, close } = await start(["claude", "codex"], { resetAt: reset.toISOString(), pin: true });
  try {
    // ---- The task is set to ChatGPT by hand and ChatGPT is out of requests: the job stops, and the row asks.
    const first = await makeCards(page, "legami");
    await expect.poll(async () => (await jobState(page, first))?.state, { timeout: 30_000 }).toBe("failed");
    const list = await openActivity(page);
    const needs = list.getByRole("region", { name: "C'è bisogno di te" });
    const row = needs.locator(".px-jobs-out");
    await expect(row).toHaveCount(1);
    await expect(row.locator(".px-jobs-why")).toHaveText("ChatGPT ha finito le richieste. Tornano domani alle 06:00.");
    // The choices the mockup draws: go on with the next tool, wait for the requests; and the way to let it go.
    await expect(row.getByRole("button", { name: /^Continua con Claude/ })).toBeVisible();
    await expect(row.getByRole("button", { name: /^Aspetta domani/ })).toBeVisible();
    await expect(row.getByRole("button", { name: /^(Chiudi|Chiudi tutte)/ })).toBeVisible();
    await saveShot(page, "tools/row-it.png", { fullPage: true });
    await expectNoAxeViolations(page, { tags: ["wcag2a", "wcag2aa", "wcag21aa"] });

    // ---- "Continua con Claude": the job starts again on Claude, and the row goes with it. Nothing is announced twice.
    await row.getByRole("button", { name: /^Continua con Claude/ }).click();
    await expect.poll(async () => (await jobState(page, first))?.state, { timeout: 30_000 }).toBe("succeeded");
    await expect(row).toHaveCount(0);
    expect((await jobState(page, first))?.fallback).toEqual({ from: "ChatGPT", to: "Claude", reason: "limit" });
    const done = list.getByRole("region", { name: "Finite oggi" });
    await expect(done.getByText("ChatGPT ha finito le richieste, quindi ha risposto Claude.")).toBeVisible();
    // The student chose it just now: no toast says it again.
    await expect(page.locator(".ant-message").getByText("ChatGPT ha finito le richieste")).toHaveCount(0);

    // ---- "Aspetta domani": the row leaves "C'è bisogno di te" for "In corso", where it says when it starts again.
    const second = await makeCards(page, "mole");
    await expect.poll(async () => (await jobState(page, second))?.state, { timeout: 30_000 }).toBe("failed");
    await expect(row).toHaveCount(1);
    await row.getByRole("button", { name: /^Aspetta domani/ }).click();
    await expect(row).toHaveCount(0);
    const running = list.getByRole("region", { name: "In corso" });
    const waiting = running.locator(".px-jobs-waiting");
    await expect(waiting.locator(".px-jobs-sub")).toHaveText(
      "Riparto da sola quando tornano le richieste di ChatGPT, domani alle 06:00",
    );
    expect((await jobState(page, second))?.state).toBe("failed");
    await saveShot(page, "tools/waiting-it.png", { fullPage: true });

    // Smetti di aspettare gives the wait up: the row asks again.
    await waiting.getByRole("button", { name: /^Smetti di aspettare/ }).click();
    await expect(waiting).toHaveCount(0);
    await expect(row).toHaveCount(1);
    // Chiudi lets the job go: the row is gone and the job with it.
    await row.getByRole("button", { name: /^(Chiudi|Chiudi tutte)/ }).click();
    await expect(row).toHaveCount(0);
    await expect.poll(async () => (await jobState(page, second)) === undefined).toBe(true);
  } finally {
    await close();
  }
});

test("Attività: a job that waits starts again by itself when the tool's requests are back", async () => {
  test.skip(process.platform === "win32", "stand-in tools are shell scripts");
  test.setTimeout(240_000);
  const folder = mkdtempSync(join(tmpdir(), "pyxis-back-"));
  const back = join(folder, "back");
  // ChatGPT is out for a few seconds: long enough to see the wait, short enough to wait it out.
  const { page, close } = await start(["claude", "codex"], {
    resetAt: new Date(Date.now() + 25_000).toISOString(),
    until: back,
    pin: true,
  });
  try {
    const id = await makeCards(page, "legami");
    await expect.poll(async () => (await jobState(page, id))?.state, { timeout: 30_000 }).toBe("failed");
    const list = await openActivity(page);
    const row = list.locator(".px-jobs-out");
    // The same day: the button names the time.
    await expect(row.getByRole("button", { name: /^Aspetta fino alle \d\d:\d\d/ })).toBeVisible();
    await row.getByRole("button", { name: /^Aspetta fino alle/ }).click();
    await expect(list.locator(".px-jobs-waiting")).toHaveCount(1);
    expect((await jobState(page, id))?.state).toBe("failed");
    // The tool has its requests back: from here its calls are answered.
    writeFileSync(back, "");
    await expect.poll(async () => (await jobState(page, id))?.state, { timeout: 60_000 }).toBe("succeeded");
    await expect(list.locator(".px-jobs-waiting")).toHaveCount(0);
    await expect(list.getByRole("region", { name: "Finite oggi" })).toContainText("Flashcard");
    // Nothing moved to another tool: ChatGPT did the work after the wait.
    expect((await jobState(page, id))?.fallback).toBeUndefined();
  } finally {
    await close();
    rmSync(folder, { recursive: true, force: true });
  }
});

test("Attività: the row goes when the tool is back, and with no other tool it offers the tools in Settings", async () => {
  test.skip(process.platform === "win32", "stand-in tools are shell scripts");
  test.setTimeout(240_000);
  const folder = mkdtempSync(join(tmpdir(), "pyxis-back-"));
  const back = join(folder, "back");
  const { page, close } = await start(["codex"], {
    resetAt: new Date(Date.now() + 12_000).toISOString(),
    until: back,
    pin: true,
  });
  try {
    const id = await makeCards(page, "legami");
    await expect.poll(async () => (await jobState(page, id))?.state, { timeout: 30_000 }).toBe("failed");
    const list = await openActivity(page);
    const row = list.locator(".px-jobs-out");
    await expect(row).toHaveCount(1);
    // ChatGPT is the only tool: nothing to go on with, so the first choice is where to connect another.
    await expect(row.getByRole("button", { name: /^Continua con/ })).toHaveCount(0);
    await expect(row.getByRole("button", { name: "Strumenti AI" })).toBeVisible();
    await expect(row.getByRole("button", { name: /^Aspetta/ })).toBeVisible();
    await saveShot(page, "tools/row-alone-it.png", { fullPage: true });
    // The requests come back: the row says nothing that is no longer true, and the job can simply be retried.
    await expect(row).toHaveCount(0, { timeout: 40_000 });
    await expect(list.getByRole("button", { name: /^Riprova/ })).toBeVisible();
    writeFileSync(back, "");
    await list.getByRole("button", { name: /^Riprova/ }).click();
    await expect.poll(async () => (await jobState(page, id))?.state, { timeout: 30_000 }).toBe("succeeded");
  } finally {
    await close();
    rmSync(folder, { recursive: true, force: true });
  }
});

test("Attività: when the work goes on by itself with the next tool, the student is told once and not asked", async () => {
  test.skip(process.platform === "win32", "stand-in tools are shell scripts");
  test.setTimeout(240_000);
  const { page, close } = await start(["claude", "codex"], {
    resetAt: tomorrow().toISOString(),
    order: ["codex", "claude"],
  });
  try {
    // Flashcards are Pyxis's to place: ChatGPT is first, runs out, and Claude takes the job over by itself.
    await expect
      .poll(async () => {
        const features = (await page.evaluate(() => window.pyxis.invoke("engines.features", {}))) as Record<string, { provider: string }>;
        return features.cards?.provider;
      })
      .toBe("codex");
    const first = await makeCards(page, "legami");
    await expect.poll(async () => (await jobState(page, first))?.state, { timeout: 30_000 }).toBe("succeeded");
    const told = page.locator(".ant-message").getByText("ChatGPT ha finito le richieste, quindi ha risposto Claude.");
    await expect(told).toHaveCount(1);
    const list = await openActivity(page);
    // Nothing waits for the student, and the finished row says it once, quietly, with the tool that did the work.
    await expect(list.locator(".px-jobs-out")).toHaveCount(0);
    await expect(list.getByRole("region", { name: "C'è bisogno di te" })).toHaveCount(0);
    await expect(
      list.getByRole("region", { name: "Finite oggi" }).getByText("ChatGPT ha finito le richieste, quindi ha risposto Claude."),
    ).toHaveCount(1);
    await saveShot(page, "tools/by-itself-it.png", { fullPage: true });

    // The next job goes straight to Claude: ChatGPT is not tried again and nothing is said.
    const second = await makeCards(page, "mole");
    await expect.poll(async () => (await jobState(page, second))?.state, { timeout: 30_000 }).toBe("succeeded");
    expect((await jobState(page, second))?.fallback).toBeUndefined();
    await expect(told).toHaveCount(1);
  } finally {
    await close();
  }
});
