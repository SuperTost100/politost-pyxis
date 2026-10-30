import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { launchPyxis } from "./app-under-test";
import { removeTestFolder } from "./cleanup";

/** One request the stand-in for the crash Worker received. */
type Received = { path: string; headers: Record<string, string | string[] | undefined>; body: Buffer };

/** A local HTTP server in place of crash-worker/, recording everything that reaches it. */
async function crashServer(): Promise<{ server: Server; endpoint: string; received: Received[] }> {
  const received: Received[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      received.push({ path: request.url ?? "", headers: request.headers, body: Buffer.concat(chunks) });
      // Crashpad adds ?product=…&version=…&guid=… to the URL, as it does with the real Worker.
      const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      if (path === "/minidump") response.writeHead(200, { "content-type": "text/plain" }).end("report-id");
      else response.writeHead(204).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { server, endpoint: `http://127.0.0.1:${port}`, received };
}

// The student's own words and paths, which must never reach the server.
const STUDENT = "Appunti di Mario Rossi sulla Divina Commedia";

async function launch(userData: string, endpoint: string): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await launchPyxis({
    userData,
    // CI's shared dump folder would keep this test's deliberate crash; this profile's own Crashpad folder is used.
    env: { PYXIS_E2E_CRASH_ENDPOINT: endpoint, PYXIS_CRASH_DIR: undefined },
  });
  const page = await app.firstWindow();
  return { app, page };
}

/** Throws in the window after the current task, so it reaches the window's error handler as an uncaught error. */
async function throwInWindow(page: Page, message: string): Promise<void> {
  await page.evaluate((text) => {
    setTimeout(() => {
      throw new Error(text);
    });
    void Promise.reject(new TypeError(`rejected: ${text}`));
  }, message);
}

async function consent(userData: string): Promise<boolean> {
  try {
    return (JSON.parse(readFileSync(join(userData, "crash-reports.json"), "utf8")) as { consent: { enabled: boolean } })
      .consent.enabled;
  } catch {
    return false;
  }
}

async function skipSetup(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Salta" }).click();
  await expect(page).toHaveURL(/#\/exams$/);
}

test("crash reports: nothing is sent while the switch is off, and a scrubbed error report arrives once it is on", async () => {
  test.setTimeout(90_000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-crash-reports-"));
  const { server, endpoint, received } = await crashServer();
  const { app, page } = await launch(userData, endpoint);
  try {
    await skipSetup(page);
    // Off by default: errors in the window and in core reach nobody.
    await throwInWindow(page, `created while off: ${STUDENT} /home/mario/Documenti/tesi.pdf`);
    await page.waitForTimeout(2_000);
    expect(received).toEqual([]);
    expect(existsSync(join(userData, "crash-reports.json")) ? readFileSync(join(userData, "crash-reports.json"), "utf8") : "").not.toContain("created while off");

    // The student turns the switch on in Settings > Privacy. It takes effect without a restart.
    await page.evaluate(() => {
      location.hash = "/settings/privacy";
    });
    const toggle = page.getByRole("switch", { name: "Consenti segnalazioni di crash" });
    await expect(toggle).not.toBeChecked();
    await toggle.click();
    await expect(toggle).toBeChecked();
    await expect(page.getByText("Consentite: se Pyxis va in errore, invia da solo un rapporto tecnico.")).toBeVisible();
    await expect.poll(() => consent(userData)).toBe(true);

    await throwInWindow(page, `created while on: ${STUDENT} '${userData}/workspace/scratch/tesi.pdf' sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789`);
    await expect.poll(() => received.filter((item) => item.path === "/error").length).toBe(2);
    const reports = received.map((item) => JSON.parse(item.body.toString("utf8")) as Record<string, unknown>);
    for (const [index, report] of reports.entries()) {
      expect(received[index]!.headers["content-type"]).toBe("application/json");
      expect(Object.keys(report).sort()).toEqual(
        ["appVersion", "arch", "electronVersion", "message", "name", "os", "process", "stack"].sort(),
      );
      expect(report["process"]).toBe("renderer");
      expect(report["os"]).toBe(process.platform);
    }
    expect(reports.map((report) => report["name"]).sort()).toEqual(["Error", "TypeError"]);
    const everything = JSON.stringify(reports);
    // Paths, quoted text and keys are gone; the error raised while the switch was off never arrives.
    expect(everything).toContain("created while on");
    expect(everything).not.toContain("created while off");
    expect(everything).not.toContain("tesi.pdf");
    expect(everything).not.toContain(userData);
    expect(everything).not.toContain("sk-ant");

    // The same error again the same day is not sent twice.
    await throwInWindow(page, `created while on: ${STUDENT} '${userData}/workspace/scratch/tesi.pdf' sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789`);
    await page.waitForTimeout(1_500);
    expect(received).toHaveLength(2);

    // Off again: nothing more goes.
    await toggle.click();
    await expect(toggle).not.toBeChecked();
    await expect.poll(() => consent(userData)).toBe(false);
    await throwInWindow(page, "after turning off");
    await page.waitForTimeout(1_500);
    expect(received).toHaveLength(2);
  } finally {
    await app.close().catch(() => {});
    server.close();
    removeTestFolder(userData);
  }
});

/** The multipart field names of a Crashpad upload, inflating it when it is gzip as Crashpad sends it. */
function multipartFields(item: Received): string[] {
  const body = item.headers["content-encoding"] === "gzip" ? gunzipSync(item.body) : item.body;
  return [...body.toString("latin1").matchAll(/name="([^"]+)"/g)].map((match) => match[1]!);
}

function dumps(userData: string): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(dir, entry.name));
      else if (entry.name.endsWith(".dmp")) found.push(join(dir, entry.name).slice(userData.length));
    }
  };
  if (existsSync(join(userData, "Crashpad"))) walk(join(userData, "Crashpad"));
  return found;
}

async function crashMain(app: ElectronApplication): Promise<void> {
  await app.evaluate(() => process.crash()).catch(() => {});
  await app.close().catch(() => {});
}

test("crash reports: a native crash uploads a minidump only while the switch is on, and an old dump never goes", async () => {
  test.skip(process.platform !== "linux", "Crashpad keeps the profile's dumps in userData/Crashpad on Linux only");
  test.setTimeout(120_000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-crash-native-"));
  const { server, endpoint, received } = await crashServer();
  let app: ElectronApplication | null = null;
  try {
    // Off: the crash leaves a dump on this computer and sends nothing.
    let page: Page;
    ({ app, page } = await launch(userData, endpoint));
    await skipSetup(page);
    await crashMain(app);
    await expect.poll(() => dumps(userData).length, { timeout: 15_000 }).toBeGreaterThan(0);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    expect(received).toEqual([]);

    // The next start deletes that dump, and turning the switch on does not bring it back.
    ({ app, page } = await launch(userData, endpoint));
    expect(dumps(userData)).toEqual([]);
    await expect(page).toHaveURL(/#\/exams$/);
    await page.evaluate(() => window.pyxis.invoke("profile.save", { crashReports: true }));
    await expect.poll(() => consent(userData)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    expect(received).toEqual([]);

    // On: the next crash arrives as a Crashpad upload on the minidump route, gzip-compressed.
    await crashMain(app);
    app = null;
    await expect.poll(() => received.length, { timeout: 30_000 }).toBe(1);
    const upload = received[0]!;
    // Crashpad adds product, version and its installation id to the URL; the Worker reads only the path.
    expect(upload.path.split("?")[0]).toBe("/minidump");
    expect(upload.headers["content-encoding"]).toBe("gzip");
    expect(String(upload.headers["content-type"])).toMatch(/^multipart\/form-data; boundary=/);
    const fields = multipartFields(upload);
    expect(fields).toContain("upload_file_minidump");
    // The fields the Worker reads (crash-worker/src/index.ts, minidumpFields).
    for (const name of ["_productName", "_version", "ver", "platform", "process_type"]) expect(fields).toContain(name);
    const body = gunzipSync(upload.body).toString("latin1");
    expect(body).toMatch(/name="_productName"\r\n\r\nPoliTost Pyxis\r\n/);
  } finally {
    if (app) await app.close().catch(() => {});
    server.close();
    removeTestFolder(userData);
  }
});

/** The hold on core's crash-consent that main installs for tests with PYXIS_E2E_CONSENT_HOLD=1 (src/main/index.ts). */
type ConsentHold = {
  pyxisE2eHoldConsent: () => void;
  pyxisE2eConsentWaiting: () => number;
  pyxisE2eReleaseConsent: () => void;
};

test("crash reports: a restore that brings back the switch off sends nothing raised during it, and a failed one resumes", async () => {
  test.setTimeout(120_000);
  const root = mkdtempSync(join(tmpdir(), "pyxis-crash-restore-"));
  // Backups go next to the profile: Pyxis refuses to save one inside it.
  const userData = join(root, "userData");
  const zip = join(root, "backup.zip");
  const offBackup = join(root, "switch-off.zip");
  const { server, endpoint, received } = await crashServer();
  const app = await launchPyxis({
    userData,
    env: {
      PYXIS_E2E_CRASH_ENDPOINT: endpoint,
      PYXIS_CRASH_DIR: undefined,
      PYXIS_E2E_SAVE: zip,
      PYXIS_E2E_ZIP: zip,
      PYXIS_E2E_CONSENT_HOLD: "1",
    },
  });
  const messages = () =>
    received.map((item) => String((JSON.parse(item.body.toString("utf8")) as { message: unknown }).message));
  try {
    const page = await app.firstWindow();
    await skipSetup(page);
    // A backup of this workspace with the switch off, then the switch goes on.
    await expect(page.evaluate(() => window.pyxis.backupWorkspace())).resolves.toBe("saved");
    copyFileSync(zip, offBackup);
    await page.evaluate(() => window.pyxis.invoke("profile.save", { crashReports: true }));
    await expect.poll(() => consent(userData)).toBe(true);
    await throwInWindow(page, "before any restore");
    await expect.poll(() => received.length).toBe(2);

    // A restore that fails puts the same workspace back: its core says on again, and reports go once more.
    writeFileSync(zip, "corrupt backup");
    await expect(page.evaluate(() => window.pyxis.restoreWorkspace())).rejects.toThrow(/backup-corrupt/);
    await throwInWindow(page, "after the failed restore");
    await expect.poll(() => received.length).toBe(4);

    // A restore that brings back the switch off. Main holds core's switch here, so the errors below are raised at a
    // known point: the old core has gone, and the restored core has read its switch but main has not applied it. Main
    // still has the old workspace's on, and only the suspension for the restore keeps these errors from being sent.
    copyFileSync(offBackup, zip);
    await app.evaluate(() => (globalThis as unknown as ConsentHold).pyxisE2eHoldConsent());
    const restoring = page.evaluate(() => window.pyxis.restoreWorkspace());
    await expect
      .poll(() => app.evaluate(() => (globalThis as unknown as ConsentHold).pyxisE2eConsentWaiting()))
      .toBeGreaterThan(0);
    await throwInWindow(page, "during the restore");
    await app.evaluate(() => {
      void Promise.reject(new Error("main during the restore"));
    });
    // Time for the errors to reach main, and the server too if main were still sending.
    await page.waitForTimeout(1_500);
    expect(received).toHaveLength(4);
    await app.evaluate(() => (globalThis as unknown as ConsentHold).pyxisE2eReleaseConsent());
    await expect(restoring).resolves.toBe("restored");
    await expect.poll(() => consent(userData)).toBe(false);
    await throwInWindow(page, "after the restore");
    await page.waitForTimeout(2_000);
    expect(messages().sort()).toEqual([
      "after the failed restore",
      "before any restore",
      "rejected: after the failed restore",
      "rejected: before any restore",
    ]);
    expect(readFileSync(join(userData, "crash-reports.json"), "utf8")).not.toContain("during the restore");
  } finally {
    await app.close().catch(() => {});
    server.close();
    rmSync(root, { recursive: true, force: true });
  }
});
