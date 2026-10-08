import { importPickedSource } from "./picked-source";
import AxeBuilder from "@axe-core/playwright";
import { _electron as electron, expect, test } from "@playwright/test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  realpathSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const packageVersion = JSON.parse(
  readFileSync(join(process.cwd(), "package.json"), "utf8"),
).version as string;
// The fake release is always one minor version ahead, so a version bump never hides the notice.
const [major = 0, minor = 0] = packageVersion.split(".").map(Number);
const newerTag = `v${major}.${minor + 1}.0`;

test("SET-05/06 verified workspace move, failed move recovery and daily release notice", async () => {
  test.setTimeout(90000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-settings-data-"));
  const parent = join(userData, "destination");
  mkdirSync(parent);
  const text =
    "The work done by a constant force is the scalar product of force and displacement.";
  const sourcePath = join(userData, "energy.txt");
  writeFileSync(sourcePath, text);
  const env = {
    ...process.env,
    PYXIS_USER_DATA: userData,
    PYXIS_E2E: "1",
    PYXIS_E2E_MOVE: parent,
    PYXIS_E2E_RELEASE: JSON.stringify({
      tag_name: newerTag,
      body: "New study tools.\n".repeat(1200),
      draft: false,
      prerelease: false,
    }),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  let app = await electron.launch({
    args: [join(process.cwd(), "out/main/index.js")],
    env,
  });
  try {
    let page = await app.firstWindow();
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.getByRole("button", { name: "Salta" }).click();
    const imported = (await importPickedSource(page, app, sourcePath)) as {
      sourceId: string;
    };
    await expect
      .poll(
        async () =>
          (
            (await page.evaluate(() =>
              window.pyxis.invoke("sources.list", {}),
            )) as Array<{ id: string; status: string }>
          ).find((s) => s.id === imported.sourceId)?.status,
      )
      .toBe("ready");
    const original = await page.evaluate(() => window.pyxis.workspacePath());
    const db = new DatabaseSync(join(original, "pyxis.db"), { timeout: 10000 });
    db.exec(
      "INSERT INTO plans (id,title,status,created_at,updated_at) VALUES ('move-plan','Energy','ready',1,1)",
    );
    const blob = db
      .prepare("SELECT blob_sha FROM sources WHERE id=?")
      .get(imported.sourceId) as { blob_sha: string };
    db.close();
    const expected = await page.evaluate(() =>
      window.pyxis.invoke("plans.list", {}),
    );
    await page.evaluate(() => {
      location.hash = "/settings/data";
    });
    await page
      .getByRole("button", { name: "Sposta lo spazio di lavoro", exact: true })
      .click();
    await expect(
      page.getByText("Spazio di lavoro spostato.", { exact: true }),
    ).toBeVisible();
    const moved = realpathSync.native(join(parent, "Pyxis workspace"));
    expect(await page.evaluate(() => window.pyxis.workspacePath())).toBe(moved);
    expect(existsSync(original)).toBe(false);
    expect(
      readFileSync(
        join(moved, "blobs", blob.blob_sha.slice(0, 2), blob.blob_sha),
        "utf8",
      ),
    ).toBe(text);
    expect(
      await page.evaluate(() => window.pyxis.invoke("plans.list", {})),
    ).toEqual(expected);
    expect(
      await page.evaluate(
        async (sha) => (await fetch(`pyxis-blob://${sha}`)).text(),
        blob.blob_sha,
      ),
    ).toBe(text);
    await expect(
      page.evaluate(() => window.pyxis.moveWorkspace()),
    ).rejects.toThrow();
    expect(
      await page.evaluate(() => window.pyxis.invoke("plans.list", {})),
    ).toEqual(expected);
    expect(await page.evaluate(() => window.pyxis.workspacePath())).toBe(moved);
    for (const [language, theme, width] of [
      ["it", "dark", 1280],
      ["it", "light", 960],
      ["en", "dark", 1280],
      ["en", "light", 960],
    ] as const) {
      await page.evaluate(
        async ({ language, theme }) => {
          localStorage.setItem("pyxis.lang", language);
          localStorage.removeItem("pyxis-dismissed-release");
          await window.pyxis.setAppearance(theme);
          location.hash = "/settings/updates";
        },
        { language, theme },
      );
      await page.reload();
      await page.setViewportSize({ width, height: 800 });
      const notice = page.locator(".px-update-notice");
      await expect(notice).toBeVisible();
      await notice
        .getByRole("button", { name: /^(Dettagli|Details)$/ })
        .click();
      await expect(notice.locator("pre")).toBeVisible();
      const box = await notice.boundingBox();
      expect(box!.height).toBeLessThanOrEqual(680);
      expect(
        (
          await new AxeBuilder({ page })
            .setLegacyMode()
            .include(".px-update-notice")
            .analyze()
        ).violations,
      ).toEqual([]);
      mkdirSync(".shots", { recursive: true });
      await page.screenshot({
        path: `.shots/m14-update-${language}-${theme}-${width}.png`,
      });
      await notice
        .getByRole("button", { name: /^(Chiudi avviso|Dismiss notice)$/ })
        .click();
      await expect(notice).not.toBeVisible();
      await page.evaluate(() => {
        location.hash = "/settings/about";
      });
      await page.locator(".px-about-notices > summary").click();
      await page
        .locator(".px-about-search input")
        .fill("@politost/content-core");
      await expect(page.locator(".px-about-packages > li")).toHaveCount(1);
      await expect(page.locator(".px-about-packages")).toContainText("MIT");
      await page.locator(".px-about-packages > li summary").click();
      await page.locator(".px-about-license > summary").click();
      const license = page.locator(".px-about-license pre");
      await license.focus();
      await expect(license).toBeFocused();
      expect(
        (
          await new AxeBuilder({ page })
            .setLegacyMode()
            .include(".px-about")
            .analyze()
        ).violations,
      ).toEqual([]);
      await page.locator(".px-about").scrollIntoViewIfNeeded();
      await page.screenshot({
        path: `.shots/m14-about-${language}-${theme}-${width}.png`,
      });
      const update = await page.evaluate(() => window.pyxis.checkUpdates());
      expect(update.state).toBe("available");
      expect(update.current).toBe(packageVersion);
    }
    await app.close();
    app = await electron.launch({
      args: [join(process.cwd(), "out/main/index.js")],
      env,
    });
    page = await app.firstWindow();
    await expect
      .poll(() => page.evaluate(() => window.pyxis.workspacePath()))
      .toBe(moved);
    expect(
      await page.evaluate(() => window.pyxis.invoke("plans.list", {})),
    ).toEqual(expected);
    expect(
      await page.evaluate(
        async (sha) => (await fetch(`pyxis-blob://${sha}`)).text(),
        blob.blob_sha,
      ),
    ).toBe(text);
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
});
