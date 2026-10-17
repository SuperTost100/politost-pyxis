import { lookup } from "node:dns/promises";
import { allowed, fetchPinned, idleTimeout, publicAddresses } from "./public-fetch";

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_REDIRECTS = 5;
/** How long a link import waits for the next response or part of the body before it gives up. */
const IDLE_MS = 15_000;

export type PageSnapshot = {
  finalUrl: string;
  title: string;
  markdown: string;
  pdf: Uint8Array | null;
};

/** The address a student typed, as a URL. Text that is not an http or https address is refused as `link-scheme`. */
export function parseLinkUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error("link-scheme");
  }
  allowed(url);
  return url;
}

/** A PDF link is named after its file, decoded and without the extension: `.../Appunti%20di%20Fisica.pdf` is "Appunti di Fisica". */
function pdfTitle(url: URL): string {
  const name = url.pathname.split("/").filter(Boolean).pop() ?? "";
  let decoded = name;
  try {
    decoded = decodeURIComponent(name);
  } catch {
    /* A malformed escape keeps the name as written. */
  }
  return decoded.replace(/\.pdf$/i, "").trim() || url.hostname;
}

/**
 * Page text in the charset the page declares: the Content-Type header first, then a `<meta>` tag near the top.
 * Without one, or with a label the decoder does not know, the bytes are read as UTF-8.
 */
function decodeHtml(bytes: Uint8Array, contentType: string): string {
  const declared = (text: string) => /charset\s*=\s*["']?([\w.:-]+)/i.exec(text)?.[1];
  const label =
    declared(contentType) ??
    declared(new TextDecoder("latin1").decode(bytes.subarray(0, 1024)));
  try {
    return new TextDecoder(label ?? "utf-8").decode(bytes);
  } catch {
    return new TextDecoder().decode(bytes);
  }
}

async function readCapped(response: Response, onPart: () => void): Promise<Uint8Array> {
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
    onPart();
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

/**
 * Fetch a page as data. Scripts in the HTML are never run. The request gives up as `link-timeout` when no response or
 * part of the body arrives for `idleMs`, so a slow connection can still bring a large PDF.
 */
export async function fetchSnapshot(
  rawUrl: string,
  fetchImpl: typeof fetch = fetch,
  resolve: (hostname: string) => Promise<string[]> = async (hostname) => {
    const found = await lookup(hostname, { all: true });
    return found.map((item) => item.address);
  },
  signal?: AbortSignal,
  idleMs = IDLE_MS,
): Promise<PageSnapshot> {
  let current = parseLinkUrl(rawUrl);
  const pin = fetchImpl === fetch;
  let response: Response | null = null;
  let agent: { close: () => Promise<void> } | null = null;
  const controller = new AbortController();
  const idle = idleTimeout(idleMs);
  const requestSignal = AbortSignal.any(
    signal ? [controller.signal, idle.signal, signal] : [controller.signal, idle.signal],
  );
  requestSignal.throwIfAborted();
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const addresses = await publicAddresses(current, resolve);
      const init: RequestInit = {
        redirect: "manual",
        signal: requestSignal,
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
        if (err instanceof Error && err.name === "AbortError")
          throw new Error("link-timeout");
        throw new Error("link-failed");
      }
      idle.touch();
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (!location || hop === MAX_REDIRECTS)
          throw new Error("link-redirect");
        current = new URL(location, current);
        continue;
      }
      break;
    }
    if (!response || !response.ok) {
      await response?.body?.cancel();
      throw new Error("link-failed");
    }
    let bytes: Uint8Array;
    try {
      bytes = await readCapped(response, idle.touch);
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError")
        throw new Error("link-timeout");
      throw err;
    }
    const type = (response.headers.get("content-type") ?? "").toLowerCase();
    if (
      type.includes("application/pdf") ||
      current.pathname.toLowerCase().endsWith(".pdf")
    ) {
      return {
        finalUrl: current.toString(),
        title: pdfTitle(current),
        markdown: "",
        pdf: bytes,
      };
    }
    const html = decodeHtml(bytes, type);
    const article = await articleFromHtml(html, current.toString());
    return {
      finalUrl: current.toString(),
      title: article.title,
      markdown: article.markdown,
      pdf: null,
    };
  } finally {
    controller.abort();
    idle.clear();
    await agent?.close();
  }
}

/** The parsers load on the first page a student imports, not when the app starts. */
export async function articleFromHtml(
  html: string,
  pageUrl: string,
): Promise<{ title: string; markdown: string }> {
  const [{ parseHTML }, { Readability }, { default: TurndownService }] =
    await Promise.all([
      import("linkedom"),
      import("@mozilla/readability"),
      import("turndown"),
    ]);
  const { document } = parseHTML(html);
  for (const node of document.querySelectorAll("script, style, noscript"))
    node.remove();
  const article = new Readability(document, { charThreshold: 20 }).parse();
  const title =
    article?.title?.trim() ||
    document.querySelector("title")?.textContent?.trim() ||
    pageUrl;
  const content = article?.content ?? document.body?.innerHTML ?? "";
  const markdown = new TurndownService({ headingStyle: "atx" })
    .turndown(content)
    .trim();
  if (markdown.replace(/\s/g, "").length < 40) throw new Error("page-empty");
  return { title, markdown };
}
