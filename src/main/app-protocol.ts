import { realpathSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, isAbsolute, join, relative, sep } from "node:path";
import { protocol, type Privileges } from "electron";
import { rendererCsp } from "./csp";

/**
 * The window loads the built renderer from this scheme rather than file://, because Chromium keeps a V8 code cache
 * only for http(s) and schemes registered with `codeCache`. Later launches then skip most of the script compiling.
 */
export const APP_SCHEME = "pyxis-app";
export const APP_PAGE = `${APP_SCHEME}://app/index.html`;
export const appPrivileges: Privileges = {
  standard: true,
  secure: true,
  supportFetchAPI: true,
  codeCache: true,
};

const types: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
};

/**
 * The file a request names inside `root`, or null. Only GET-style paths under pyxis-app://app/ resolve: no query,
 * credentials or port, no encoded slash, backslash or NUL, nothing that leaves the folder after decoding or through a
 * symlink, and only regular files.
 */
export function appFile(root: string, rawUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (
    url.protocol !== `${APP_SCHEME}:` ||
    url.hostname !== "app" ||
    url.port ||
    url.username ||
    url.password ||
    url.search
  )
    return null;
  let path: string;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  if (/[\\\0]/.test(path) || /%2f|%5c/i.test(url.pathname)) return null;
  const segments = path.split("/").slice(1);
  if (segments.some((segment) => segment === "" || segment === "." || segment === ".."))
    return null;
  const candidate = join(root, ...segments);
  try {
    const realRoot = realpathSync(root);
    const real = realpathSync(candidate);
    const inside = relative(realRoot, real);
    if (
      !inside ||
      inside === ".." ||
      inside.startsWith(`..${sep}`) ||
      isAbsolute(inside)
    )
      return null;
    return statSync(real).isFile() ? real : null;
  } catch {
    return null;
  }
}

/** Serves the built renderer from `root` (out/renderer) with the window's CSP. */
export function registerAppProtocol(root: string): void {
  const csp = rendererCsp();
  protocol.handle(APP_SCHEME, async (request) => {
    const file = request.method === "GET" ? appFile(root, request.url) : null;
    if (!file) return new Response("not found", { status: 404 });
    try {
      return new Response(new Uint8Array(await readFile(file)), {
        headers: {
          "Content-Type":
            types[extname(file).toLowerCase()] ?? "application/octet-stream",
          "Content-Security-Policy": csp,
          "X-Content-Type-Options": "nosniff",
        },
      });
    } catch {
      return new Response("not found", { status: 404 });
    }
  });
}
