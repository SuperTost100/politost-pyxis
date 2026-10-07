import { _electron as electron, expect, test } from "@playwright/test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("SRC-07 a dropped file gets a native grant and nothing else does", async () => {
  test.setTimeout(120000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-drop-"));
  const note = join(userData, "note.txt");
  const script = join(userData, "run.sh");
  writeFileSync(note, "La velocità descrive lo spostamento nel tempo.\n");
  writeFileSync(script, "echo no\n");
  const env = { ...process.env, PYXIS_USER_DATA: userData, PYXIS_E2E: "1" };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.PYXIS_E2E_FILE;
  const app = await electron.launch({
    args: [join(process.cwd(), "out/main/index.js")],
    env,
  });
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Salta" }).click();
    await page.evaluate(() => window.pyxis.invoke("sources.list", {}));
    // A File built in script has no path on disk, so the drop grants nothing for it.
    const forged = await page.evaluate(() =>
      window.pyxis.grantDroppedFiles([new File(["x"], "forged.txt")]),
    );
    expect(forged).toEqual({ paths: [], skipped: 1 });
    // Before a drop, core refuses a path it was never given.
    const early = await page.evaluate(
      (path) =>
        window.pyxis.invoke("sources.import", { path }).then(
          () => "imported",
          (error: { code?: string }) => error.code,
        ),
      note,
    );
    expect(early).toBe("file-access-denied");

    await page.getByText("Fonti", { exact: true }).click();
    await page.getByRole("button", { name: "Aggiungi fonti" }).click();
    const dialog = page.getByRole("dialog");
    // The dialog mounts after the click; a slow runner reaches the drop before the zone exists.
    await expect(dialog.locator(".px-library-upload")).toBeVisible();
    await page.evaluate(() => {
      const probe = document.createElement("input");
      probe.type = "file";
      probe.id = "drop-probe";
      probe.multiple = true;
      document.body.append(probe);
    });
    await page.setInputFiles("#drop-probe", [note, script]);
    // The same real File objects a drop carries, sent through the zone's own handlers.
    await page.evaluate(() => {
      const probe = document.querySelector<HTMLInputElement>("#drop-probe")!;
      const transfer = new DataTransfer();
      for (const file of Array.from(probe.files ?? []))
        transfer.items.add(file);
      document
        .querySelector(".px-library-upload")!
        .dispatchEvent(
          new DragEvent("drop", {
            dataTransfer: transfer,
            bubbles: true,
            cancelable: true,
          }),
        );
    });
    // One file imports. The unsupported one is reported, so the dialog stays open.
    await expect(
      dialog.getByRole("alert").or(dialog.getByRole("status")).first(),
    ).toBeVisible();
    await expect
      .poll(async () => {
        const rows = await page.evaluate(() =>
          window.pyxis.invoke("sources.list", {}),
        );
        return rows.map((row) => row.title);
      })
      .toEqual(["note"]);
    // The skipped file never got a grant.
    const refused = await page.evaluate(
      (path) =>
        window.pyxis.invoke("sources.import", { path }).then(
          () => "imported",
          (error: { code?: string }) => error.code,
        ),
      script,
    );
    expect(refused).toBe("file-access-denied");
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
});
