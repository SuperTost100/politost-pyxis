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
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function clean(page: Page) {
  expect(
    (await new AxeBuilder({ page }).setLegacyMode(true).analyze()).violations,
  ).toEqual([]);
}

// This same loop runs against an unpackaged build or the locally installed app.
// Live mode uses the signed-in engine for plan, lesson and quiz generation.
test("release loop: onboarding, smartbook, plan, lesson, quiz, export and restore", async () => {
  test.setTimeout(process.env.PYXIS_LIVE_RELEASE === "1" ? 600000 : 120000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-release-"));
  const book = join(userData, "motion.ptsb");
  const backup = join(userData, "backup.zip");
  const exported = join(userData, "Motion.pyxis");
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
  try {
    console.log("release: window");
    const page = await app.firstWindow();
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect(
      page.getByRole("heading", { name: "Iniziamo", exact: true }),
    ).toBeVisible();
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
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Scegli un file", exact: true })
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
        window.pyxis.invoke("engines.acknowledge", { provider: "claude" }),
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
      await page.getByRole("button", { name: "Continua", exact: true }).click();
    }
    await page.getByRole("button", { name: "Motion", exact: true }).click();
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
    await page.getByRole("slider", { name: "Numero di domande" }).focus();
    await page.keyboard.press("Home");
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
      await page.getByRole("button", { name: "Correggi", exact: true }).click();
      if (i === 0) await clean(page);
      await page
        .getByRole("button", {
          name: i === 9 ? "Termina il quiz" : "Avanti",
          exact: true,
        })
        .click({ timeout: 120000 });
    }
    await expect(
      page.getByText(/su 100/, { exact: false }).first(),
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
    await expect.poll(() => existsSync(exported)).toBe(true);
    console.log("release: export");
    const file = JSON.parse(readFileSync(exported, "utf8"));
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
    await expect(
      page.getByText("La copia è pronta.", { exact: true }),
    ).toBeVisible();
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
    await Promise.all([
      page.waitForEvent("load"),
      page.getByRole("button", { name: "Ripristina", exact: true }).click(),
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
    await page.getByRole("button", { name: "Motion", exact: true }).click();
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
    rmSync(userData, { recursive: true, force: true });
  }
});
