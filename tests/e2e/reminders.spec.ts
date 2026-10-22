import { _electron as electron, expect, test } from "@playwright/test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { quitPyxis } from "./app-exit";

test("study reminders are off by default; the switch and the time are saved", async () => {
  test.setTimeout(90_000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-reminders-"));
  const env = {
    ...process.env,
    PYXIS_USER_DATA: userData,
    PYXIS_E2E: "1",
  };
  delete (env as NodeJS.ProcessEnv).ELECTRON_RUN_AS_NODE;
  const launch = () =>
    electron.launch({ args: [join(process.cwd(), "out/main/index.js")], env });
  let app = await launch();
  try {
    let page = await app.firstWindow();
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.getByRole("button", { name: "Salta" }).click();
    await expect(page).toHaveURL(/#\/exams$/);
    await page.evaluate(() => {
      location.hash = "/settings/reminders";
    });
    const toggle = page.getByRole("switch", { name: "Ricordami di ripassare" });
    await expect(toggle).not.toBeChecked();
    await expect(page.getByLabel("Ora")).toHaveCount(0);
    expect(
      await page.evaluate(() => window.pyxis.reminders.get()),
    ).toMatchObject({ enabled: false, time: "18:00" });

    await toggle.click();
    await expect(toggle).toBeChecked();
    const time = page.getByLabel("Ora");
    await expect(time).toHaveValue("18:00");
    await time.fill("07:30");
    await time.blur();
    await expect
      .poll(() => page.evaluate(() => window.pyxis.reminders.get()))
      .toMatchObject({ enabled: true, time: "07:30" });
    await quitPyxis(app);

    // The next launch keeps both.
    app = await launch();
    page = await app.firstWindow();
    await page.evaluate(() => {
      location.hash = "/settings/reminders";
    });
    await expect(
      page.getByRole("switch", { name: "Ricordami di ripassare" }),
    ).toBeChecked();
    await expect(page.getByLabel("Ora")).toHaveValue("07:30");
    expect(
      JSON.parse(readFileSync(join(userData, "reminders.json"), "utf8")),
    ).toMatchObject({ enabled: true, time: "07:30" });
    await quitPyxis(app);
  } finally {
    await app.close().catch(() => undefined);
    rmSync(userData, { recursive: true, force: true });
  }
});
