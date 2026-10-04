import { _electron as electron, expect, test } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

test("onboarding save and invalid plan imports remain retryable", async () => {
  const userData = mkdtempSync(join(tmpdir(), "pyxis-form-recovery-"));
  const env = { ...process.env, PYXIS_USER_DATA: userData, PYXIS_E2E: "1" };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({
    args: [join(process.cwd(), "out/main/index.js")],
    env,
  });
  try {
    const page = await app.firstWindow();
    const skip = page.getByRole("button", { name: "Salta", exact: true });
    await expect(skip).toBeVisible();
    const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"));
    try {
      db.exec(
        "CREATE TRIGGER fail_profile BEFORE INSERT ON profile BEGIN SELECT RAISE(FAIL, 'test storage failure'); END;",
      );
      await skip.click();
      await expect(
        page.getByText("Il profilo non è stato salvato. Riprova."),
      ).toBeVisible();
      await expect(skip).toBeEnabled();
      await expect(
        page.getByRole("button", { name: "Continua", exact: true }),
      ).toBeEnabled();
      db.exec("DROP TRIGGER fail_profile;");
      await skip.click();
      await expect(page).toHaveURL(/exams/);
      db.exec(
        "INSERT INTO plans (id,title,status,created_at,updated_at) VALUES ('retry-plan','Fisica','ready',1,1);",
      );
      await page.reload();
      const input = page.locator('input[type="file"]').first();
      const invalid = {
        name: "invalid.pyxis",
        mimeType: "application/json",
        buffer: Buffer.from('{"bad":true}'),
      };
      for (let retry = 0; retry < 2; retry++) {
        await input.setInputFiles(invalid);
        await expect(
          page.getByText(
            "Il piano non è stato importato. Scegli un file di piano .pyxis valido e riprova.",
          ),
        ).toBeVisible();
        await expect(input).toHaveValue("");
        await expect(
          page.getByRole("button", { name: "Importa un piano", exact: true }),
        ).toBeEnabled();
      }
    } finally {
      db.close();
    }
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
});
