import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Session } from "electron";
import { runtimePackIds, type PackId } from "../shared/figure-kinds";
import { runtimePacks, verifiedRuntimeFile } from "./runtime-pack";

/**
 * The `pyxis-runtime:` scheme serves the files of the windows that run untrusted work, from the app and from the
 * downloaded packs, and nothing else. Each window has a host of its own, and a host serves only the names it lists:
 * the Python sandbox (`sandbox`) takes Python's files and the wheels of the drawing pack, and the drawing window
 * (`draw`) takes its page, its script and the drawing pack's JavaScript. A window cannot ask for a file that is not on
 * its own list, and a file of a pack is served only after its size and SHA-256 are checked again.
 */
export type RuntimeHost = "sandbox" | "draw";

type Host = {
  /** Files of the app, by the name the window asks for and the file in `out/renderer/runtime`. */
  trusted: ReadonlyMap<string, string>;
  /** Whether a downloaded file, `<pack>/<file>`, may be served to this host. */
  pack: (id: PackId, file: string) => boolean;
  headers: Record<string, string>;
};

const ISOLATION = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Resource-Policy": "same-origin",
};

export const hosts: Record<RuntimeHost, Host> = {
  sandbox: {
    trusted: new Map([
      ["index.html", "sandbox.html"],
      ["host.js", "host.js"],
      ["python-worker.js", "python-worker.js"],
      ["check-worker.js", "check-worker.js"],
      ["symbolic.py", "symbolic.py"],
    ]),
    pack: (id, file) => id === "pyodide" || file.endsWith(".whl"),
    headers: {
      "Content-Security-Policy":
        "default-src 'none'; script-src pyxis-runtime: 'wasm-unsafe-eval'; connect-src pyxis-runtime:; worker-src pyxis-runtime:; img-src data:; base-uri 'none'; form-action 'none'",
      ...ISOLATION,
    },
  },
  draw: {
    trusted: new Map([
      ["index.html", "draw.html"],
      ["draw-host.js", "draw-host.js"],
    ]),
    pack: (id, file) => id === "drawing" && file.endsWith(".js"),
    // Nothing is fetched, nothing is embedded and nothing runs from a string: scripts come from this scheme only (and
    // WebAssembly compiles), pictures are blob: and data: only, and every other kind of load is refused.
    headers: {
      "Content-Security-Policy":
        "default-src 'none'; script-src pyxis-runtime: 'wasm-unsafe-eval'; img-src blob: data:; connect-src 'none'; worker-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'",
      ...ISOLATION,
    },
  },
};

export const runtimeOrigin = (host: RuntimeHost) => `pyxis-runtime://${host}/`;

function allowedNames(host: RuntimeHost): Set<string> {
  return new Set([
    ...hosts[host].trusted.keys(),
    ...runtimePackIds.flatMap((id) =>
      runtimePacks[id].files
        .filter((file) => hosts[host].pack(id, file.name))
        .map((file) => `${id}/${file.name}`),
    ),
  ]);
}

/** The name a request asks for on this host, or undefined when it is not a plain request for a file the host lists. */
export function runtimeResourceName(raw: string, host: RuntimeHost): string | undefined {
  try {
    const url = new URL(raw);
    if (
      url.protocol !== "pyxis-runtime:" ||
      url.hostname !== host ||
      url.search ||
      url.hash ||
      url.username ||
      url.password ||
      url.port
    )
      return undefined;
    const name = url.pathname.slice(1);
    return allowedNames(host).has(name) ? name : undefined;
  } catch {
    return undefined;
  }
}

function mime(name: string): string {
  if (name.endsWith(".html")) return "text/html";
  if (name.endsWith(".js") || name.endsWith(".mjs")) return "text/javascript";
  if (name.endsWith(".wasm")) return "application/wasm";
  if (name.endsWith(".json")) return "application/json";
  if (name.endsWith(".py")) return "text/plain";
  return "application/octet-stream";
}

/** Serves the `pyxis-runtime:` scheme on a session, for the hosts above. `path` is the workspace folder. */
export function registerRuntimeProtocol(
  target: Session,
  path: string | (() => string),
): void {
  target.protocol.handle("pyxis-runtime", async (request) => {
    const host = (["sandbox", "draw"] as const).find((name) => {
      try {
        return new URL(request.url).hostname === name;
      } catch {
        return false;
      }
    });
    const refused = () =>
      new Response("not found", { status: 404, headers: host ? hosts[host].headers : ISOLATION });
    if (!host || request.method !== "GET") return refused();
    const name = runtimeResourceName(request.url, host);
    if (!name) return refused();
    const asset = hosts[host].trusted.get(name);
    const bytes = asset
      ? new Uint8Array(
          await readFile(join(import.meta.dirname, "../renderer/runtime", asset)),
        )
      : await verifiedRuntimeFile(
          typeof path === "function" ? path() : path,
          name.slice(0, name.indexOf("/")) as PackId,
          name.slice(name.indexOf("/") + 1),
        );
    return bytes
      ? new Response(bytes, {
          headers: { ...hosts[host].headers, "Content-Type": mime(name) },
        })
      : refused();
  });
}
