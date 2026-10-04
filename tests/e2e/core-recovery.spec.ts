import { _electron as electron, expect, test } from "@playwright/test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("slow core bootstrap beyond 3s still connects the renderer", async () => {
  const userData = mkdtempSync(join(tmpdir(), "pyxis-core-slow-"));
  const env = {
    ...process.env,
    PYXIS_USER_DATA: userData,
    PYXIS_E2E: "1",
    PYXIS_E2E_CORE_DELAY: "4500",
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({
    args: [join(process.cwd(), "out/main/index.js")],
    env,
  });
  try {
    const started = Date.now();
    const page = await app.firstWindow();
    await expect
      .poll(
        () =>
          page
            .evaluate(() => window.pyxis.invoke("plans.list", {}))
            .then(() => true)
            .catch(() => false),
        { timeout: 20000 },
      )
      .toBe(true);
    expect(Date.now() - started).toBeGreaterThan(2500);
    await expect(
      page.getByText(/Il motore interno non riesce ad avviarsi/),
    ).toHaveCount(0);
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
});

test("failed core startup stops retrying and can recover after explicit retry", async () => {
  const userData = mkdtempSync(join(tmpdir(), "pyxis-core-recovery-"));
  const dbPath = join(userData, "workspace", "pyxis.db");
  mkdirSync(join(userData, "workspace"));
  writeFileSync(dbPath, "corrupt test database");
  const env = { ...process.env, PYXIS_USER_DATA: userData, PYXIS_E2E: "1" };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({
    args: [join(process.cwd(), "out/main/index.js")],
    env,
  });
  let exits = 0;
  app.process().stderr?.on("data", (chunk) => {
    exits += String(chunk).split("pyxis-core exited").length - 1;
  });
  try {
    const page = await app.firstWindow();
    await expect(
      page.getByText(/Il motore interno non riesce ad avviarsi/),
    ).toBeVisible({ timeout: 15000 });
    expect(exits).toBe(5);
    await page.waitForTimeout(2000); // Verify the bounded restart loop remains stopped.
    expect(exits).toBe(5);
    rmSync(dbPath); // Remove only this test's deliberately corrupt synthetic file.
    await page.getByRole("button", { name: "Riprova", exact: true }).click();
    await expect(
      page.getByText(/Il motore interno non riesce ad avviarsi/),
    ).toHaveCount(0);
    expect(
      await page.evaluate(() => window.pyxis.invoke("plans.list", {})),
    ).toEqual([]);
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
});

test("a timed-out key handoff shows recovery and reconnects after retry", async () => {
  const userData = mkdtempSync(join(tmpdir(), "pyxis-keys-delay-"));
  const env = {
    ...process.env,
    PYXIS_USER_DATA: userData,
    PYXIS_E2E: "1",
    PYXIS_E2E_KEYS_DELAY: "4500",
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({
    args: [join(process.cwd(), "out/main/index.js")],
    env,
  });
  try {
    const page = await app.firstWindow();
    await expect(
      page.getByText(/Il motore interno non riesce ad avviarsi/),
    ).toBeVisible({ timeout: 15000 });
    await app.evaluate(() => {
      process.env.PYXIS_E2E_KEYS_DELAY = "0";
    });
    await page.getByRole("button", { name: "Riprova", exact: true }).click();
    await expect(
      page.getByText(/Il motore interno non riesce ad avviarsi/),
    ).toHaveCount(0);
    expect(
      await page.evaluate(() => window.pyxis.invoke("plans.list", {})),
    ).toEqual([]);
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
});

test("an undecryptable saved API key does not block startup", async () => {
  const userData = mkdtempSync(join(tmpdir(), "pyxis-core-key-recovery-"));
  writeFileSync(
    join(userData, "keys.json"),
    JSON.stringify({ anthropic: "AA==", openai: "AA==" }),
  );
  const env = { ...process.env, PYXIS_USER_DATA: userData, PYXIS_E2E: "1" };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({
    args: [join(process.cwd(), "out/main/index.js")],
    env,
  });
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Salta", exact: true }).click();
    await expect(page).toHaveURL(/\/exams/);
    expect(await page.evaluate(() => window.pyxis.keys.status())).toMatchObject(
      { configured: [] },
    );
    expect(
      await page.evaluate(() => window.pyxis.invoke("plans.list", {})),
    ).toEqual([]);
    await expect(page.getByText(/Il motore interno non/)).toHaveCount(0);
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
});
