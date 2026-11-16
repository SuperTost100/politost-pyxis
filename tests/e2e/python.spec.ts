import { expect, test } from "@playwright/test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MathCheck } from "../../src/shared/math-check";
import { launchPyxis } from "./app-under-test";
import { removeTestFolder } from "./cleanup";
import { fromChiediToExams } from "./doors";
import { listeners, networkStackScript, resolved } from "./network-probes";
const manifest = JSON.parse(readFileSync(join(process.cwd(), "resources/pyodide-manifest.json"), "utf8")) as { version: string };

test("MATH-02 MATH-06 Pyodide limits, network isolation and independent SymPy verification", async () => {
  test.skip(!existsSync(".tmp/pyodide/pyodide.js"), "Requires the pinned Pyodide runtime fixture in .tmp/pyodide.");
  // Thirteen Python calls each start a fresh runtime worker, in addition to symbolic checks.
  // Keep the execution-limit assertions below strict; allow the full sequence its cold-load time.
  test.setTimeout(240000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-python-check-"));
  const pack = join(userData, "workspace/runtimes/pyodide", manifest.version);
  mkdirSync(pack, { recursive: true });
  cpSync(join(process.cwd(), ".tmp/pyodide"), pack, { recursive: true });
  const app = await launchPyxis({ userData });
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Salta" }).click();
    // Skipping saves the profile, then moves to Chiedi; wait so a reload or route change cannot land on setup.
    await fromChiediToExams(page);
    let runNumber = 0;
    const run = async (code: string) => {
      const label = `python case ${++runNumber}`;
      console.time(label);
      const result = await page.evaluate(
        (code) => window.pyxis.invoke("tools.python", { code }),
        code,
      ) as {
        stdout: string;
        stderr: string;
        timedOut: boolean;
        truncated: boolean;
        images?: string[];
      };
      console.timeEnd(label);
      return result;
    };
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
    // Each Python run gets a fresh worker. Measure its execution ceiling after
    // cold package loading, at the actual worker dispatch, rather than charging
    // runtime startup against the ten-second code limit on slower CI machines.
    const runtimeId = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().find((window) =>
        window.webContents.getURL().startsWith("pyxis-runtime:"),
      )!.webContents.id,
    );
    await app.evaluate(async ({ webContents }, id) => {
      await webContents.fromId(id)!.executeJavaScript(`
        window.__testPythonStartedAt = 0;
        const originalPost = Worker.prototype.postMessage;
        Worker.prototype.postMessage = function(message, ...args) {
          if (message?.type === 'run' && message.payload === 'while True:\\n    pass') {
            window.__testPythonStartedAt = Date.now();
            Worker.prototype.postMessage = originalPost;
          }
          return originalPost.call(this, message, ...args);
        };
        void 0;
      `);
    }, runtimeId);
    const began = Date.now();
    const hung = run("while True:\n    pass");
    expect(await check("2*x*sin(x)+x**2*cos(x)")).toMatchObject({
      state: "verified",
    });
    expect((await hung).timedOut).toBe(true);
    const startedAt = await app.evaluate(async ({ webContents }, id) =>
      webContents.fromId(id)!.executeJavaScript("window.__testPythonStartedAt") as Promise<number>,
    runtimeId);
    expect(startedAt).toBeGreaterThanOrEqual(began);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(10000);
    expect(Date.now() - startedAt).toBeLessThan(15000);
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
    removeTestFolder(userData);
  }
});

test("MATH-02 MATH-06 complete solve sets, own-request queue clock and crashed-renderer recovery", async () => {
  test.skip(!existsSync(".tmp/pyodide/pyodide.js"), "Requires the pinned Pyodide runtime fixture in .tmp/pyodide.");
  test.setTimeout(240000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-python-lanes-"));
  const pack = join(userData, "workspace/runtimes/pyodide", manifest.version);
  mkdirSync(pack, { recursive: true });
  cpSync(join(process.cwd(), ".tmp/pyodide"), pack, { recursive: true });
  const app = await launchPyxis({ userData });
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Salta" }).click();
    // Skipping saves the profile, then moves to Chiedi; wait so a reload or route change cannot land on setup.
    await fromChiediToExams(page);
    type Result = { state: string; reason?: string };
    const check = (claim: MathCheck) =>
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
    // Let the endless loop start before the crash. The runtime window already exists for the checks, and nothing
    // signals that the loop is running, so this is a fixed wait.
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
    removeTestFolder(userData);
  }
});

test("the Python page offers both packs as one download, and only the drawing files to a workspace that has Python", async () => {
  test.skip(
    !existsSync(".tmp/pyodide/pyodide.js") || !existsSync(".tmp/drawing"),
    "Requires the pinned Pyodide and drawing fixtures in .tmp/pyodide and .tmp/drawing.",
  );
  test.setTimeout(120000);
  const packs = Object.fromEntries(
    ["pyodide", "drawing"].map((pack) => [
      pack,
      JSON.parse(readFileSync(join(process.cwd(), `resources/${pack}-manifest.json`), "utf8")) as {
        version: string;
        files: Array<{ size: number }>;
      },
    ]),
  );
  const megabytes = (...names: string[]) =>
    new Intl.NumberFormat("it", { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(
      names.flatMap((name) => packs[name]!.files).reduce((sum, file) => sum + file.size, 0) / 1e6,
    );
  const userData = mkdtempSync(join(tmpdir(), "pyxis-python-offer-"));
  const stage = (pack: string) => {
    const folder = join(userData, "workspace/runtimes", pack, packs[pack]!.version);
    mkdirSync(folder, { recursive: true });
    cpSync(join(process.cwd(), ".tmp", pack), folder, { recursive: true });
  };
  const app = await launchPyxis({ userData });
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Salta" }).click();
    await fromChiediToExams(page);
    await page.evaluate(() => {
      location.hash = "/tools/python";
    });
    const run = page.getByRole("button", { name: "Esegui", exact: true });
    // Nothing downloaded: one download of Python and the drawing files together.
    await expect(page.getByText("Python richiede un download una tantum")).toBeVisible();
    await expect(
      page.getByRole("button", { name: `Scarica Python (${megabytes("pyodide", "drawing")} MB)` }),
    ).toBeVisible();
    await expect(run).toBeDisabled();

    // A workspace that downloaded Python before the drawing files existed: Python runs, and the rest is on offer.
    stage("pyodide");
    await page.reload();
    await expect(page.getByText("Circuiti e grafi richiedono un piccolo download")).toBeVisible();
    await expect(page.getByRole("button", { name: `Scarica (${megabytes("drawing")} MB)` })).toBeVisible();
    await expect(page.getByText("Python richiede un download una tantum")).toHaveCount(0);
    await run.click();
    await expect(page.getByRole("region", { name: "Risultato" }).locator("pre")).toHaveText("2", {
      timeout: 60000,
    });

    // Both packs there: nothing left to offer.
    stage("drawing");
    await page.reload();
    await expect(run).toBeEnabled();
    await expect(page.getByRole("button", { name: /^Scarica/ })).toHaveCount(0);
    await expect(page.getByText(/richied(e|ono) un/)).toHaveCount(0);
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});

test("the Python window's page reaches nothing through the network stack either: WebRTC and preconnect go nowhere", async () => {
  test.skip(!existsSync(".tmp/pyodide/pyodide.js"), "Requires the pinned Pyodide runtime fixture in .tmp/pyodide.");
  test.setTimeout(180000);
  // The Python window runs untrusted code (plots, circuits, the student's own Python), in a worker of its own, and the page
  // that hosts that worker is the app's. What the session's request filter cannot see is what a compromised page, or
  // code that got into it, could still do: open WebRTC sockets, or make the network stack connect or look up a name. The
  // window is locked as the drawing window is, by the same helper, so the same tries are made against it.
  const userData = mkdtempSync(join(tmpdir(), "pyxis-python-stack-"));
  const pack = join(userData, "workspace/runtimes/pyodide", manifest.version);
  mkdirSync(pack, { recursive: true });
  cpSync(join(process.cwd(), ".tmp/pyodide"), pack, { recursive: true });
  const { datagrams, connections, udpPort, tcpPort, close } = await listeners();
  const host = `leak-${Math.random().toString(36).slice(2)}.example.invalid`;
  const hintHost = `hint-${Math.random().toString(36).slice(2)}.example.invalid`;
  const log = join(userData, "net-log.json");
  const app = await launchPyxis({ userData, env: { HOME: userData } });
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Salta" }).click();
    await fromChiediToExams(page);
    // A run opens the window.
    const run = (await page.evaluate(() => window.pyxis.invoke("tools.python", { code: "print(6 * 7)" }))) as { stdout: string };
    expect(run.stdout).toContain("42");
    const handle = (script: string) =>
      app.evaluate((_, text) => (globalThis as unknown as { pyxisE2ePython: { evaluate: (script: string) => Promise<unknown> } }).pyxisE2ePython.evaluate(text), script);
    await app.evaluate(async ({ BrowserWindow }, path) => {
      const target = BrowserWindow.getAllWindows().find((candidate) => candidate.webContents.getURL().startsWith("pyxis-runtime://sandbox/"))!;
      await target.webContents.session.netLog.startLogging(path, { captureMode: "everything" });
    }, log);
    await handle(networkStackScript(host, hintHost, udpPort, tcpPort));
    await app.evaluate(async ({ BrowserWindow }) => {
      const target = BrowserWindow.getAllWindows().find((candidate) => candidate.webContents.getURL().startsWith("pyxis-runtime://sandbox/"))!;
      await target.webContents.session.netLog.stopLogging();
    });
    expect({ udp: datagrams.length, tcp: connections.length, dns: resolved(log, host).length }).toEqual({ udp: 0, tcp: 0, dns: 0 });
    expect({ datagrams, connections }).toEqual({ datagrams: [], connections: [] });
    // The window still runs Python.
    const again = (await page.evaluate(() => window.pyxis.invoke("tools.python", { code: "print(1 + 1)" }))) as { stdout: string };
    expect(again.stdout).toContain("2");
  } finally {
    await app.close();
    await close();
    removeTestFolder(userData);
  }
});

/** Python that writes something into every kind of storage a page's workers can reach, and says which kinds took it. */
const writeStorage = [
  "import js, asyncio, json",
  "from pyodide.ffi import create_once_callable, to_js",
  "result = {}",
  "async def write():",
  "    try:",
  "        cache = await js.caches.open('leak-cache')",
  "        await cache.put('https://example.invalid/leak', js.Response.new('leaked'))",
  "        result['cache'] = 'written'",
  "    except Exception as error:",
  "        result['cache'] = 'unavailable ' + str(error)[:50]",
  "    try:",
  "        root = await js.navigator.storage.getDirectory()",
  "        handle = await root.getFileHandle('leak.txt', to_js({'create': True}, dict_converter=js.Object.fromEntries))",
  "        stream = await handle.createWritable()",
  "        await stream.write('leaked')",
  "        await stream.close()",
  "        result['opfs'] = 'written'",
  "    except Exception as error:",
  "        result['opfs'] = 'unavailable ' + str(error)[:50]",
  "    try:",
  "        done = asyncio.get_event_loop().create_future()",
  "        request = js.indexedDB.open('leak-db', 1)",
  "        request.onupgradeneeded = create_once_callable(lambda event: request.result.createObjectStore('s'))",
  "        request.onsuccess = create_once_callable(lambda event: done.set_result(request.result))",
  "        request.onerror = create_once_callable(lambda event: done.set_exception(Exception('open failed')))",
  "        database = await done",
  "        database.close()",
  "        result['idb'] = 'written'",
  "    except Exception as error:",
  "        result['idb'] = 'unavailable ' + str(error)[:50]",
  "await write()",
  "print(json.dumps(result))",
].join("\n");

/** Python that looks for what the one above wrote, and says what it found. */
const readStorage = [
  "import js, json",
  "found = {}",
  "try:",
  "    found['cache'] = [str(name) for name in await js.caches.keys()]",
  "except Exception as error:",
  "    found['cache'] = 'unavailable'",
  "try:",
  "    root = await js.navigator.storage.getDirectory()",
  "    await root.getFileHandle('leak.txt')",
  "    found['opfs'] = ['leak.txt']",
  "except Exception as error:",
  "    found['opfs'] = []",
  "try:",
  "    found['idb'] = [str(entry.name) for entry in await js.indexedDB.databases()]",
  "except Exception as error:",
  "    found['idb'] = 'unavailable'",
  "print(json.dumps(found))",
].join("\n");

test("nothing a Python run leaves in the window's session reaches the next run: every run starts clean", async () => {
  test.skip(!existsSync(".tmp/pyodide/pyodide.js"), "Requires the pinned Pyodide runtime fixture in .tmp/pyodide.");
  test.setTimeout(240000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-python-clean-"));
  const pack = join(userData, "workspace/runtimes/pyodide", manifest.version);
  mkdirSync(pack, { recursive: true });
  cpSync(join(process.cwd(), ".tmp/pyodide"), pack, { recursive: true });
  const app = await launchPyxis({ userData, env: { HOME: userData } });
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Salta" }).click();
    await fromChiediToExams(page);
    const python = async (code: string) =>
      (await page.evaluate((code) => window.pyxis.invoke("tools.python", { code }), code)) as { stdout: string; stderr: string };
    const written = await python(writeStorage);
    expect(written.stderr, "the writing run").toBe("");
    const wrote = JSON.parse(written.stdout.trim()) as Record<string, string>;
    // The test is only worth something for the kinds of storage a worker can write: at least one took it.
    expect(Object.values(wrote).filter((value) => value === "written").length, JSON.stringify(wrote)).toBeGreaterThan(0);
    // Each run is a fresh worker in the same window and session, and finds none of it.
    const found = await python(readStorage);
    expect(found.stderr, "the reading run").toBe("");
    const seen = JSON.parse(found.stdout.trim()) as Record<string, unknown>;
    expect(seen).toEqual({ cache: [], opfs: [], idb: [] });
    // And a run that comes after a replaced window finds none either.
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()
        .find((candidate) => candidate.webContents.getURL().startsWith("pyxis-runtime://sandbox/"))
        ?.webContents.forcefullyCrashRenderer();
    });
    await expect
      .poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => w.webContents.getURL().startsWith("pyxis-runtime://sandbox/")).length))
      .toBe(0);
    await python(writeStorage);
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()
        .find((candidate) => candidate.webContents.getURL().startsWith("pyxis-runtime://sandbox/"))
        ?.webContents.forcefullyCrashRenderer();
    });
    await expect
      .poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => w.webContents.getURL().startsWith("pyxis-runtime://sandbox/")).length))
      .toBe(0);
    expect(JSON.parse((await python(readStorage)).stdout.trim())).toEqual({ cache: [], opfs: [], idb: [] });
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});
