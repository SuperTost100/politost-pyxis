/**
 * Receives Pyxis crash reports and stores them in R2. A public endpoint, so it takes only two shapes of POST and keeps
 * nothing about the sender: no IP address, no request headers, no installation id.
 *
 * - `POST /error`: one JavaScript error as JSON (see `ErrorReport`), already scrubbed by the app.
 * - `POST /minidump`: a Crashpad upload from Electron's crashReporter, multipart/form-data, usually gzip-compressed.
 *
 * Objects are keyed `<YYYY-MM-DD>/<error|minidump>/<random id>`, so one day lists with one prefix. An R2 lifecycle rule
 * deletes them after 90 days (docs/crash-reports.md).
 */

import type { ReportKind } from "./budget";

export const LIMITS = {
  /** A JSON error report. The app sends a few kilobytes at most. */
  errorBytes: 64 * 1024,
  /** A minidump upload as it arrives, usually gzip. */
  minidumpWireBytes: 8 * 1024 * 1024,
  /** The same upload once inflated, so a small gzip bomb cannot grow without bound. */
  minidumpBytes: 16 * 1024 * 1024,
  message: 1_000,
  stack: 16_000,
  formFields: 64,
  formValue: 256,
} as const;

/** The product name Electron's crashReporter sends in `_productName` (electron-builder's productName). */
export const PRODUCT_NAME = "PoliTost Pyxis";

const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-[0-9A-Za-z.-]{1,32})?$/;
const OS = ["darwin", "win32", "linux"] as const;
const ARCH = ["x64", "arm64", "ia32", "arm"] as const;
const PROCESS = ["main", "core", "renderer"] as const;
const ERROR_NAME = /^[A-Za-z_$][\w$]{0,63}$/;
const PROCESS_TYPE = /^[a-z][a-z-]{0,31}$/;

export type ErrorReport = {
  appVersion: string;
  electronVersion: string;
  os: (typeof OS)[number];
  arch: (typeof ARCH)[number];
  process: (typeof PROCESS)[number];
  name: string;
  message: string;
  stack: string;
};

const ERROR_KEYS = ["appVersion", "electronVersion", "os", "arch", "process", "name", "message", "stack"] as const;

function text(status: number, body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

class TooLarge extends Error {}

/** Reads a stream into memory, failing as soon as it passes `cap` bytes instead of buffering all of it. */
async function readCapped(stream: ReadableStream<Uint8Array>, cap: number): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > cap) {
        void reader.cancel().catch(() => {});
        throw new TooLarge();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

async function body(request: Request, cap: number): Promise<Uint8Array> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > cap) throw new TooLarge();
  if (!request.body) return new Uint8Array();
  return readCapped(request.body, cap);
}

function isGzip(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

/** A last safety net behind the app's own scrubbing: an account name in a home-folder path becomes `~`. */
export function redactHome(value: string): string {
  return value
    .replace(/(?:[A-Za-z]:)?[\\/](?:Users|home|Documents and Settings)[\\/][^\\/\n"'`:)]+/gi, "~")
    .replace(/\/var\/home\/[^/\n"'`:)]+/g, "~");
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Groups reports of the same error: process, name, message with numbers folded, and the top five frames. */
export async function fingerprint(report: ErrorReport): Promise<string> {
  const frames = report.stack.split("\n").slice(0, 5).join("\n");
  const message = report.message.replace(/\d+/g, "#");
  return (await sha256Hex([report.process, report.name, message, frames].join("\n"))).slice(0, 16);
}

function isOneOf<T extends string>(list: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (list as readonly string[]).includes(value);
}

function boundedText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length <= max && !value.includes("\u0000");
}

/** The report when every field is present, of the right type and size, and nothing else is there; otherwise null. */
export function parseErrorReport(input: unknown): ErrorReport | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const record = input as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== ERROR_KEYS.length || !ERROR_KEYS.every((key) => keys.includes(key))) return null;
  const { appVersion, electronVersion, os, arch, process, name, message, stack } = record;
  if (typeof appVersion !== "string" || !VERSION.test(appVersion)) return null;
  if (typeof electronVersion !== "string" || !VERSION.test(electronVersion)) return null;
  if (!isOneOf(OS, os) || !isOneOf(ARCH, arch) || !isOneOf(PROCESS, process)) return null;
  if (typeof name !== "string" || !ERROR_NAME.test(name)) return null;
  if (!boundedText(message, LIMITS.message) || !boundedText(stack, LIMITS.stack)) return null;
  return { appVersion, electronVersion, os, arch, process, name, message, stack };
}

function day(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/**
 * The days this isolate already saw the budget run out, per kind, so a flood after that costs no Durable Object call
 * and no body read. Only a full day is remembered, never a report that was merely too big for the bytes left. A full
 * day for errors (the report count or the bytes are gone) is full for minidumps too.
 */
const spent: Partial<Record<ReportKind, string>> = {};

function full(now: Date): Response {
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return text(503, "daily limit reached", { "retry-after": String(Math.ceil((midnight - now.getTime()) / 1000)) });
}

/** Takes room in the global budget before a report is written; false when it doesn't fit. */
async function reserve(env: Env, now: Date, kind: ReportKind, bytes: number): Promise<boolean> {
  const budget = env.BUDGET.get(env.BUDGET.idFromName("global"));
  const answer = await budget.reserve(day(now), kind, bytes);
  if (answer === "stored") return true;
  if (answer === "full") {
    spent[kind] = day(now);
    if (kind === "error") spent.minidump = day(now);
  }
  return false;
}

async function storeError(request: Request, env: Env, now: Date): Promise<Response> {
  if (!/^application\/json\s*(?:;|$)/i.test(request.headers.get("content-type") ?? ""))
    return text(415, "expected application/json");
  if (request.headers.has("content-encoding")) return text(415, "expected an uncompressed body");
  const bytes = await body(request, LIMITS.errorBytes);
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    return text(400, "expected a JSON object");
  }
  const report = parseErrorReport(parsed);
  if (!report) return text(400, "invalid report");
  const clean: ErrorReport = { ...report, message: redactHome(report.message), stack: redactHome(report.stack) };
  const id = crypto.randomUUID();
  const group = await fingerprint(clean);
  const stored = JSON.stringify({ receivedAt: now.toISOString(), fingerprint: group, ...clean });
  if (!(await reserve(env, now, "error", new TextEncoder().encode(stored).byteLength))) return full(now);
  await env.REPORTS.put(
    `${day(now)}/error/${id}.json`,
    stored,
    {
      httpMetadata: { contentType: "application/json" },
      customMetadata: { fingerprint: group, process: clean.process, appVersion: clean.appVersion },
    },
  );
  return new Response(null, { status: 204 });
}

type MinidumpFields = { appVersion: string; electronVersion: string; platform: string; processType: string };

/**
 * The fields kept from a Crashpad upload. Electron sends `_productName`, `_version` (the app), `ver` (Electron),
 * `platform`, `process_type`, plus others such as `guid`, an installation id; everything not read here is dropped.
 */
export function minidumpFields(form: FormData): MinidumpFields | null {
  const value = (key: string): string | null => {
    const field = form.get(key);
    return typeof field === "string" && field.length <= LIMITS.formValue ? field : null;
  };
  if (value("_productName") !== PRODUCT_NAME) return null;
  const appVersion = value("_version");
  const electronVersion = value("ver");
  if (!appVersion || !VERSION.test(appVersion) || !electronVersion || !VERSION.test(electronVersion)) return null;
  const platform = value("platform");
  const processType = value("process_type");
  return {
    appVersion,
    electronVersion,
    platform: isOneOf(OS, platform) ? platform : "unknown",
    processType: processType && PROCESS_TYPE.test(processType) ? processType : "unknown",
  };
}

async function storeMinidump(request: Request, env: Env, now: Date): Promise<Response> {
  const type = request.headers.get("content-type") ?? "";
  if (!/^multipart\/form-data\s*;\s*boundary=/i.test(type)) return text(415, "expected multipart/form-data");
  const encoding = (request.headers.get("content-encoding") ?? "identity").trim().toLowerCase();
  if (encoding !== "gzip" && encoding !== "identity") return text(415, "unsupported content encoding");
  let bytes = await body(request, LIMITS.minidumpWireBytes);
  // Crashpad gzips the body. Inflate only what really is gzip, in case the edge already inflated it.
  if (isGzip(bytes)) {
    try {
      bytes = await readCapped(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip")), LIMITS.minidumpBytes);
    } catch (error) {
      if (error instanceof TooLarge) throw error;
      return text(400, "invalid gzip body");
    }
  } else if (encoding === "gzip") return text(400, "invalid gzip body");
  let form: FormData;
  try {
    form = await new Request("https://pyxis-crash.invalid/", {
      method: "POST",
      headers: { "content-type": type },
      body: bytes,
    }).formData();
  } catch {
    return text(400, "invalid multipart body");
  }
  let fieldCount = 0;
  let files = 0;
  for (const [, entry] of form) {
    fieldCount += 1;
    if (typeof entry !== "string") files += 1;
  }
  if (fieldCount > LIMITS.formFields) return text(400, "too many fields");
  const dump = form.get("upload_file_minidump");
  if (files !== 1 || !dump || typeof dump === "string") return text(400, "expected one minidump file");
  const dumpBytes = new Uint8Array(await dump.arrayBuffer());
  // Every minidump starts with the signature "MDMP".
  if (dumpBytes.length < 32 || new TextDecoder().decode(dumpBytes.subarray(0, 4)) !== "MDMP")
    return text(400, "not a minidump");
  const fields = minidumpFields(form);
  if (!fields) return text(400, "invalid fields");
  if (!(await reserve(env, now, "minidump", dumpBytes.byteLength))) return full(now);
  const id = crypto.randomUUID();
  await env.REPORTS.put(`${day(now)}/minidump/${id}.dmp`, dumpBytes, {
    httpMetadata: { contentType: "application/octet-stream" },
    customMetadata: { receivedAt: now.toISOString(), ...fields },
  });
  // Crashpad records the response body as the report id.
  return text(200, id);
}

const routes = { "/error": storeError, "/minidump": storeMinidump } as const;

export async function handle(request: Request, env: Env, now = new Date()): Promise<Response> {
  const { pathname } = new URL(request.url);
  const route = routes[pathname as keyof typeof routes];
  if (!route) return text(404, "not found");
  if (request.method !== "POST") return text(405, "method not allowed", { allow: "POST" });
  // The address is a rate-limit key only, counted in memory at the Cloudflare location and never written anywhere.
  const client = request.headers.get("cf-connecting-ip") ?? "unknown";
  const [perClient, perRoute] = await Promise.all([
    env.CLIENT_LIMIT.limit({ key: `${pathname}:${client}` }),
    env.ROUTE_LIMIT.limit({ key: pathname }),
  ]);
  if (!perClient.success || !perRoute.success) return text(429, "too many reports", { "retry-after": "60" });
  if (spent[pathname === "/error" ? "error" : "minidump"] === day(now)) return full(now);
  try {
    return await route(request, env, now);
  } catch (error) {
    if (error instanceof TooLarge) return text(413, "too large");
    throw error;
  }
}
