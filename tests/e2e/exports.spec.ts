import AxeBuilder from "@axe-core/playwright";
import { _electron as electron, expect, test } from "@playwright/test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { unzipSync } from "fflate";

test("EXP-01/03 quiz PDF with math, exact attempt, native Anki save and export modal", async () => {
  const userData = mkdtempSync(join(tmpdir(), "pyxis-export-check-"));
  mkdirSync(".tmp", { recursive: true });
  mkdirSync(".shots", { recursive: true });
  const saved = join(userData, "export.bin");
  const env = {
    ...process.env,
    PYXIS_USER_DATA: userData,
    PYXIS_E2E: "1",
    PYXIS_E2E_SAVE: saved,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({
    args: [join(process.cwd(), "out/main/index.js")],
    env,
  });
  try {
    const page = await app.firstWindow();
    await page.emulateMedia({ reducedMotion: "reduce" });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.getByRole("button", { name: "Salta" }).click();
    await page.evaluate(() => window.pyxis.invoke("plans.list", {}));
    const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"));
    db.exec(`INSERT INTO plans (id,title,status,created_at,updated_at) VALUES ('export-plan','Fisica','ready',1,1);
      INSERT INTO topics (id,plan_id,title,position,created_at) VALUES ('export-topic','export-plan','Energia',0,1);
      INSERT INTO cards (id,plan_id,topic_id,front,back,created_at) VALUES ('card-basic','export-plan','export-topic','Forza $F=ma$','La forza è massa per accelerazione',1);
      INSERT INTO cards (id,plan_id,topic_id,front,back,created_at) VALUES ('card-cloze','export-plan','export-topic','{{c1::$E=mc^2$}}','Energia',2);`);
    const insert = db.prepare(
      "INSERT INTO items (id,plan_id,topic_id,kind,body_json,created_at) VALUES (?, 'export-plan','export-topic','quiz',?,?)",
    );
    insert.run(
      "exact-quiz",
      JSON.stringify({
        questions: [
          {
            stem: "Deriva $x^2$",
            options: ["$2x$", "$x$", "$0$", "$x^2$"],
            answer: { kind: "mcq", correct: 0 },
          },
          {
            stem: "Calcola l’integrale",
            answer: {
              kind: "open",
              reference: "$$\\int_0^1 x^2\\,dx = \\frac{1}{3}$$",
            },
          },
        ],
      }),
      1,
    );
    insert.run(
      "latest-quiz",
      JSON.stringify({
        questions: [
          { stem: "WRONG LATEST ITEM", answer: { kind: "tf", correct: true } },
        ],
      }),
      2,
    );
    db.exec(
      "INSERT INTO attempts (id,plan_id,item_id,started_at) VALUES ('export-attempt','export-plan','exact-quiz',1)",
    );
    db.close();
    const markdown = (await page.evaluate(() =>
      window.pyxis.invoke("study.markdown", {
        planId: "export-plan",
        kind: "quiz",
        attemptId: "export-attempt",
        answers: true,
      }),
    )) as { filename: string; markdown: string };
    expect(markdown.markdown).toContain("Answer: $2x$");
    expect(markdown.markdown).toContain("2. $x$");
    expect(markdown.markdown).not.toContain("WRONG LATEST ITEM");
    await expect(
      page.evaluate((file) => window.pyxis.exportPdf(file), markdown),
    ).resolves.toBe("saved");
    const pdf = readFileSync(saved);
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    writeFileSync(".tmp/m13-quiz.pdf", pdf);
    expect(await page.evaluate(() => window.pyxis.printData())).toBeNull();
    await expect(
      page.evaluate(() => window.pyxis.printReady()),
    ).rejects.toThrow("print-untrusted-sender");
    await expect(
      page.evaluate(() =>
        window.pyxis.saveArtifact({ filename: "../bad.md", base64: "YQ==" }),
      ),
    ).rejects.toThrow();
    await expect(
      page.evaluate(() =>
        window.pyxis.saveArtifact({
          filename: "large.pyxis",
          base64: "YWFh".repeat(4 * 1024 * 1024),
        }),
      ),
    ).resolves.toBe("saved");
    expect(readFileSync(saved).length).toBe(12 * 1024 * 1024);
    await page.evaluate(() => {
      location.hash = "/plans/export-plan/cards/export-topic";
    });
    const modal = page.getByRole("dialog");
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
        },
        { language, theme },
      );
      await page.reload();
      await page.setViewportSize({ width, height: 800 });
      await page.getByRole("button", { name: /^(Esporta|Export)$/ }).click();
      await expect(modal).toBeVisible();
      const pdfRadio = modal.getByRole("radio", { name: "PDF", exact: true });
      await pdfRadio.focus();
      await page.keyboard.press("ArrowRight");
      await expect(
        modal.getByRole("radio", { name: "Markdown", exact: true }),
      ).toBeChecked();
      await expect
        .poll(() =>
          modal.evaluate(
            (element) =>
              element
                .getAnimations({ subtree: true })
                .filter((a) => a.playState === "running").length,
          ),
        )
        .toBe(0);
      const audit = await new AxeBuilder({ page })
        .setLegacyMode()
        .include('[role="dialog"]')
        .analyze();
      expect(audit.violations).toEqual([]);
      await page.screenshot({
        path: `.shots/m13-export-${language}-${theme}-${width}.png`,
      });
      if (!(language === "en" && theme === "light"))
        await modal.getByRole("button", { name: /^(Annulla|Cancel)$/ }).click();
    }
    await modal.getByText("Anki", { exact: true }).click();
    await expect(
      modal.getByRole("radio", { name: "Anki", exact: true }),
    ).toBeChecked();
    await modal
      .getByRole("button", { name: /^(Salva file|Save file)$/, exact: true })
      .click();
    await expect(modal).not.toBeVisible();
    const entries = unzipSync(new Uint8Array(readFileSync(saved)));
    expect(Object.keys(entries).sort()).toEqual(["collection.anki2", "media"]);
    await page.evaluate(() => {
      location.hash = "/plans/export-plan";
    });
    await page
      .getByRole("button", { name: /^(Impostazioni del piano|Plan settings)$/ })
      .click();
    await page
      .getByRole("button", { name: /^(Esporta|Export)$/, exact: true })
      .click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: /^(Salva file|Save file)$/, exact: true })
      .click();
    await expect(
      page.getByRole("dialog", { name: /^(Esporta|Export)$/ }),
    ).not.toBeVisible();
    const planFile = JSON.parse(readFileSync(saved, "utf8"));
    expect(planFile.version).toBe(2);
    expect(planFile.cards).toHaveLength(2);
    const firstImport = (await page.evaluate(
      (file) =>
        window.pyxis.invoke("plans.import", file).catch((error: unknown) => {
          throw new Error(JSON.stringify(error));
        }),
      planFile,
    )) as { planId: string };
    const secondImport = (await page.evaluate(
      (file) =>
        window.pyxis.invoke("plans.import", file).catch((error: unknown) => {
          throw new Error(JSON.stringify(error));
        }),
      planFile,
    )) as { planId: string };
    expect(firstImport.planId).not.toBe(secondImport.planId);
    const importedCards = (await page.evaluate(
      (planId) => window.pyxis.invoke("study.anki", { planId }),
      secondImport.planId,
    )) as { noteCount: number };
    expect(importedCards.noteCount).toBe(2);
    const expectedPlans = await page.evaluate(() =>
      window.pyxis.invoke("plans.list", {}),
    );
    await expect(
      page.evaluate(() => window.pyxis.backupWorkspace()),
    ).resolves.toBe("saved");
    const freshData = mkdtempSync(join(tmpdir(), "pyxis-export-restore-"));
    const fresh = await electron.launch({
      args: [join(process.cwd(), "out/main/index.js")],
      env: { ...env, PYXIS_USER_DATA: freshData, PYXIS_E2E_ZIP: saved },
    });
    try {
      const freshPage = await fresh.firstWindow();
      await freshPage.getByRole("button", { name: "Salta" }).click();
      await expect(
        freshPage.evaluate(() => window.pyxis.restoreWorkspace()),
      ).resolves.toBe("restored");
      await expect
        .poll(() =>
          freshPage.evaluate(() => window.pyxis.invoke("plans.list", {})),
        )
        .toEqual(expectedPlans);
      writeFileSync(saved, "corrupt backup");
      await expect(
        freshPage.evaluate(() => window.pyxis.restoreWorkspace()),
      ).rejects.toThrow(/backup-corrupt/);
      await expect
        .poll(() =>
          freshPage.evaluate(() => window.pyxis.invoke("plans.list", {})),
        )
        .toEqual(expectedPlans);
    } finally {
      await fresh.close();
      rmSync(freshData, { recursive: true, force: true });
    }
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
});
