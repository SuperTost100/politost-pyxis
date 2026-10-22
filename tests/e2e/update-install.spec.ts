import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchPyxis } from "./app-under-test";

const packageVersion = JSON.parse(
  readFileSync(join(process.cwd(), "package.json"), "utf8"),
).version as string;
// One minor version ahead, so a version bump never hides the update.
const [major = 0, minor = 0] = packageVersion.split(".").map(Number);
const newerTag = `v${major}.${minor + 1}.0`;
const assetName = `PoliTost.Pyxis-${newerTag.slice(1)}.AppImage`;

test("update: download and install checks SHA256SUMS, replaces the AppImage, and deletes a mismatched download", async () => {
  test.setTimeout(120000);
  const root = mkdtempSync(join(tmpdir(), "pyxis-update-install-"));
  const userData = join(root, "profile");
  const assets = join(root, "release");
  const apps = join(root, "apps");
  const hold = join(root, "hold");
  const appImage = join(apps, `PoliTost.Pyxis-${packageVersion}.AppImage`);
  mkdirSync(assets);
  mkdirSync(apps);
  writeFileSync(appImage, "the installed AppImage");
  // Several chunks of the fake transport, so a held download shows real progress.
  const installer = randomBytes(300 * 1024);
  const sha256 = createHash("sha256").update(installer).digest("hex");
  writeFileSync(join(assets, assetName), installer);
  const sums = (hash: string) =>
    writeFileSync(
      join(assets, "SHA256SUMS"),
      `${hash}  ${assetName}\n${"0".repeat(64)}  politost-pyxis_${newerTag.slice(1)}_amd64.deb\n`,
    );
  sums(sha256);
  const download = (name: string) =>
    `https://github.com/PoliTost/pyxis-test/releases/download/${newerTag}/${name}`;
  const env = {
    PYXIS_E2E_RELEASE: JSON.stringify({
      tag_name: newerTag,
      body: "New study tools.",
      draft: false,
      prerelease: false,
      assets: [
        {
          name: assetName,
          size: installer.length,
          browser_download_url: download(assetName),
        },
        {
          name: "SHA256SUMS",
          size: 200,
          browser_download_url: download("SHA256SUMS"),
        },
      ],
    }),
    PYXIS_E2E_UPDATE_ASSETS: assets,
    PYXIS_E2E_UPDATE_HOLD: hold,
    PYXIS_E2E_APPIMAGE: appImage,
  };
  const app = await launchPyxis({ userData, env });
  const downloads = () =>
    existsSync(join(userData, "updates"))
      ? readdirSync(join(userData, "updates"))
      : [];
  try {
    const page = await app.firstWindow();
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.getByRole("button", { name: "Salta" }).click({ timeout: 60000 });
    // Skipping saves the profile, then moves to Exams; wait so a reload or route change cannot land on setup.
    await expect(page).toHaveURL(/#\/exams$/);
    // Skipping setup lands on Exams; open Settings > Updates after that navigation.
    await expect(
      page.getByRole("heading", { name: "Esami", level: 1 }),
    ).toBeVisible();
    await page.evaluate(() => {
      location.hash = "/settings/updates";
    });
    const panel = page.locator(".px-updates");
    const banner = page.locator(".px-update-notice");
    await expect(
      panel.getByText(`Pyxis ${newerTag} è disponibile.`),
    ).toBeVisible();
    await expect(banner).toBeVisible();
    const start = panel.getByRole("button", { name: "Scarica e installa" });

    // Cancel: the held download stops, its partial file goes, and the button comes back.
    writeFileSync(hold, "");
    await start.click();
    const progress = panel.getByRole("progressbar", {
      name: `Scarico Pyxis ${newerTag}`,
    });
    await expect(progress).toBeVisible();
    await expect(banner.getByRole("progressbar")).toBeVisible();
    await expect(panel.getByRole("status").last()).toContainText("%");
    await expect.poll(downloads).toEqual([`${assetName}.part`]);
    expect(
      (
        await new AxeBuilder({ page })
          .setLegacyMode(true)
          .include(".px-updates")
          .analyze()
      ).violations,
    ).toEqual([]);
    await panel.getByRole("button", { name: "Annulla il download" }).click();
    await expect(start).toBeVisible();
    await expect.poll(downloads).toEqual([]);
    expect(readFileSync(appImage, "utf8")).toBe("the installed AppImage");

    // Download, verify, replace.
    await start.click();
    await expect(progress).toBeVisible();
    rmSync(hold);
    await expect(
      panel.getByText(
        `Pyxis ${newerTag} è installato. Riavvia Pyxis per usarlo.`,
      ),
    ).toBeVisible();
    await expect(
      panel.getByRole("button", { name: "Riavvia Pyxis" }),
    ).toBeVisible();
    expect(readFileSync(appImage)).toEqual(installer);
    if (process.platform !== "win32")
      expect(statSync(appImage).mode & 0o777).toBe(0o755);
    expect(readdirSync(apps)).toEqual([
      `PoliTost.Pyxis-${packageVersion}.AppImage`,
    ]);
    expect(downloads()).toEqual([]);

    // A SHA256SUMS line that does not match: the error shows, the file is gone and the AppImage is untouched.
    sums("f".repeat(64));
    writeFileSync(appImage, "the installed AppImage");
    await page.evaluate(() => window.pyxis.cancelUpdate());
    await start.click();
    await expect(
      panel.getByText(
        "Il file scaricato non corrisponde al suo checksum, quindi Pyxis l’ha eliminato.",
        { exact: false },
      ),
    ).toBeVisible();
    await expect(
      panel.getByRole("button", { name: "Apri la pagina della versione" }),
    ).toBeVisible();
    await expect(panel.getByRole("button", { name: "Riprova" })).toBeVisible();
    expect(downloads()).toEqual([]);
    expect(readFileSync(appImage, "utf8")).toBe("the installed AppImage");
    expect(
      (
        await new AxeBuilder({ page })
          .setLegacyMode(true)
          .include(".px-updates")
          .include(".px-update-notice")
          .analyze()
      ).violations,
    ).toEqual([]);
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
