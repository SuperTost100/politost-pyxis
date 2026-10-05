import { _electron as electron, expect, test } from "@playwright/test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const manifest = JSON.parse(readFileSync(join(process.cwd(), "resources/pyodide-manifest.json"), "utf8")) as { version: string };

test("MATH-02 MATH-06 Pyodide limits, network isolation and independent SymPy verification", async () => {
  test.skip(!existsSync(".tmp/pyodide/pyodide.js"), "Requires the pinned Pyodide runtime fixture in .tmp/pyodide.");
  test.setTimeout(120000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-python-check-"));
  const pack = join(userData, "workspace/runtimes/pyodide", manifest.version);
  mkdirSync(pack, { recursive: true });
  cpSync(join(process.cwd(), ".tmp/pyodide"), pack, { recursive: true });
  const env = { ...process.env, PYXIS_USER_DATA: userData, PYXIS_E2E: "1" };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({
    args: [join(process.cwd(), process.env.PYXIS_OUT_DIR ?? "out", "main/index.js")],
    env,
  });
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Salta" }).click();
    const run = async (code: string) =>
      page.evaluate(
        (code) => window.pyxis.invoke("tools.python", { code }),
        code,
      ) as Promise<{
        stdout: string;
        stderr: string;
        timedOut: boolean;
        truncated: boolean;
        images?: string[];
      }>;
    const [first, concurrent] = await Promise.all([
      run("import sys\nprint(sys.platform)\nprint(1 + 1)"),
      page.evaluate(() => window.pyxis.invoke("tools.check", { kind: "equal", expr: "x+x", claimed: "2*x" })),
    ]);
    expect(concurrent).toMatchObject({ state: "verified" });
    expect(first.stderr, JSON.stringify(first)).toBe("");
    expect(first.stdout).toContain("emscripten");
    expect(first.stdout).toContain("2");
    const check = async (claimed: string) =>
      page.evaluate(
        (claimed) =>
          window.pyxis.invoke("tools.check", {
            kind: "derivative",
            expr: "x**2*sin(x)",
            claimed,
            vars: ["x"],
          }),
        claimed,
      ) as Promise<{ state: string; reason?: string }>;
    expect(await check("2*x*sin(x)+x**2*cos(x)")).toMatchObject({
      state: "verified",
      reason: "symbolic",
    });
    expect(await check("x")).toMatchObject({ state: "failed" });
    expect(await check("__import__('os').system('echo unsafe')")).toMatchObject(
      { state: "none" },
    );
    expect(await page.evaluate(() => window.pyxis.invoke("tools.check", { kind: "equal", expr: "x", claimed: "1.00000001*x" }))).toMatchObject({ state: "failed" });
    const forged = await run("from js import self, Object\nfrom pyodide.ffi import to_js\nfor i in range(1,100):\n    self.postMessage(to_js({'type':'done','id':i}, dict_converter=Object.fromEntries))\nwhile True:\n    pass");
    expect(forged.timedOut).toBe(true);
    const began = Date.now();
    const hung = run("while True:\n    pass");
    expect(await check("2*x*sin(x)+x**2*cos(x)")).toMatchObject({
      state: "verified",
    });
    expect((await hung).timedOut).toBe(true);
    expect(Date.now() - began).toBeGreaterThanOrEqual(10000);
    expect(Date.now() - began).toBeLessThan(15000);
    expect((await run("print(6 * 7)")).stdout).toContain("42");
    const network = await run(
      "import urllib.request\nurllib.request.urlopen('https://example.com')",
    );
    expect(network.stderr).not.toBe("");
    const jsNetwork = await run(
      "import js\nawait js.fetch('https://example.com')",
    );
    expect(jsNetwork.stderr).not.toBe("");
    const hostFile = await run("print(open('/etc/passwd').read())");
    expect(hostFile.stderr).not.toBe("");
    expect(hostFile.stdout).not.toContain("root:");
    const flood = await run("print('x' * 500000)");
    expect(flood.truncated).toBe(true);
    expect(flood.stdout.length + flood.stderr.length).toBeLessThanOrEqual(
      200000,
    );
    expect((await run("print(123)")).stdout).toContain("123");
    const plot = await run(
      "import matplotlib.pyplot as plt\nplt.plot([0,1], [0,1])\nplt.show()",
    );
    expect(plot.images?.[0]).toMatch(/^data:image\/png;base64,/);
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
});

test("MATH-02 MATH-06 complete solve sets, own-request queue clock and crashed-renderer recovery", async () => {
  test.skip(!existsSync(".tmp/pyodide/pyodide.js"), "Requires the pinned Pyodide runtime fixture in .tmp/pyodide.");
  test.setTimeout(240000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-python-lanes-"));
  const pack = join(userData, "workspace/runtimes/pyodide", manifest.version);
  mkdirSync(pack, { recursive: true });
  cpSync(join(process.cwd(), ".tmp/pyodide"), pack, { recursive: true });
  const env = { ...process.env, PYXIS_USER_DATA: userData, PYXIS_E2E: "1" };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({
    args: [join(process.cwd(), process.env.PYXIS_OUT_DIR ?? "out", "main/index.js")],
    env,
  });
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Salta" }).click();
    type Result = { state: string; reason?: string };
    const check = (claim: Record<string, unknown>) =>
      page.evaluate((claim) => window.pyxis.invoke("tools.check", claim), claim) as Promise<Result>;
    const solve = (claimed: string, expr = "x**2-1") => check({ kind: "solve", expr, claimed, vars: ["x"] });
    expect(await solve("1")).toEqual({ state: "failed", reason: "incomplete-solution-set" });
    expect(await solve("[-1, 1]")).toEqual({ state: "verified", reason: "real-solution-set" });
    expect(await solve("[-1, 1, 1]")).toMatchObject({ state: "verified" });
    expect(await solve("[-1, 1, 2]")).toMatchObject({ state: "failed" });
    expect(await solve("0", "sin(x)")).toMatchObject({ state: "none", reason: "completeness-unresolved" });
    expect(await solve("[I, -I]", "x**2+1")).toMatchObject({ state: "none", reason: "unsupported-complex-roots" });

    const runtimeWindows = () =>
      app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => w.webContents.getURL().startsWith("pyxis-runtime:")).length);
    const crash = () =>
      app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().startsWith("pyxis-runtime:"))?.webContents.forcefullyCrashRenderer();
      });
    expect(await runtimeWindows()).toBe(1);
    await crash();
    await expect.poll(runtimeWindows).toBe(0);
    expect(await solve("[-1, 1]")).toMatchObject({ state: "verified" });
    const began = Date.now();
    const running = page.evaluate(() => window.pyxis.invoke("tools.python", { code: "while True:\n    pass" })) as Promise<{ stdout: string; stderr: string; timedOut: boolean }>;
    await page.waitForTimeout(3000);
    await crash();
    // The failure comes back as a runtime error well before the 10 s run limit.
    expect(await running).toMatchObject({ stderr: "runtime-crashed", timedOut: false });
    expect(Date.now() - began).toBeLessThan(9000);
    const again = (await page.evaluate(() => window.pyxis.invoke("tools.python", { code: "print(6 * 7)" }))) as { stdout: string };
    expect(again.stdout).toContain("42");
    expect(await solve("[-1, 1]")).toMatchObject({ state: "verified" });

    // Six slow claims wait about 66 s in the lane; the later ones must not be cut off by the first request's clock.
    const slow = await Promise.all(
      [0, 1, 2, 3, 4, 5].map((index) => check({ kind: "equal", expr: `(9999**9999)**9999+${index}`, claimed: "1" })),
    );
    for (const result of slow) {
      expect(result.state).toBe("none");
      expect(result.reason).not.toBe("runtime-unavailable");
    }
    expect(await solve("[-1, 1]")).toMatchObject({ state: "verified" });
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
});
