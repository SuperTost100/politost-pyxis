import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { BrowserWindow, session, type Session } from "electron";
import { checkClaimSchema } from "../shared/math-check";
import {
  ensureRuntime,
  runtimeManifest,
  runtimeStatus,
  verifiedRuntimeFile,
} from "./runtime-pack";

const ORIGIN = "pyxis-runtime://sandbox/";
const trusted = new Map([
  ["index.html", "sandbox.html"],
  ["host.js", "host.js"],
  ["python-worker.js", "python-worker.js"],
  ["check-worker.js", "check-worker.js"],
  ["symbolic.py", "symbolic.py"],
]);
const allowed = new Set([
  ...trusted.keys(),
  ...runtimeManifest.files.map((file) => `pyodide/${file.name}`),
]);
const HEADERS = {
  "Content-Security-Policy":
    "default-src 'none'; script-src pyxis-runtime: 'wasm-unsafe-eval'; connect-src pyxis-runtime:; worker-src pyxis-runtime:; img-src data:; base-uri 'none'; form-action 'none'",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Resource-Policy": "same-origin",
};
let workspace = "";
let window: BrowserWindow | null = null;
let opening: Promise<BrowserWindow> | null = null;
let generation = 0;

export function configurePythonRuntime(path: string): void {
  if (workspace !== path) {
    disposePythonRuntime();
    workspace = path;
  }
}
export function disposePythonRuntime(): void {
  generation++;
  window?.destroy();
  window = null;
  opening = null;
}
function resourceName(raw: string): string | undefined {
  try {
    const url = new URL(raw);
    if (
      url.protocol !== "pyxis-runtime:" ||
      url.hostname !== "sandbox" ||
      url.search ||
      url.hash ||
      url.username ||
      url.password ||
      url.port
    )
      return undefined;
    const name = url.pathname.slice(1);
    return allowed.has(name) ? name : undefined;
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
export function registerRuntimeProtocol(target: Session, path: string): void {
  target.protocol.handle("pyxis-runtime", async (request) => {
    const name = resourceName(request.url);
    if (!name || request.method !== "GET")
      return new Response("not found", { status: 404, headers: HEADERS });
    const asset = trusted.get(name);
    const bytes = asset
      ? new Uint8Array(
          await readFile(
            join(import.meta.dirname, "../renderer/runtime", asset),
          ),
        )
      : await verifiedRuntimeFile(path, name.slice("pyodide/".length));
    return bytes
      ? new Response(bytes, {
          headers: { ...HEADERS, "Content-Type": mime(name) },
        })
      : new Response("not found", { status: 404, headers: HEADERS });
  });
}
async function sandbox(): Promise<BrowserWindow> {
  if (!workspace) throw new Error("runtime-workspace-missing");
  const epoch = generation;
  const path = workspace;
  await ensureRuntime(path);
  if (epoch !== generation) throw new Error("runtime-disposed");
  if (opening) return opening;
  if (window && !window.isDestroyed()) return window;
  opening = (async () => {
    const partition = session.fromPartition(`pyxis-python-${randomUUID()}`, {
      cache: false,
    });
    registerRuntimeProtocol(partition, path);
    partition.webRequest.onBeforeRequest((details, callback) =>
      callback({ cancel: !resourceName(details.url) }),
    );
    partition.setPermissionRequestHandler((_contents, _permission, callback) =>
      callback(false),
    );
    partition.setPermissionCheckHandler(() => false);
    const created = new BrowserWindow({
      show: false,
      webPreferences: {
        session: partition,
        sandbox: true,
        nodeIntegration: false,
        contextIsolation: true,
        webSecurity: true,
        webviewTag: false,
      },
    });
    window = created;
    created.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    created.webContents.on("will-navigate", (event) => event.preventDefault());
    created.on("closed", () => {
      if (window === created) {
        window = null;
        opening = null;
      }
    });
    try {
      await created.loadURL(ORIGIN + "index.html");
      if (epoch !== generation || created.isDestroyed()) throw new Error("runtime-disposed");
      window = created;
      return created;
    } catch (error) {
      if (!created.isDestroyed()) created.destroy();
      if (epoch === generation) opening = null;
      throw error;
    }
  })();
  return opening;
}
async function execute(
  operation: "run" | "check",
  payload: unknown,
  timeoutMs?: number,
): Promise<unknown> {
  const target = await sandbox();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      target.webContents.executeJavaScript(
        `window.pyxisRuntime.${operation}(${JSON.stringify(payload)}${operation === "run" ? `, ${timeoutMs}` : ""})`,
      ),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          void target.webContents
            .executeJavaScript(
              `window.pyxisRuntime.stop(${JSON.stringify(operation === "run" ? "python" : "check")})`,
            )
            .catch(() => undefined);
          reject(new Error("runtime-timeout"));
        }, 45000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
export async function handleRuntimeRequest(
  operation: string,
  payload: unknown,
): Promise<unknown> {
  if (operation === "status") return runtimeStatus(workspace);
  if (operation === "check") {
    try {
      return await execute("check", checkClaimSchema.parse(payload));
    } catch {
      return { state: "none", reason: "runtime-unavailable" };
    }
  }
  if (operation === "python") {
    if (
      !payload ||
      typeof payload !== "object" ||
      !("code" in payload) ||
      typeof payload.code !== "string" ||
      payload.code.length > 200000
    )
      throw new Error("python-input-invalid");
    const requested =
      "timeoutMs" in payload && typeof payload.timeoutMs === "number"
        ? payload.timeoutMs
        : 10000;
    return execute(
      "run",
      payload.code,
      Math.max(100, Math.min(10000, requested)),
    );
  }
  throw new Error("runtime-operation-invalid");
}
