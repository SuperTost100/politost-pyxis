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
    args: [join(process.cwd(), "out/main/index.js")],
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
