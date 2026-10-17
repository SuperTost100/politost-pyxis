import AxeBuilder from "@axe-core/playwright";
import {
  _electron as electron,
  expect,
  test,
  type Page,
} from "@playwright/test";
import { strToU8, zipSync } from "fflate";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { animationsSettled } from "./settled";

async function clean(page: Page) {
  expect(
    (await new AxeBuilder({ page }).setLegacyMode(true).analyze()).violations,
  ).toEqual([]);
}

// The window loads index.html from pyxis-app://app. CI also runs this against the packaged app.
test("window CSP: no string eval and no remote images in the main window", async () => {
  const userData = mkdtempSync(join(tmpdir(), "pyxis-csp-"));
  const image = "https://tracker.example.com/pixel.png";
  const env = { ...process.env, PYXIS_E2E: "1", PYXIS_USER_DATA: userData };
  delete env.ELECTRON_RUN_AS_NODE;
  const packaged = process.env.PYXIS_DIST_APP;
  const app = await electron.launch(
    packaged
      ? { executablePath: packaged, args: ["--use-mock-keychain"], env }
      : { args: [join(process.cwd(), "out/main/index.js")], env },
  );
  try {
    const page = await app.firstWindow();
    await expect(
      page.getByRole("heading", { name: "Ciao, sono Pyxis", exact: true }),
    ).toBeVisible({ timeout: 30_000 });
    expect(page.url()).toMatch(/^pyxis-app:\/\/app\/index\.html#/);
    // The route answers like the remote server would; a request the CSP blocks never reaches it.
    let requests = 0;
    await page.route(image, (route) => {
      requests++;
      return route.fulfill({
        contentType: "image/png",
        body: Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
          "base64",
        ),
      });
    });
    // Soft checks, so one run reports each missing protection. DevTools lets code it evaluates call eval past the
    // CSP, so the eval runs in a later task of the page's own.
    expect
      .soft(
        await page.evaluate(
          () =>
            new Promise<string>((resolve) =>
              setTimeout(() => {
                try {
                  resolve(String(eval("1")));
                } catch (error) {
                  resolve((error as Error).name);
                }
              }),
            ),
        ),
      )
      .toBe("EvalError");
    expect
      .soft(
        await page.evaluate(
          (src) =>
            new Promise<string>((resolve) => {
              const img = document.createElement("img");
              img.onload = () => resolve("loaded");
              img.onerror = () => resolve("blocked");
              img.src = src;
              document.body.append(img);
            }),
          image,
        ),
      )
      .toBe("blocked");
    expect.soft(requests).toBe(0);
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
});

// Up to 0.3.1 the window loaded from file://, where the language a student picked is stored. The update keeps it.
test("an update from the file:// window keeps the chosen language", async () => {
  const userData = mkdtempSync(join(tmpdir(), "pyxis-language-"));
  const env = { ...process.env, PYXIS_E2E: "1", PYXIS_USER_DATA: userData };
  delete env.ELECTRON_RUN_AS_NODE;
  const launch = () =>
    electron.launch({ args: [join(process.cwd(), "out/main/index.js")], env });
  const assets = join(process.cwd(), "out/renderer/assets");
  const stylesheet = join(
    assets,
    readdirSync(assets).find((name) => name.endsWith(".css"))!,
  );
  try {
    const first = await launch();
    const page = await first.firstWindow();
    await expect(
      page.getByRole("heading", { name: "Ciao, sono Pyxis", exact: true }),
    ).toBeVisible({ timeout: 30_000 });
    // What 0.3.1 left behind: the choice in file:// storage, saved window bounds and no carried language yet.
    await first.evaluate(async ({ BrowserWindow }, stylesheet) => {
      const old = new BrowserWindow({ show: false });
      await old.loadFile(stylesheet);
      await old.webContents.executeJavaScript(
        'localStorage.setItem("pyxis.lang", "en")',
      );
      old.destroy();
    }, stylesheet);
    await first.close();
    expect(JSON.parse(readFileSync(join(userData, "language.json"), "utf8"))).toEqual({ language: null });
    rmSync(join(userData, "language.json"));
    writeFileSync(join(userData, "window.json"), JSON.stringify({ width: 1280, height: 832 }));

    const updated = await launch();
    try {
      // The language is read from a hidden page that opens before the window.
      await expect
        .poll(() => updated.windows().some((w) => w.url().startsWith("pyxis-app:")), { timeout: 30_000 })
        .toBe(true);
      const window = updated.windows().find((w) => w.url().startsWith("pyxis-app:"))!;
      await expect(
        window.getByRole("heading", { name: "Hi, I'm Pyxis", exact: true }),
      ).toBeVisible({ timeout: 30_000 });
      await expect.poll(() => updated.windows().length).toBe(1);
    } finally {
      await updated.close();
    }
    expect(JSON.parse(readFileSync(join(userData, "language.json"), "utf8"))).toEqual({ language: "en" });
  } finally {
    rmSync(userData, { recursive: true, force: true });
  }
});

// This same loop runs against an unpackaged build or the locally installed app.
// Live mode uses the signed-in engine for plan, lesson and quiz generation.
test("release loop: onboarding, smartbook, plan, lesson, quiz, export and restore", async () => {
  test.setTimeout(process.env.PYXIS_LIVE_RELEASE === "1" ? 600000 : 240000);
  const root = mkdtempSync(join(tmpdir(), "pyxis-release-"));
  // The backup goes next to the app's data: Pyxis refuses to save one inside it.
  const userData = join(root, "userData");
  const book = join(root, "motion.ptsb");
  const backup = join(root, "backup.zip");
  const exported = join(root, "Motion.pyxis");
  writeFileSync(
    book,
    zipSync({
      "smartbook.json": strToU8(
        JSON.stringify({
          id: "motion",
          title: "Motion",
          access: "public",
          chapters: [{ id: "c1", number: 1, title: "Velocity", file: "01.md" }],
        }),
      ),
      "chapters/01.md": strToU8(
        "## p1 | Velocity\nVelocity is displacement divided by elapsed time. A displacement of 12 metres in 3 seconds gives a velocity of 4 metres per second.\n",
      ),
      "esami.md": strToU8(
        ':::exercise{id="velocity" chapter="1"}\nA displacement of 12 metres takes 3 seconds. What is the velocity?\n:::solution\nVelocity = displacement / time = 4 m/s.\n:::\n:::\n',
      ),
    }),
  );
  const replies = {
    markdown: {
      markdown:
        "## Velocity\nVelocity is displacement divided by elapsed time [P1].",
    },
    questions: {
      questions: Array.from({ length: 10 }, (_, i) => ({
        stem: `Velocity diagnostic ${i}`,
        options: ["Displacement/time", "Mass/time", "Heat/time", "Volume/time"],
        correct: 0,
        topicIndex: 0,
        passageIds: ["{{passage:0}}"],
        explanation: "Velocity measures displacement over time.",
      })),
    },
    quizQuestions: {
      questions: Array.from({ length: 10 }, (_, i) => ({
        kind: "tf",
        stem: `Velocity measures displacement over time. Statement {{question:${i}}}.`,
        correct: true,
        passageIds: ["{{passage:0}}"],
        explanation: "Velocity is displacement divided by elapsed time.",
      })),
    },
  };
  const live = process.env.PYXIS_LIVE_RELEASE === "1";
  const started = Date.now();
  let selectedModel: string | undefined;
  const env = {
    ...process.env,
    PYXIS_E2E: "1",
    PYXIS_USER_DATA: userData,
    PYXIS_E2E_FILE: book,
    PYXIS_E2E_SAVE: backup,
    PYXIS_E2E_ZIP: backup,
    PYXIS_E2E_PLAN_REPLIES: live ? undefined : JSON.stringify(replies),
    PYXIS_E2E_SIMULATION_REPLIES: live
      ? undefined
      : JSON.stringify({
          score: {
            score: 1,
            feedback: "Velocity is displacement divided by time.",
            missed: [],
          },
        }),
    PYXIS_E2E_REPLY: live
      ? undefined
      : "Velocity is displacement divided by time [P1].",
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const packaged = process.env.PYXIS_DIST_APP;
  const app = await electron.launch(
    packaged
      ? { executablePath: packaged, args: ["--use-mock-keychain"], env }
      : { args: [join(process.cwd(), "out/main/index.js")], env },
  );
  if (!live)
    app.process().stderr?.on("data", (chunk) => console.error(String(chunk)));
  try {
    console.log("release: window");
    const page = await app.firstWindow();
    if (process.env.PYXIS_E2E_HIDDEN === "1") {
      expect(
        await app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().map((window) => ({
            visible: window.isVisible(),
            focused: window.isFocused(),
          })),
        ),
      ).toEqual([{ visible: false, focused: false }]);
    }
    await page.emulateMedia({ reducedMotion: "reduce" });
    if (process.env.PYXIS_E2E_HIDDEN === "1") {
      console.log(
        "release: hidden rendering",
        await app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().map((window) => ({
            offscreen: window.webContents.isOffscreen(),
            frameRate: window.webContents.getFrameRate(),
          })),
        ),
      );
      console.log(
        "release: frame sample",
        await page.evaluate(
          () =>
            new Promise<number>((resolve) => {
              let frames = 0;
              const start = performance.now();
              const tick = () => {
                frames++;
                if (performance.now() - start >= 1000) resolve(frames);
                else requestAnimationFrame(tick);
              };
              requestAnimationFrame(tick);
            }),
        ),
      );
    }
    // The first launch of a fresh install waits for core to create the workspace before onboarding shows; on a
    // Windows runner that can take longer than the default 5 s.
    await expect(
      page.getByRole("heading", { name: "Ciao, sono Pyxis", exact: true }),
    ).toBeVisible({ timeout: 30_000 });
    await clean(page);
    await page.getByRole("button", { name: "Salta", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("heading", { name: "Esami", exact: true }),
    ).toBeVisible();
    await page.getByText("Fonti", { exact: true }).click();
    await page
      .getByRole("button", { name: "Aggiungi fonti", exact: true })
      .click();
    await animationsSettled(page);
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Scegli i file", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Motion", exact: true }),
    ).toBeVisible();
    await expect
      .poll(async () =>
        (
          await page.evaluate(() => window.pyxis.invoke("sources.list", {}))
        ).some((s) => s.title === "Motion" && s.status === "ready"),
      )
      .toBe(true);
    await clean(page);
    if (live) {
      const models = await page.evaluate(() =>
        window.pyxis.invoke("engines.models", { provider: "claude" }),
      );
      const model =
        process.env.PYXIS_RELEASE_MODEL ??
        models.find((m) => /sonnet/i.test(m.name))?.id;
      selectedModel = model;
      await page.evaluate(() =>
        window.pyxis.invoke("engines.acknowledge", { providers: ["claude"] }),
      );
      expect(model).toBeTruthy();
      for (const feature of [
        "default",
        "plan",
        "lesson",
        "grading",
        "chat",
      ] as const) {
        await page.evaluate(
          ({ feature, model }) =>
            window.pyxis.invoke("engines.setFeature", {
              feature,
              provider: "claude",
              model,
            }),
          { feature, model: model! },
        );
      }
    }
    await page.getByTitle("Piani", { exact: true }).click();
    await page
      .getByRole("button", { name: "Nuovo piano", exact: true })
      .click();
    await page.locator("#plan-title").fill("Motion");
    for (let step = 0; step < 3; step++) {
      if (step === 1) await page.getByRole("button", { name: "Entro 10 giorni", exact: true }).click();
      await page.getByRole("button", { name: "Continua", exact: true }).click();
    }
    // The book is in the library already, so it comes in through the library picker.
    await page
      .getByRole("button", { name: "Dalla tua libreria", exact: true })
      .click();
    const picker = page.getByRole("dialog", { name: "Aggiungi dalla libreria" });
    await picker.getByRole("checkbox", { name: /Motion/ }).check();
    await picker.getByRole("button", { name: /^Aggiungi 1 fonte$/ }).click();
    await expect(page.getByText("1 fonte nel piano")).toBeVisible();
    for (let step = 0; step < 2; step++) {
      await page.getByRole("button", { name: "Continua", exact: true }).click();
    }
    await page
      .getByRole("button", { name: "Crea il piano", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Apri il piano", exact: true })
      .click({ timeout: 240000 });
    await clean(page);
    console.log("release: plan");
    const plans = await page.evaluate(() =>
      window.pyxis.invoke("plans.list", {}),
    );
    const planId = plans.find((p) => p.title === "Motion")!.id;
    const plan = await page.evaluate(
      (planId) => window.pyxis.invoke("plans.read", { planId }),
      planId,
    );
    console.log("release: lesson");
    const topicId = plan.topics[0]!.id;
    // Study routes can be opened directly without asserting obsolete mastery unlocks.
    await page.evaluate(
      ({ planId, topicId }) => {
        window.location.hash = `/plans/${planId}/lesson/${topicId}`;
      },
      { planId, topicId },
    );
    await expect(page.locator("article.passage")).toContainText(
      /velocity|velocità/i,
      { timeout: 120000 },
    );
    await clean(page);
    await page.evaluate(
      ({ planId, topicId }) => {
        window.location.hash = `/plans/${planId}/quiz/${topicId}`;
      },
      { planId, topicId },
    );
    await page.getByRole("button", { name: "Personalizza" }).click();
    await page
      .getByRole("button", { name: "Solo vero o falso", exact: true })
      .click();
    await page.getByRole("button", { name: "Inizia", exact: true }).click();
    console.log("release: quiz");
    for (let i = 0; i < 10; i++) {
      console.log(`release: question ${i}`);
      await page
        .getByRole("button", { name: "A. Vero", exact: true })
        .click({ timeout: 120000 });
      await page.getByRole("button", { name: "Verifica", exact: true }).click();
      if (i === 0) await clean(page);
      await page
        .getByRole("button", {
          name: i === 9 ? "Vedi risultato" : "Avanti",
          exact: true,
        })
        .click({ timeout: 120000 });
    }
    await expect(
      page.getByText(/su 10$/, { exact: false }).first(),
    ).toBeVisible();
    await clean(page);
    await page.evaluate(
      ({ planId, topicId }) => {
        location.hash = `/plans/${planId}/cards/${topicId}`;
      },
      { planId, topicId },
    );
    if (live)
      await expect
        .poll(
          async () =>
            (
              await page.evaluate(
                ({ planId, topicId }) =>
                  window.pyxis.invoke("study.cardsBuild", { planId, topicId }),
                { planId, topicId },
              )
            )?.state,
          { timeout: 120000 },
        )
        .toBe("succeeded");
    await page
      .getByRole("textbox", { name: "Davanti", exact: true })
      .fill("What is velocity?");
    await page
      .getByRole("textbox", { name: "Dietro", exact: true })
      .fill("Displacement divided by elapsed time.");
    await page.getByRole("button", { name: "Salva", exact: true }).click();
    await page.getByRole("button", { name: /^Gira\b/ }).click();
    await page.getByRole("button", { name: /^Bene\b/ }).click();
    await expect
      .poll(
        async () =>
          (
            await page.evaluate(
              ({ planId, topicId }) =>
                window.pyxis.invoke("study.queue", { planId, topicId }),
              { planId, topicId },
            )
          ).learning,
      )
      .toBeGreaterThan(0);
    await clean(page);
    console.log("release: cards");
    await page.evaluate((planId) => {
      location.hash = `/plans/${planId}/simulation`;
    }, planId);
    await page.getByRole("button", { name: "Inizia", exact: true }).click();
    await page
      .getByRole("textbox", { name: "La tua risposta", exact: true })
      .fill("Velocity = 12 m / 3 s = 4 m/s.");
    await page.getByRole("button", { name: "Consegna", exact: true }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Consegna", exact: true })
      .click();
    await expect(page.locator(".px-sim-results")).toBeVisible({
      timeout: 120000,
    });
    await expect(page.locator(".px-sim-results")).toContainText(
      live ? /claude|sonnet/i : /fixture/i,
    );
    await clean(page);
    console.log("release: simulation");
    await page.evaluate((planId) => {
      location.hash = `/plans/${planId}/progress`;
    }, planId);
    await expect(page.locator(".px-preparation")).toBeVisible();
    await clean(page);
    console.log("release: progress");
    await page.evaluate((planId) => {
      window.location.hash = `/plans/${planId}`;
    }, planId);
    await app.evaluate((_electron, path) => {
      process.env.PYXIS_E2E_SAVE = path;
    }, exported);
    await page
      .getByRole("button", { name: "Impostazioni del piano", exact: true })
      .click();
    await page.getByRole("button", { name: "Esporta", exact: true }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Salva file", exact: true })
      .click();
    // Windows shows the file before the write has finished, so wait until it parses.
    const readExport = () => {
      try {
        return JSON.parse(readFileSync(exported, "utf8")) as { title: string; topics: unknown[] };
      } catch {
        return null;
      }
    };
    await expect.poll(readExport, { timeout: 30000 }).not.toBeNull();
    console.log("release: export");
    const file = readExport()!;
    expect(file.title).toBe("Motion");
    expect(file.topics).toHaveLength(1);
    await page.evaluate(() => {
      window.location.hash = "/settings/data";
    });
    await app.evaluate((_electron, path) => {
      process.env.PYXIS_E2E_SAVE = path;
    }, backup);
    await page
      .getByRole("button", { name: "Copia di sicurezza", exact: true })
      .click();
    // A full backup of the workspace passed 5 s on the hosted Windows runner.
    await expect(
      page.getByText("La copia è pronta.", { exact: true }),
    ).toBeVisible({ timeout: 60000 });
    console.log("release: backup");
    expect(existsSync(backup)).toBe(true);
    await clean(page);
    await page.evaluate(
      (planId) => window.pyxis.invoke("plans.delete", { planId }),
      planId,
    );
    expect(
      await page.evaluate(() => window.pyxis.invoke("plans.list", {})),
    ).toHaveLength(0);
    console.log("release: restore");
    await page.getByRole("button", { name: "Ripristina", exact: true }).click();
    await Promise.all([
      page.waitForEvent("load"),
      page.getByRole("button", { name: /^Sostituisci / }).click(),
    ]);
    await expect
      .poll(async () =>
        (await page.evaluate(() => window.pyxis.invoke("plans.list", {}))).map(
          (p) => p.title,
        ),
      )
      .toEqual(["Motion"]);
    await page.evaluate(() => {
      window.location.hash = "/ask";
    });
    // The plan joins the chat through the Fonti chip in the composer.
    await page.getByRole("button", { name: "Fonti", exact: true }).click();
    const scope = page.getByRole("region", { name: "Fonti in uso" });
    await scope.getByRole("button", { name: "Aggiungi fonti" }).click();
    await scope.getByRole("button", { name: "Motion", exact: true }).first().click();
    await page.keyboard.press("Escape");
    await expect(scope).toBeHidden();
    await page
      .getByRole("textbox", { name: "Messaggio", exact: true })
      .fill("What is velocity?");
    await page.getByRole("button", { name: "Invia", exact: true }).click();
    await expect(
      page.getByRole("button", { name: /Velocity/ }).first(),
    ).toBeVisible({ timeout: 120000 });
    await clean(page);
    await page
      .getByRole("button", { name: /Velocity/ })
      .first()
      .click();
    await expect(page.getByText(/12 metres/).first()).toBeVisible();
    await clean(page);
    if (live)
      writeFileSync(
        ".tmp/m15-live-release.json",
        JSON.stringify(
          {
            model: selectedModel,
            latencyMs: Date.now() - started,
            packaged: Boolean(packaged),
            checks: [
              "onboarding",
              "import",
              "plan",
              "lesson",
              "quiz",
              "cards",
              "simulation",
              "progress",
              "export",
              "backup",
              "restore",
              "cited chat",
            ],
            at: new Date().toISOString(),
          },
          null,
          2,
        ),
      );
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// The Mac bundle leaves out SwiftShader (build/after-pack.cjs). The packaged app must report the same GPU features as
// Electron's own build, which still has it.
test("the packaged app reports the same GPU features as Electron's build", async () => {
  const packaged = process.env.PYXIS_DIST_APP;
  test.skip(!packaged, "Set PYXIS_DIST_APP to the packaged executable.");
  async function features(executablePath?: string) {
    const userData = mkdtempSync(join(tmpdir(), "pyxis-gpu-"));
    const env = { ...process.env, PYXIS_E2E: "1", PYXIS_USER_DATA: userData };
    delete env.ELECTRON_RUN_AS_NODE;
    const app = await electron.launch(
      executablePath
        ? { executablePath, args: ["--use-mock-keychain"], env }
        : { args: [join(process.cwd(), "out/main/index.js")], env },
    );
    try {
      const page = await app.firstWindow();
      await page.waitForLoadState("load");
      return await app.evaluate(({ app }) => app.getGPUFeatureStatus());
    } finally {
      await app.close();
      rmSync(userData, { recursive: true, force: true });
    }
  }
  const electronBuild = await features();
  const packagedBuild = await features(packaged);
  expect(packagedBuild).toEqual(electronBuild);
});
