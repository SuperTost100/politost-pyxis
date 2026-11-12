import type { RequestOutput } from "../../../shared/ipc";

export type PanelSource = NonNullable<RequestOutput<"sources.panel">>;

/** Why the panel shows a message instead of the file: each has its own words and its own way out. */
export type PanelReason = "missing" | "removed" | "locked" | "reading" | "failed";

/**
 * What the panel draws for a source:
 * - `pdf`: the page itself, from the original, one page at a time.
 * - `image`: the picture, with the text Pyxis read from it.
 * - `text`: the text Pyxis read, laid out as a page, for what Pyxis can't draw (Word, slides, plain text, a saved web
 *   page, a free book). `ownApp` says the real layout is in the file's own app.
 * - `message`: the file can't be shown now; the cited passage's text still is, when there is one.
 */
export type PanelBody =
  | { show: "pdf" }
  | { show: "image" }
  | { show: "text"; ownApp: "document" | "slides" | null }
  | { show: "message"; reason: PanelReason };

export type PanelPlan = {
  body: PanelBody;
  /** What the arrows move by, or null when the whole text scrolls in one piece. */
  unit: "page" | "slide" | "chapter" | null;
  /** The page, slide or chapter to open on. */
  start: number;
  /** How many there are, when Pyxis knows before drawing (a PDF's count comes from the file). */
  count: number | null;
  /** "Apri il file": there is an original the system can open. */
  openFile: boolean;
  /** The address of a page saved from a link. */
  address: string | null;
  /** The file is being read now, though it can already be shown. */
  reading: boolean;
  /** The citation is from an earlier version of the file. */
  changed: boolean;
};

const DRAWN_IMAGE = /^image\/(png|jpeg|webp|gif)$/;

/** Decides what the panel shows for a source in its state, opened at a passage or at its start. */
export function planPanel(source: PanelSource, opened: { chapter?: number } = {}): PanelPlan {
  const passage = source.passage;
  const base = {
    openFile: source.original !== null && source.state !== "removed" && source.kind !== "smartbook",
    address: source.originUrl,
    reading: source.state === "reading",
    changed: source.changed,
  };
  const message = (reason: PanelReason): PanelPlan => ({ ...base, body: { show: "message", reason }, unit: null, start: 1, count: null });
  if (source.state === "removed") return { ...message("removed"), openFile: false };
  if (source.missing && !source.original) return message("missing");
  if (source.state === "locked") return message("locked");
  const drawable = source.original !== null;
  if (source.kind === "pdf" && drawable)
    return { ...base, body: { show: "pdf" }, unit: "page", start: Math.max(1, passage?.page ?? 1), count: null };
  if (source.kind === "image" && drawable && DRAWN_IMAGE.test(source.mime ?? ""))
    return { ...base, body: { show: "image" }, unit: null, start: 1, count: null };
  // Nothing read yet and nothing to draw: wait for the read, or say it failed.
  const nothingRead = !passage && source.pages === null && source.slides === null;
  if (source.state === "reading" && nothingRead && source.kind !== "smartbook") return message("reading");
  if (source.state === "failed" && nothingRead) return message("failed");
  if (source.kind === "pptx")
    return {
      ...base,
      body: { show: "text", ownApp: drawable ? "slides" : null },
      unit: "slide",
      start: Math.max(1, passage?.slide ?? 1),
      count: source.slides,
    };
  if (source.kind === "smartbook")
    return { ...base, body: { show: "text", ownApp: null }, unit: "chapter", start: passage?.chapter ?? opened.chapter ?? 1, count: null };
  // A PDF whose original is gone, read page by page: its read text, by page.
  if (source.kind === "pdf" && source.pages)
    return { ...base, body: { show: "text", ownApp: null }, unit: "page", start: Math.max(1, passage?.page ?? 1), count: source.pages };
  return {
    ...base,
    body: { show: "text", ownApp: drawable && (source.kind === "docx" || source.kind === "image") ? "document" : null },
    unit: null,
    start: 1,
    count: null,
  };
}

/** The page a request lands on: whole, within 1 and the count when the count is known. */
export function clampPage(page: number, count: number | null): number {
  const whole = Number.isFinite(page) ? Math.round(page) : 1;
  return Math.max(1, count ? Math.min(whole, count) : whole);
}

/** What a key pressed in the panel does to the page, or null to leave the key alone. */
export function pageKey(key: string): -1 | 1 | "first" | "last" | null {
  if (key === "ArrowRight" || key === "PageDown") return 1;
  if (key === "ArrowLeft" || key === "PageUp") return -1;
  if (key === "Home") return "first";
  if (key === "End") return "last";
  return null;
}

/**
 * The pages to keep drawn: the one on screen and the last few seen, most recent first. Paging through a 900-page book
 * keeps this many pages in memory, never more.
 */
export function keepPages(kept: number[], page: number, size = 3): { kept: number[]; dropped: number[] } {
  const next = [page, ...kept.filter((n) => n !== page)];
  return { kept: next.slice(0, size), dropped: next.slice(size) };
}

/** The text runs of a page that a cited passage covers, matched on words with spacing and case ignored. */
export function citedRuns(runs: string[], passage: string): number[] {
  const normalize = (value: string) => value.replace(/\s+/g, " ").trim().toLocaleLowerCase();
  const needle = normalize(passage);
  if (!needle) return [];
  const parts = runs.map(normalize);
  const full = parts.filter(Boolean).join(" ");
  let start = full.indexOf(needle);
  let length = needle.length;
  // A passage that runs onto the next page matches here only in part: the longest opening of it on this page marks it,
  // when that opening is long enough not to match by chance. A shorter opening is found wherever a longer one is.
  if (start < 0) {
    let low = 0;
    let high = needle.length;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (full.includes(needle.slice(0, mid))) low = mid;
      else high = mid - 1;
    }
    length = low;
    start = length >= 24 ? full.indexOf(needle.slice(0, length)) : -1;
  }
  if (start < 0) return [];
  const hits: number[] = [];
  let offset = 0;
  parts.forEach((part, index) => {
    if (!part) return;
    if (offset < start + length && offset + part.length > start) hits.push(index);
    offset += part.length + 1;
  });
  return hits;
}
