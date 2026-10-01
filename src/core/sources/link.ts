import { lookup } from "node:dns/promises";
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const TIMEOUT_MS = 15_000;

export type PageSnapshot = {
  finalUrl: string;
  title: string;
  markdown: string;
  pdf: Uint8Array | null;
};

function allowed(url: URL): void {
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("link-scheme");
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

function blockedAddress(address: string): boolean {
  let host = address.toLowerCase().replace(/^\[|\]$/g, "").split("%")[0] ?? "";
  const mapped = ipv4FromMapped(host);
  if (mapped) host = mapped;
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
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
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }
  if (!host.includes(":")) return false;
  const head = Number.parseInt(host.split(":")[0] || "0", 16);
  if (head >= 0xfe80 && head <= 0xfebf) return true;
  if (head >= 0xfec0 && head <= 0xfeff) return true;
  if (head >= 0xff00) return true;
  return host.startsWith("fc") || host.startsWith("fd");
}

async function publicAddresses(
  url: URL,
  resolve: (hostname: string) => Promise<string[]>,
): Promise<string[]> {
  allowed(url);
  if (blockedAddress(url.hostname)) throw new Error("link-scheme");
  const addresses = await resolve(url.hostname);
  const safe = addresses.filter((address) => !blockedAddress(address));
  if (addresses.length === 0 || safe.length !== addresses.length) throw new Error("link-scheme");
  return safe;
}

async function fetchPinned(
  url: URL,
  address: string,
  init: RequestInit,
): Promise<{ agent: { close: () => Promise<void> }; response: Response }> {
  const { Agent, fetch: undiciFetch } = await import("undici");
  const family = address.includes(":") ? 6 : 4;
  const agent = new Agent({
    connect: {
      lookup: (_hostname, _options, callback) => {
        callback(null, [{ address, family }]);
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

async function readCapped(response: Response): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_BYTES) throw new Error("link-too-big");
    return bytes;
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const step = await reader.read();
    if (step.done) break;
    size += step.value.byteLength;
    if (size > MAX_BYTES) {
      await reader.cancel();
      throw new Error("link-too-big");
    }
    chunks.push(step.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** Fetch a page as data. Scripts in the HTML are never run. */
export async function fetchSnapshot(
  rawUrl: string,
  fetchImpl: typeof fetch = fetch,
  resolve: (hostname: string) => Promise<string[]> = async (hostname) => {
    const found = await lookup(hostname, { all: true });
    return found.map((item) => item.address);
  },
): Promise<PageSnapshot> {
  let current = new URL(rawUrl);
  const pin = fetchImpl === fetch;
  let response: Response | null = null;
  let agent: { close: () => Promise<void> } | null = null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const addresses = await publicAddresses(current, resolve);
      const init: RequestInit = {
        redirect: "manual",
        signal: controller.signal,
        headers: { accept: "text/html,application/pdf;q=0.9,*/*;q=0.1" },
      };
      try {
        const target = addresses[0];
        if (pin && target) {
          await agent?.close();
          agent = null;
          const pinned = await fetchPinned(current, target, init);
          agent = pinned.agent;
          response = pinned.response;
        } else {
          response = await fetchImpl(current.toString(), init);
        }
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") throw new Error("link-timeout");
        throw new Error("link-failed");
      }
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (!location || hop === MAX_REDIRECTS) throw new Error("link-redirect");
        current = new URL(location, current);
        continue;
      }
      break;
    }
    if (!response || !response.ok) throw new Error("link-failed");
    let bytes: Uint8Array;
    try {
      bytes = await readCapped(response);
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") throw new Error("link-timeout");
      throw err;
    }
    const type = (response.headers.get("content-type") ?? "").toLowerCase();
    if (type.includes("application/pdf") || current.pathname.toLowerCase().endsWith(".pdf")) {
      return { finalUrl: current.toString(), title: current.pathname, markdown: "", pdf: bytes };
    }
    const html = new TextDecoder().decode(bytes);
    const article = articleFromHtml(html, current.toString());
    return { finalUrl: current.toString(), title: article.title, markdown: article.markdown, pdf: null };
  } finally {
    clearTimeout(timer);
    await agent?.close();
  }
}

export function articleFromHtml(html: string, pageUrl: string): { title: string; markdown: string } {
  const { document } = parseHTML(html);
  for (const node of document.querySelectorAll("script, style, noscript")) node.remove();
  const article = new Readability(document, { charThreshold: 20 }).parse();
  const title =
    article?.title?.trim() ||
    document.querySelector("title")?.textContent?.trim() ||
    pageUrl;
  const content = article?.content ?? document.body?.innerHTML ?? "";
  const markdown = new TurndownService({ headingStyle: "atx" }).turndown(content).trim();
  if (markdown.replace(/\s/g, "").length < 40) throw new Error("page-empty");
  return { title, markdown };
}
