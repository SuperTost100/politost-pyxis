import { lookup } from "node:dns/promises";

// Kept apart from link.ts, which parses HTML: main fetches plan files with these and should not load those parsers.

/**
 * An abort that fires when nothing arrives for `ms`. `touch` restarts the wait: call it on each response and each part of
 * a body, so a large file on a slow connection takes as long as it needs and a stalled one still ends, as `books.ts` does.
 */
export function idleTimeout(
  ms: number,
  reason?: unknown,
): { signal: AbortSignal; touch: () => void; clear: () => void } {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const touch = () => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(reason), ms);
  };
  touch();
  return { signal: controller.signal, touch, clear: () => clearTimeout(timer) };
}

/**
 * Reads a response body into memory, stopping with `tooBig()` as soon as it passes `max` bytes, before that part is
 * kept. `onPart` runs as each part arrives (an idle timer's `touch`), and `signal` is checked before each read. The
 * reader is released however the read ends. The result has its own buffer of exactly its size.
 */
export async function readCapped(
  body: ReadableStream<Uint8Array>,
  max: number,
  tooBig: () => Error,
  options: { onPart?: () => void; signal?: AbortSignal } = {},
): Promise<Uint8Array> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      options.signal?.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      options.onPart?.();
      size += value.byteLength;
      if (size > max) throw tooBig();
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export function allowed(url: URL): void {
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new Error("link-scheme");
}

function ipv4FromMapped(host: string): string | null {
  const dotted = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(host);
  if (dotted?.[1]) return dotted[1];
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
  if (!hex?.[1] || !hex[2]) return null;
  const hi = Number.parseInt(hex[1], 16);
  const lo = Number.parseInt(hex[2], 16);
  return `${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`;
}

export function blockedAddress(address: string): boolean {
  let host =
    address
      .toLowerCase()
      .replace(/^\[|\]$/g, "")
      .split("%")[0] ?? "";
  const mapped = ipv4FromMapped(host);
  if (mapped) host = mapped;
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local")
  )
    return true;
  if (host === "::1" || host === "::" || host === "0.0.0.0") return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const parts = v4.slice(1).map(Number);
    if (parts.some((part) => part > 255)) return true;
    const a = parts[0] ?? 0;
    const b = parts[1] ?? 0;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && (b === 168 || (b === 0 && parts[2] === 0))) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a >= 224 || (a === 198 && (b === 18 || b === 19))) return true;
    return false;
  }
  if (!host.includes(":")) return false;
  if (
    host.startsWith("64:ff9b:") ||
    host.startsWith("2002:") ||
    host.startsWith("2001:db8:")
  )
    return true;
  const head = Number.parseInt(host.split(":")[0] || "0", 16);
  if (head < 0x2000 || head >= 0x4000 || /^2001:(?:0{1,4})?:/.test(host))
    return true;
  if (head >= 0xfe80 && head <= 0xfebf) return true;
  if (head >= 0xfec0 && head <= 0xfeff) return true;
  if (head >= 0xff00) return true;
  return host.startsWith("fc") || host.startsWith("fd");
}

export async function publicAddresses(
  url: URL,
  resolve: (hostname: string) => Promise<string[]>,
): Promise<string[]> {
  allowed(url);
  if (blockedAddress(url.hostname)) throw new Error("link-scheme");
  const addresses = await resolve(url.hostname);
  const safe = addresses.filter((address) => !blockedAddress(address));
  if (addresses.length === 0 || safe.length !== addresses.length)
    throw new Error("link-scheme");
  return safe;
}

export async function fetchPinned(
  url: URL,
  address: string,
  init: RequestInit,
): Promise<{ agent: { close: () => Promise<void> }; response: Response }> {
  const { Agent, fetch: undiciFetch } = await import("undici");
  const family = address.includes(":") ? 6 : 4;
  const agent = new Agent({
    connect: {
      lookup: (_hostname, options, callback) => {
        if (typeof options === "object" && options.all)
          callback(null, [{ address, family }]);
        else callback(null, address, family);
      },
    },
  });
  try {
    const response = (await undiciFetch(url.toString(), {
      ...init,
      dispatcher: agent,
    })) as unknown as Response;
    return { agent, response };
  } catch (err) {
    await agent.close();
    throw err;
  }
}

/** One pinned public request; the caller must close the agent after consuming the body. */
export async function fetchPublicResponse(rawUrl: string, init: RequestInit) {
  const url = new URL(rawUrl);
  const addresses = await publicAddresses(url, async (hostname) =>
    (await lookup(hostname, { all: true })).map((item) => item.address),
  );
  return fetchPinned(url, addresses[0]!, init);
}
