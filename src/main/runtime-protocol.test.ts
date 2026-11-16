import { beforeEach, describe, expect, it, vi } from "vitest";

const files = vi.hoisted(() => ({
  read: [] as string[],
  verified: [] as Array<[string, string, string]>,
  good: new Set<string>(["drawing/graphviz.js", "drawing/schemdraw.whl", "pyodide/pyodide.js"]),
}));
vi.mock("node:fs/promises", () => ({
  readFile: async (path: string) => {
    files.read.push(path.replaceAll("\\", "/"));
    return Buffer.from(`file:${path.replaceAll("\\", "/").split("/").at(-1)}`);
  },
}));
vi.mock("./runtime-pack", () => ({
  runtimePacks: {
    pyodide: { files: [{ name: "pyodide.js" }, { name: "pyodide.asm.wasm" }] },
    drawing: { files: [{ name: "graphviz.js" }, { name: "schemdraw.whl" }] },
  },
  verifiedRuntimeFile: async (workspace: string, pack: string, name: string) => {
    files.verified.push([workspace, pack, name]);
    return files.good.has(`${pack}/${name}`) ? new Uint8Array(Buffer.from(`${pack}/${name}`)) : undefined;
  },
}));

import { hosts, registerRuntimeProtocol, runtimeOrigin, runtimeResourceName } from "./runtime-protocol";

type Handler = (request: { url: string; method: string }) => Promise<Response>;
function handler(path: string | (() => string) = "/workspace"): Handler {
  let registered: Handler | undefined;
  registerRuntimeProtocol(
    { protocol: { handle: (scheme: string, fn: Handler) => (scheme === "pyxis-runtime" ? (registered = fn) : undefined) } } as never,
    path,
  );
  return registered!;
}

beforeEach(() => {
  files.read.length = 0;
  files.verified.length = 0;
});

describe("the pyxis-runtime scheme", () => {
  it("gives each window a host with its own list of files", () => {
    expect(runtimeOrigin("draw")).toBe("pyxis-runtime://draw/");
    const names = (host: "sandbox" | "draw", list: string[]) => list.filter((name) => runtimeResourceName(runtimeOrigin(host) + name, host));
    const everything = [
      "index.html", "host.js", "python-worker.js", "check-worker.js", "symbolic.py", "draw-host.js",
      "pyodide/pyodide.js", "pyodide/pyodide.asm.wasm", "drawing/graphviz.js", "drawing/schemdraw.whl",
      "pyodide/other.js", "drawing/other.js", "other/graphviz.js", "draw.html", "sandbox.html", "",
    ];
    // Python's sandbox: its own files, Python's files and the wheels of the drawing pack. Not Graphviz.
    expect(names("sandbox", everything)).toEqual([
      "index.html", "host.js", "python-worker.js", "check-worker.js", "symbolic.py",
      "pyodide/pyodide.js", "pyodide/pyodide.asm.wasm", "drawing/schemdraw.whl",
    ]);
    // The drawing window: its page, its script and the pack's JavaScript. Not Python, not a wheel.
    expect(names("draw", everything)).toEqual(["index.html", "draw-host.js", "drawing/graphviz.js"]);
    // A host is its own: the other one's address is not a file of it.
    expect(runtimeResourceName("pyxis-runtime://sandbox/draw-host.js", "draw")).toBeUndefined();
    expect(runtimeResourceName("pyxis-runtime://draw/host.js", "sandbox")).toBeUndefined();
    expect(runtimeResourceName("pyxis-runtime://draw/index.html", "sandbox")).toBeUndefined();
  });

  it("serves only plain requests: no query, fragment, credentials, port or other scheme", () => {
    for (const url of [
      "pyxis-runtime://draw/draw-host.js?x=1",
      "pyxis-runtime://draw/draw-host.js#x",
      "pyxis-runtime://u:p@draw/draw-host.js",
      "pyxis-runtime://draw:81/draw-host.js",
      "http://draw/draw-host.js",
      "pyxis-app://draw/draw-host.js",
      "pyxis-runtime:draw-host.js",
      "draw-host.js",
    ])
      expect(runtimeResourceName(url, "draw"), url).toBeUndefined();
    expect(runtimeResourceName("pyxis-runtime://draw/draw-host.js", "draw")).toBe("draw-host.js");
  });

  it("sends the drawing window a policy with no network, no eval, no inline script and no frames", () => {
    const policy = hosts.draw.headers["Content-Security-Policy"]!;
    const directives = Object.fromEntries(policy.split("; ").map((part) => [part.split(" ")[0], part.split(" ").slice(1).join(" ")]));
    expect(directives).toEqual({
      "default-src": "'none'",
      "script-src": "pyxis-runtime: 'wasm-unsafe-eval'",
      "img-src": "blob: data:",
      "connect-src": "'none'",
      "worker-src": "'none'",
      "frame-src": "'none'",
      "object-src": "'none'",
      "base-uri": "'none'",
      "form-action": "'none'",
    });
    expect(policy).not.toMatch(/'unsafe-eval'|'unsafe-inline'|https?:|\*/);
    expect(hosts.draw.headers["Cross-Origin-Resource-Policy"]).toBe("same-origin");
  });

  it("serves the app's own files from the build, and a pack file only once it is verified", async () => {
    const serve = handler(() => "/the/workspace");
    const page = await serve({ url: "pyxis-runtime://draw/index.html", method: "GET" });
    expect(page.status).toBe(200);
    expect(page.headers.get("Content-Type")).toBe("text/html");
    expect(page.headers.get("Content-Security-Policy")).toBe(hosts.draw.headers["Content-Security-Policy"]);
    expect(await page.text()).toBe("file:draw.html");
    expect(files.read.at(-1)).toMatch(/renderer\/runtime\/draw\.html$/);
    expect((await serve({ url: "pyxis-runtime://draw/draw-host.js", method: "GET" })).headers.get("Content-Type")).toBe("text/javascript");
    expect(files.verified).toEqual([]);
    const library = await serve({ url: "pyxis-runtime://draw/drawing/graphviz.js", method: "GET" });
    expect(library.status).toBe(200);
    expect(library.headers.get("Content-Type")).toBe("text/javascript");
    expect(await library.text()).toBe("drawing/graphviz.js");
    expect(files.verified).toEqual([["/the/workspace", "drawing", "graphviz.js"]]);
    // The sandbox gets its own policy.
    const sandbox = await serve({ url: "pyxis-runtime://sandbox/index.html", method: "GET" });
    expect(sandbox.headers.get("Content-Security-Policy")).toBe(hosts.sandbox.headers["Content-Security-Policy"]);
    expect(await sandbox.text()).toBe("file:sandbox.html");
  });

  it("answers 404 to a file that fails its check, a name not on the host's list, another method and an unknown host", async () => {
    const serve = handler();
    files.good.delete("drawing/graphviz.js");
    try {
      for (const request of [
        { url: "pyxis-runtime://draw/drawing/graphviz.js", method: "GET" },
        { url: "pyxis-runtime://draw/drawing/schemdraw.whl", method: "GET" },
        { url: "pyxis-runtime://draw/pyodide/pyodide.js", method: "GET" },
        { url: "pyxis-runtime://draw/index.html", method: "POST" },
        { url: "pyxis-runtime://draw/index.html", method: "HEAD" },
        { url: "pyxis-runtime://other/index.html", method: "GET" },
        { url: "pyxis-runtime://draw/draw-host.js?x", method: "GET" },
        { url: "nonsense", method: "GET" },
      ]) {
        const reply = await serve(request);
        expect(reply.status, `${request.method} ${request.url}`).toBe(404);
        expect(await reply.text()).toBe("not found");
      }
    } finally {
      files.good.add("drawing/graphviz.js");
    }
    // Neither a wheel nor Python's files went to the verifier for the draw host.
    expect(files.verified.map(([, pack, name]) => `${pack}/${name}`)).toEqual(["drawing/graphviz.js"]);
  });
});
