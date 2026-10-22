import { expect, test } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { launchPyxis } from "./app-under-test";

test("onboarding save and invalid plan imports remain retryable", async () => {
  const userData = mkdtempSync(join(tmpdir(), "pyxis-form-recovery-"));
  const app = await launchPyxis({ userData });
  try {
    const page = await app.firstWindow();
    const skip = page.getByRole("button", { name: "Salta", exact: true });
    await expect(skip).toBeVisible();
    const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), {
      timeout: 10000,
    });
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
        page.getByRole("button", { name: "Inizia", exact: true }),
      ).toBeEnabled();
      db.exec("DROP TRIGGER fail_profile;");
      await skip.click();
      // Anchored to the hash: a checkout path can contain "exams" too.
      await expect(page).toHaveURL(/#\/exams$/);
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
          page.getByRole("button", { name: "Altro", exact: true }),
        ).toBeEnabled();
      }
      // The More menu works from the keyboard and leads to the shared-plan page.
      const trigger = page.getByRole("button", {
        name: "Altro",
        exact: true,
      });
      await trigger.focus();
      await page.keyboard.press("Enter");
      const menu = page.getByRole("menu");
      await expect(menu.getByRole("menuitem")).toHaveText([
        "Importa da un file .pyxis",
        "Importa da un link",
        "Gestisci materie",
      ]);
      await expect(trigger).toHaveAttribute("aria-expanded", "true");
      await page.keyboard.press("Escape");
      await expect(menu).toBeHidden();
      await expect(trigger).toBeFocused();
      await page.keyboard.press("Enter");
      await menu.getByRole("menuitem", { name: "Importa da un link" }).click();
      await expect(page).toHaveURL(/#\/exams\/get$/);
    } finally {
      db.close();
    }
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
});
