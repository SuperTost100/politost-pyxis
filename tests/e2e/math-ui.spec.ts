import { expect, test, type Page } from "@playwright/test";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MathCheck } from "../../src/shared/math-check";
import { launchPyxis, setUp } from "./app-under-test";
import { expectNoAxeViolations } from "./axe";
import { saveShot } from "./shots";
import { removeTestFolder } from "./cleanup";
import { fromChiediToExams } from "./doors";
import { attachPythonRecording } from "./python-recording";

/**
 * How long the app lets a run take: the ceiling of `RUN_CEILING_MS` in `src/main/python-runtime.ts`, which covers the load of
 * Pyodide (`LOAD_TIMEOUT_MS` in `src/sandbox/host.js` is 60 s) and the run. A wait for a run's first output that gives up
 * sooner fails where the app would still succeed: on the hosted Intel Mac a run was recorded working, with Python still
 * loading 29 s after it started (`python-start` mark, run 44200146183). Keep it equal to that constant.
 */
const APP_RUN_CEILING_MS = 90_000;

/**
 * Waits for the first output of a run for as long as the app allows it, and ends at once, with what the page says, when the
 * run failed in the app's own way (a notice such as the load timeout, or an output that is not the expected one).
 */
async function expectFirstOutput(page: Page, expected: string) {
  const output = page.locator(".px-python pre").first();
  const notice = page.locator(".px-python p[role=status]");
  await expect
    .poll(
      async () => {
        // A throw ends the wait at once, which a value that is not the expected one would not.
        if ((await notice.count()) > 0) throw new Error(`the page says: ${await notice.first().innerText()}`);
        if ((await output.count()) === 0) return "waiting";
        const text = await output.innerText();
        if (text !== "" && text !== expected) throw new Error(`unexpected output: ${text}`);
        return text;
      },
      { timeout: APP_RUN_CEILING_MS, intervals: [250, 500, 1000] },
    )
    .toBe(expected);
}

async function launch(reply?: string, extra: Record<string, string> = {}) {
  const userData = mkdtempSync(join(tmpdir(), "pyxis-math-ui-"));
  const { version } = JSON.parse(
    readFileSync("resources/pyodide-manifest.json", "utf8"),
  );
  const pack = join(userData, "workspace/runtimes/pyodide", version);
  mkdirSync(pack, { recursive: true });
  cpSync(".tmp/pyodide", pack, { recursive: true });
  const app = await launchPyxis({ userData, env: { PYXIS_E2E_REPLY: reply || undefined, ...extra } });
  return setUp(app, userData, async () => {
    const page = await app.firstWindow();
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.getByRole("button", { name: "Salta" }).click();
    await fromChiediToExams(page);
    return { app, page, userData };
  });
}

test("MATH-02 Python UI and failed Solver badge in both languages and themes", async () => {
  test.skip(
    !existsSync(".tmp/pyodide/pyodide.js"),
    "Requires the pinned Pyodide runtime fixture in .tmp/pyodide.",
  );
  // Four Python runs, one per language and theme, passed 90 s on the hosted Intel Mac.
  test.setTimeout(180000);
  const step = "La derivata è $x$.";
  const reply = `${step}\n\n\`\`\`check\n${JSON.stringify({ kind: "derivative", expr: "x**2*sin(x)", claimed: "x", step })}\n\`\`\``;
  const { app, page, userData } = await launch(reply);
  try {
    for (const [language, theme, width] of [
      ["it", "dark", 1280],
      ["it", "light", 960],
      ["en", "dark", 1280],
      ["en", "light", 960],
    ] as const) {
      await page.evaluate(
        async ({ language, theme }) => {
          localStorage.setItem("pyxis.lang", language);
          await window.pyxis.setAppearance(theme);
          window.location.hash = "/tools/python";
        },
        { language, theme },
      );
      await page.reload();
      await app.evaluate(
        ({ BrowserWindow }, width) =>
          BrowserWindow.getAllWindows()
            .find((w) => w.webContents.getURL().includes("#/tools/python"))!
            .setSize(width, 800),
        width,
      );
      const code = page.getByRole("textbox", {
        name: /Codice Python|Python code/,
      });
      await code.fill("print('42')\nraise ValueError('example error')");
      // The button in Italian, the Ctrl or Cmd+Enter shortcut from the editor in English.
      if (language === "it")
        await page.getByRole("button", { name: /Esegui|Run/ }).click();
      else await code.press("ControlOrMeta+Enter");
      await expectFirstOutput(page, "42\n");
      await expect(page.locator(".px-python pre").last()).toContainText(
        "example error",
      );
      await expectNoAxeViolations(page);
      await saveShot(page, `m9-python-${language}-${theme}-${width}.png`);
    }
    const result = (await page.evaluate(() =>
      window.pyxis.invoke("chats.ask", {
        text: "derive x^2 sin x",
        allowGeneral: true,
      }),
    )) as { chatId: string };
    await page.evaluate((chatId) => {
      window.location.hash = `/ask/${chatId}`;
    }, result.chatId);
    await expect(page.locator(".px-check-badge.is-failed")).toBeVisible({
      timeout: 30000,
    });
    await page.locator(".px-check-badge.is-failed").focus();
    await expect(page.locator(".px-check-badge.is-failed")).toBeFocused();
    await expectNoAxeViolations(page);
    await saveShot(page, "m9-failed-light.png");
  } catch (error) {
    await attachPythonRecording(app);
    throw error;
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});

test("Ctrl+Enter pressed before the Python page knows Python is there runs the code once it does", async () => {
  test.skip(
    !existsSync(".tmp/pyodide/pyodide.js"),
    "Requires the pinned Pyodide runtime fixture in .tmp/pyodide.",
  );
  test.setTimeout(120000);
  // The page reads which packs are there, and the answer to that read is held until the test has sent the key.
  const hold = mkdtempSync(join(tmpdir(), "pyxis-python-hold-"));
  const release = join(hold, "release");
  const { app, page, userData } = await launch(undefined, { PYXIS_E2E_READ_DELAY: `tools.runtime=until:${release}` });
  try {
    await page.evaluate(() => {
      window.location.hash = "/tools/python";
    });
    const code = page.getByRole("textbox", { name: /Codice Python|Python code/ });
    await code.fill("print('42')");
    // Run is disabled until the read has returned, and the read does not return before the file below exists, so the key
    // is sent to a page that does not know yet whether Python is there, however slow the runner is.
    await page.evaluate(() => {
      const run = [...document.querySelectorAll("button")].find((button) => /^(Esegui|Run)$/.test(button.getAttribute("aria-label") ?? button.textContent?.trim() ?? ""));
      if (!run) throw new Error("no Run button");
      if (!run.disabled) throw new Error("the read of the Python pack had already returned");
      document.querySelector("textarea")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, metaKey: true, bubbles: true, cancelable: true }));
    });
    writeFileSync(release, "");
    await expectFirstOutput(page, "42\n");
  } catch (error) {
    await attachPythonRecording(app);
    throw error;
  } finally {
    await app.close();
    removeTestFolder(userData);
    removeTestFolder(hold);
  }
});

test("Graph several functions and mark where they meet", async () => {
  test.skip(
    !existsSync(".tmp/pyodide/pyodide.js"),
    "Requires the pinned Pyodide runtime fixture in .tmp/pyodide.",
  );
  const { app, page, userData } = await launch();
  try {
    await page.evaluate(() => {
      window.location.hash = "/tools/graph";
    });
    const first = page.getByRole("textbox", { name: "Funzione f" });
    await first.fill("x^2");
    await page.getByRole("button", { name: "Aggiungi una funzione" }).click();
    await page.getByRole("textbox", { name: "Funzione g" }).fill("x+2");
    const meets = page.getByRole("region", { name: "Intersezioni" });
    await expect(meets.getByText("f e g")).toHaveCount(2);
    await expect(meets.getByText("(-1, 1)")).toBeVisible();
    await expect(meets.getByText("(2, 4)")).toBeVisible();
    await expect(page.locator(".px-graph-meet")).toHaveCount(2);
    // Each curve has its own stroke; g is dashed.
    await expect(page.locator("polyline[stroke-dasharray]").first()).toBeVisible();
    await page.getByRole("textbox", { name: "Funzione g" }).fill("x^2+1");
    await expect(
      meets.getByText("Le curve non si incontrano in questo intervallo."),
    ).toBeVisible();
    await page.getByRole("button", { name: "Rimuovi g" }).click();
    await expect(page.getByRole("textbox", { name: "Funzione g" })).toHaveCount(0);
    await expect(page.locator(".px-graph-meets")).toHaveCount(0);
    await expectNoAxeViolations(page);
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});

test("MATH-02 ASK-05 live Solver verification and attached drawing vision", async () => {
  test.skip(
    process.env.PYXIS_LIVE_MATH !== "1",
    "Set PYXIS_LIVE_MATH=1 for signed-in engine validation.",
  );
  test.skip(
    !existsSync(".tmp/pyodide/pyodide.js"),
    "Requires the pinned Pyodide runtime fixture in .tmp/pyodide.",
  );
  test.setTimeout(180000);
  const { app, page, userData } = await launch();
  try {
    const models = (await page.evaluate(() =>
      window.pyxis.invoke("engines.models", { provider: "claude" }),
    )) as Array<{ id: string; name: string }>;
    const model = models.find((m) => /sonnet/i.test(m.name))!.id;
    await page.evaluate(
      (model) =>
        window.pyxis.invoke("engines.setFeature", {
          feature: "chat",
          provider: "claude",
          model,
        }),
      model,
    );
    const solver = (await page.evaluate(() =>
      window.pyxis.invoke("chats.ask", {
        text: "derive x^2 sin x",
        allowGeneral: true,
      }),
    )) as {
      chatId: string;
      message: {
        body: string;
        checks?: Array<{
          kind: MathCheck["kind"];
          expr: string;
          claimed: string;
          step: string;
        }>;
        modelId: string;
      };
    };
    const derivative = solver.message.checks?.find(
      (c) => c.kind === "derivative",
    );
    expect(derivative).toBeDefined();
    expect(
      await page.evaluate(
        (claim) => window.pyxis.invoke("tools.check", claim),
        derivative!,
      ),
    ).toMatchObject({ state: "verified" });
    await page.evaluate((id) => {
      window.location.hash = `/ask/${id}`;
    }, solver.chatId);
    await expect(
      page.locator(".px-check-badge.is-verified").first(),
    ).toBeVisible({ timeout: 30000 });
    await saveShot(page, "m9-live-verified.png");
    await page.evaluate(() => {
      window.location.hash = "/tools/graph";
    });
    await expect(page.getByRole("textbox", { name: "Funzione f" })).toHaveValue(
      "sin(x)/x",
    );
    expect(await page.locator("svg polyline").count()).toBeGreaterThanOrEqual(
      3,
    );
    await expect(page.getByText(/Integrale da/)).toBeVisible();
    await saveShot(page, "m9-graph.png");
    await page.evaluate(() => {
      window.location.hash = "/tools/whiteboard";
    });
    // Canvas has an accessible label but no implicit image role.
    const board = page.locator('canvas[aria-label="Lavagna"]');
    await board.waitFor();
    const rect = (await board.boundingBox())!;
    await page.mouse.move(
      rect.x + rect.width * 0.2,
      rect.y + rect.height * 0.7,
    );
    await page.mouse.down();
    await page.mouse.move(
      rect.x + rect.width * 0.5,
      rect.y + rect.height * 0.2,
      { steps: 20 },
    );
    await page.mouse.move(
      rect.x + rect.width * 0.8,
      rect.y + rect.height * 0.7,
      { steps: 20 },
    );
    await page.mouse.move(
      rect.x + rect.width * 0.2,
      rect.y + rect.height * 0.7,
      { steps: 20 },
    );
    await page.mouse.up();
    await page.getByRole("button", { name: "Allega alla chat" }).click();
    const attachment = page.getByText(/pyxis-board-.*\.png/);
    await expect(attachment).toBeVisible();
    const drawingPath = join(tmpdir(), (await attachment.innerText()).trim());
    const vision = (await page.evaluate(
      (path) =>
        window.pyxis.invoke("chats.ask", {
          text: "Name the geometric shape in this drawing. One sentence.",
          files: [path],
          allowGeneral: true,
        }),
      drawingPath,
    )) as { message: { body: string; modelId: string } };
    expect(vision.message.body).toMatch(/triang/i);
    writeFileSync(
      ".shots/m9-live-check.json",
      JSON.stringify(
        { model, solver: solver.message, vision: vision.message },
        null,
        2,
      ),
    );
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});
