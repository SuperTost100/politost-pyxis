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

/**
 * The words of a message: a linked file that moved sends the student to its folder, a stored copy that is gone to
 * "Sostituisci il file", and a removed source says it left the Library.
 */
export function messageText(reason: PanelReason, source: PanelSource | null): { title: string; body: string } {
  if (reason === "removed") return { title: "sources.panel.gone", body: "sources.viewer.removedBody" };
  if (reason === "missing" && source && !source.linked) return { title: "sources.viewer.missingStoredTitle", body: "sources.viewer.missingStored" };
  return { title: `sources.viewer.${reason}Title`, body: `sources.viewer.${reason}Body` };
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

/**
 * The bytes from `begin` to `end` of an original, read through core. One call returns at most 2 MiB
 * (`ORIGINAL_CHUNK_MAX`), and pdf.js may ask for more at once for a large picture or font, so the range is read in
 * pieces. A read that returns nothing is the file's end. A failed read rejects with core's error.
 */
export async function readRange(
  read: (start: number, length: number) => Promise<{ bytes: Uint8Array }>,
  begin: number,
  end: number,
): Promise<Uint8Array> {
  const pieces: Uint8Array[] = [];
  let at = begin;
  while (at < end) {
    const { bytes } = await read(at, end - at);
    if (bytes.length === 0) break;
    pieces.push(bytes);
    at += bytes.length;
  }
  if (pieces.length === 1) return pieces[0]!;
  const whole = new Uint8Array(at - begin);
  let offset = 0;
  for (const piece of pieces) {
    whole.set(piece, offset);
    offset += piece.length;
  }
  return whole;
}

/** What a PDF that can't be drawn tells the panel: core's `source-file-missing` code is the missing file. */
export function pdfFailure(err: unknown): { error: "locked" | "missing" | "failed"; detail?: string } {
  if (err instanceof Error && err.name === "PasswordException") return { error: "locked" };
  const code = typeof err === "object" && err !== null && "code" in err ? (err as { code: unknown }).code : undefined;
  if (code === "source-file-missing") return { error: "missing" };
  return { error: "failed", detail: typeof code === "string" ? code : err instanceof Error ? err.message : String(err) };
}

/** Stores a page's picture at the width it was drawn, letting go of the same page's pictures at other widths. */
export function keepPicture<P extends { close(): void }>(pictures: Map<string, P>, page: number, key: string, picture: P): void {
  for (const [name, old] of pictures)
    if (name !== key && name.startsWith(`${page}@`)) {
      old.close();
      pictures.delete(name);
    }
  pictures.set(key, picture);
}

/**
 * Owns a pdf.js loading task, so it is destroyed on every path: when the panel moves on or closes (also before the task
 * exists, or while it loads) and when a read fails. `fail` answers true only the first time, so one failure is reported.
 */
export function loadingSlot() {
  let task: { destroy(): Promise<void> } | null = null;
  let closed = false;
  const close = () => {
    if (closed) return false;
    closed = true;
    void task?.destroy();
    return true;
  };
  return {
    get closed() {
      return closed;
    },
    /** Takes the task just started. False when the slot was closed first: the task is destroyed at once. */
    hold(next: { destroy(): Promise<void> }): boolean {
      task = next;
      if (closed) void next.destroy();
      return !closed;
    },
    dispose: close,
    fail: close,
  };
}
