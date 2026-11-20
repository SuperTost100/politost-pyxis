import { readFile, stat } from "node:fs/promises";
import { basename, extname } from "node:path";
import type Database from "better-sqlite3";
import { putBlob, readBlob } from "../blobs";
import type { Runner } from "../jobs/runner";
import { enqueueSourceFile } from "../sources/jobs";
import { imageMime } from "../sources/heic";
import { startScan } from "../sources/ocr-job";
import { loadVisionImage, type VisionImage } from "../sources/vision-image";
import { uuidv7 } from "../../shared/ids";
import { isAbort, type AttachmentError, type AttachmentView, type JobView } from "../../shared/ipc";
import {
  DOCUMENT_EXTENSIONS,
  IMAGE_EXTENSIONS,
  MAX_ATTACHED_FILES,
  isImageExt,
  maxSourceBytes,
} from "../../shared/source-types";
import { deleteHiddenSources, removeUnreferencedBlobs } from "./delete";

/** What a chat message can carry: the Library's documents and photos, without a smartbook. */
const ATTACHABLE = new Set<string>([...DOCUMENT_EXTENSIONS, ...IMAGE_EXTENSIONS].map((ext) => `.${ext}`));

const IMPORT_KINDS = ["source-import", "source-import-vision"] as const;
const READING_KINDS = [...IMPORT_KINDS, "source-ocr"];

/** A photo, kept until the message is sent: its stored original and the copy the model gets. */
type Photo = {
  sha: string;
  /** The copy for a model that reads images; null when it could not be made (the photo is read locally instead). */
  fitted?: VisionImage | null;
};

type Entry = {
  id: string;
  /** The composer draft it was attached to: a chat id, or empty for a new chat. */
  draft: string;
  name: string;
  kind: "document" | "photo";
  size: number;
  ext: string;
  abort: AbortController;
  /** Refused before any work began, with the reason. */
  refused?: AttachmentError;
  /** A document's hidden copy in the Library's tables. */
  sourceId?: string;
  /** The scan is waiting for the OCR language data. */
  needsData?: boolean;
  /** The scan was started once, so a stopped one is not started again by itself. */
  scanTried?: boolean;
  photo?: Photo;
  /** The photo is being fitted. */
  working?: Promise<void>;
  /** What the window was last told, so a job update that changes nothing sends nothing. */
  told?: string;
};

export type HeldDeps = {
  db: Database.Database;
  workspace: string;
  runner: Runner;
  /** Tells the window one file changed. */
  emit: (view: AttachmentView) => void;
  /**
   * Starts reading a scan and says so, or says the OCR language data is not on this computer yet. The default starts
   * the Library's scan job without looking, which the app replaces with its consent and data check.
   */
  scan?: (sourceId: string) => Promise<"started" | "needs-data">;
  /** The copy of a photo for a model that reads images. */
  fit?: (path: string, ext: string, signal?: AbortSignal) => Promise<VisionImage>;
};

/** What a turn takes from the files attached to it. */
export type TakenFiles = {
  /** The ids of the files taken, in the order they were attached. */
  order: string[];
  documents: Array<{ id: string; sourceId: string; name: string; size: number }>;
  photos: Array<{ id: string; name: string; size: number; ext: string; sha: string; file: string; fitted: VisionImage | null }>;
  /**
   * Files that could not be read, sent without. They stay held, failed, until the send goes through (the turn then takes
   * them off by `id`), so a send that fails leaves the composer as it was.
   */
  leftOut: Array<{ id: string; name: string; kind: "document" | "photo"; error: AttachmentError }>;
};

/** The reason a failed reading gives, from the code its job stopped with. */
export function attachmentErrorFor(code: string | null | undefined): AttachmentError {
  if (!code) return "unreadable";
  if (code === "pdf-password-required" || code === "pdf-password-wrong") return "password";
  if (["source-too-big", "archive-too-large", "source-worker-memory", "heic-too-large"].includes(code)) return "too-large";
  // A photo the decoder refuses for its size cannot be read here at all, with or without a model.
  if (code === "vision-image-decode-limit") return "picture-too-large";
  if (code.startsWith("ocr-data-")) return "data";
  return "unreadable";
}

/**
 * The files attached in the composer and not yet sent. A document is read at once by the Library's own import job
 * (and, for a scan, its page-by-page scan job) into a hidden source, so the same limits, readers and workers apply and
 * the reading is cancelled by taking the file off. A photo is fitted for the model. Core keeps each one until its
 * message is sent or it is taken off, and tells the window of every change (`chats.attachment`).
 */
export function createHeldFiles(deps: HeldDeps) {
  const { db, workspace, runner } = deps;
  const entries = new Map<string, Entry>();
  const bySource = new Map<string, string>();
  const waiters = new Set<() => void>();
  // Every held file is a row of `held_files` from the moment it is attached, so each cleanup (a deleted chat or plan, Free
  // up space, taking a file off, the sweep at start) asks the database whether a source or a file is still wanted.
  const insertRow = db.prepare(
    `INSERT INTO held_files (id, draft, name, kind, size, ext, state, source_id, blob_sha, created_at)
     VALUES (@id, @draft, @name, @kind, @size, @ext, 'reading', @source, @blob, @at)`,
  );
  const updateRow = db.prepare(
    `UPDATE held_files SET state = ?, error = ?, source_id = COALESCE(?, source_id), extracted_sha = COALESCE(?, extracted_sha)
     WHERE id = ?`,
  );
  const extractedOf = db.prepare(
    `SELECT json_extract(params_json, '$.extractedSha') FROM jobs WHERE kind IN ('source-import', 'source-import-vision')
     AND json_extract(params_json, '$.sourceId') = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`,
  );
  const record = (entry: Entry) =>
    insertRow.run({
      id: entry.id,
      draft: entry.draft,
      name: entry.name,
      kind: entry.kind,
      size: entry.size,
      ext: entry.ext,
      source: entry.sourceId ?? null,
      blob: entry.photo?.sha ?? null,
      at: Date.now(),
    });
  const fit = deps.fit ?? loadVisionImage;
  const scan =
    deps.scan ??
    (async (sourceId: string) => {
      startScan(db, runner, sourceId);
      return "started" as const;
    });

  const importJobRow = db.prepare(
    `SELECT id, state, progress, error FROM jobs WHERE kind IN ('source-import', 'source-import-vision')
     AND json_extract(params_json, '$.sourceId') = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`,
  );
  const importJob = (sourceId: string) =>
    importJobRow.get(sourceId) as { id: string; state: string; progress: number; error: string | null } | undefined;
  const scanJob = db.prepare(
    `SELECT id, state, progress, error, json_extract(params_json, '$.pages') AS pages FROM jobs WHERE kind = 'source-ocr' AND json_extract(params_json, '$.sourceId') = ?
     ORDER BY created_at DESC, rowid DESC LIMIT 1`,
  );
  function viewOf(entry: Entry): AttachmentView {
    const base = { id: entry.id, name: entry.name, kind: entry.kind, size: entry.size } as const;
    if (entry.refused) return { ...base, state: "failed", error: entry.refused };
    if (entry.kind === "photo") return { ...base, state: entry.photo?.fitted === undefined ? "reading" : "ready" };
    const row = db.prepare(`SELECT status FROM sources WHERE id = ?`).get(entry.sourceId) as { status: string } | undefined;
    if (!row || row.status === "removed") return { ...base, state: "failed", error: "cancelled" };
    const imported = importJob(entry.sourceId!);
    const scanned = scanJob.get(entry.sourceId) as
      | { id: string; state: string; progress: number; error: string | null; pages: number | null }
      | undefined;
    switch (row.status) {
      case "ready":
        return { ...base, state: "ready" };
      case "queued":
      case "extracting":
      case "indexing":
        // The import ended without finishing: its job says why, whatever status the source was left in.
        if (imported && ["failed", "cancelled"].includes(imported.state))
          return {
            ...base,
            state: "failed",
            error: imported.state === "cancelled" ? "cancelled" : attachmentErrorFor(imported.error),
          };
        return { ...base, state: "reading", phase: "read", progress: imported?.progress ?? 0 };
      case "ocr-queued": {
        const pages = scanned?.pages ?? undefined;
        const progress = scanned?.progress ?? 0;
        return {
          ...base,
          state: "reading",
          phase: "scan",
          progress,
          ...(pages ? { pages, page: Math.min(pages, Math.floor(progress * pages) + 1) } : {}),
        };
      }
      case "needs-ocr": {
        const stopped = scanned && ["failed", "cancelled", "interrupted"].includes(scanned.state) ? scanned : undefined;
        if (stopped) {
          const reason = attachmentErrorFor(stopped.error);
          return reason === "data" || stopped.state === "interrupted"
            ? { ...base, state: "needs-data", phase: "scan" }
            : { ...base, state: "failed", error: stopped.state === "cancelled" ? "cancelled" : reason };
        }
        // The student cancelled the import after its passages were stored: that is where it ends, and no scan is started.
        if (!scanned && imported?.state === "cancelled") return { ...base, state: "failed", error: "cancelled" };
        // The import just ended and the scan has not been started yet, or it waits for the language data.
        return entry.needsData
          ? { ...base, state: "needs-data", phase: "scan" }
          : { ...base, state: "reading", phase: "scan", progress: 0 };
      }
      default: {
        // failed, cancelled or interrupted: the job that stopped says why.
        const job = scanned && ["failed", "cancelled"].includes(scanned.state) ? scanned : imported;
        const reason = job?.state === "cancelled" || row.status === "cancelled" ? "cancelled" : attachmentErrorFor(job?.error);
        if (reason === "data") return { ...base, state: "needs-data", phase: "scan" };
        // A scan that had no text left to find reads as empty, not as broken.
        if (row.status === "failed" && !job?.error) return { ...base, state: "failed", error: "empty" };
        return { ...base, state: "failed", error: reason };
      }
    }
  }

  function notify(): void {
    for (const wake of [...waiters]) wake();
  }

  /** Tells the window if the file's view changed, and wakes whatever waits for the files to settle. */
  function refresh(entry: Entry): AttachmentView {
    const view = viewOf(entry);
    const text = JSON.stringify(view);
    if (entry.told !== text) {
      entry.told = text;
      updateRow.run(
        view.state,
        view.error ?? null,
        entry.sourceId ?? null,
        entry.sourceId ? ((extractedOf.pluck().get(entry.sourceId) as string | null) ?? null) : null,
        entry.id,
      );
      deps.emit(view);
    }
    notify();
    return view;
  }

  function register(entry: Omit<Entry, "abort">): Entry {
    const full: Entry = { ...entry, abort: new AbortController() };
    entries.set(full.id, full);
    return full;
  }

  /** Starts the scan once a document has been read and found to have no text. */
  async function startScanning(entry: Entry): Promise<void> {
    if (entry.scanTried || !entry.sourceId) return;
    entry.scanTried = true;
    try {
      entry.needsData = (await scan(entry.sourceId)) === "needs-data";
    } catch (error) {
      entry.needsData = error instanceof Error && error.message.startsWith("ocr-data-");
      if (!entry.needsData) entry.refused = "unreadable";
    }
    refresh(entry);
  }

  type Record = { id: string; source_id: string | null; blob_sha: string | null; extracted_sha: string | null };

  /**
   * Removes a file's work and what it made: its row, its jobs, its hidden copy, its stored photo and the extracted-text
   * file of its import. The row goes first, so the shared check (`deleteHiddenSources`, `removeUnreferencedBlobs`) does
   * not count it; whatever a stored question, another held file, a plan or an unfinished job still names stays.
   */
  function discardRecord(row: Record): void {
    // Read before the job is given up: the import's extracted-text file is named by its parameters.
    const extracted = row.extracted_sha ?? (row.source_id ? ((extractedOf.pluck().get(row.source_id) as string | null) ?? null) : null);
    db.prepare(`DELETE FROM held_files WHERE id = ?`).run(row.id);
    const hashes: string[] = [];
    if (row.source_id) {
      const jobs = db
        .prepare(`SELECT id FROM jobs WHERE kind IN (?, ?, 'source-ocr', 'source-index') AND json_extract(params_json, '$.sourceId') = ?`)
        .pluck()
        .all(...IMPORT_KINDS, row.source_id) as string[];
      for (const id of jobs) runner.discard(id);
      hashes.push(...db.transaction(() => deleteHiddenSources(db, [row.source_id!]))());
    }
    removeUnreferencedBlobs(db, workspace, [...hashes, ...(row.blob_sha ? [row.blob_sha] : []), ...(extracted ? [extracted] : [])]);
  }

  function discard(entry: Entry): void {
    entry.abort.abort();
    entries.delete(entry.id);
    if (entry.sourceId) bySource.delete(entry.sourceId);
    discardRecord({ id: entry.id, source_id: entry.sourceId ?? null, blob_sha: entry.photo?.sha ?? null, extracted_sha: null });
  }

  return {
    /**
     * Attaches a file the IPC boundary has already read within its size cap. A file that cannot be attached is held as
     * a failed one with its reason, so its chip says why instead of the whole request failing.
     */
    async attach(path: string, draft = ""): Promise<AttachmentView> {
      const ext = extname(path).toLowerCase();
      const name = basename(path);
      const id = uuidv7();
      const size = (await stat(path)).size;
      const base = { id, draft, name, kind: isImageExt(ext) ? ("photo" as const) : ("document" as const), size, ext };
      const refused = (error: AttachmentError) => {
        const entry = register({ ...base, refused: error });
        record(entry);
        return refresh(entry);
      };
      if (!ATTACHABLE.has(ext)) return refused("unsupported");
      if (size > maxSourceBytes(ext)) return refused("too-large");
      if (base.kind === "photo") {
        const bytes = await readFile(path);
        const entry = register({ ...base, photo: { sha: putBlob(workspace, bytes, imageMime(ext), ext.slice(1)) } });
        record(entry);
        const file = readBlob(workspace, entry.photo!.sha).file;
        entry.working = fit(file, ext, entry.abort.signal).then(
          (image) => {
            if (entries.has(id)) entry.photo!.fitted = image;
          },
          (error) => {
            if (!entries.has(id) || isAbort(error)) return;
            // A valid photo past the provider's size limit has no copy for a model and is read locally when it is sent. One
            // that cannot be read at all fails on its chip now, so the send never decodes it again to fail there.
            const code = error instanceof Error ? error.message : "";
            if (code === "vision-image-too-large") entry.photo!.fitted = null;
            else entry.refused = attachmentErrorFor(code);
          },
        );
        void entry.working.then(() => entries.has(id) && refresh(entry));
        return refresh(entry);
      }
      try {
        // The row exists before the copy does, so a quit in between leaves a row for the sweep, not a copy nothing names.
        const entry = register(base);
        record(entry);
        try {
          const queued = await enqueueSourceFile(db, workspace, runner, path, undefined, undefined, true);
          // The draft went while the file was being registered: what it made belongs to nobody, so it goes now.
          if (!entries.has(id)) {
            discardRecord({ id, source_id: queued.sourceId, blob_sha: null, extracted_sha: null });
            return { id, name, kind: base.kind, size, state: "failed", error: "cancelled" };
          }
          entry.sourceId = queued.sourceId;
          bySource.set(queued.sourceId, id);
        } catch (error) {
          entries.delete(id);
          db.prepare(`DELETE FROM held_files WHERE id = ?`).run(id);
          throw error;
        }
        return refresh(entry);
      } catch (error) {
        const code = error instanceof Error ? error.message : "";
        const reason = attachmentErrorFor(code);
        // An error with no cause of its own reads as a damaged file on the chip; the log says what the system reported.
        if (reason === "unreadable") console.error("pyxis-core: a file could not be attached", (error as NodeJS.ErrnoException | undefined)?.code ?? code.slice(0, 60));
        return refused(reason);
      }
    },

    /** Takes a file off. A file already sent, or one that is unknown, is left alone. */
    detach(id: string): void {
      const entry = entries.get(id);
      if (entry) discard(entry);
      notify();
    },

    /** The views of the files still held among `ids`. */
    list(ids: string[]): AttachmentView[] {
      return ids.flatMap((id) => {
        const entry = entries.get(id);
        return entry ? [viewOf(entry)] : [];
      });
    },

    /** A job of the Library's reading moved: tells the window about the file it belongs to. */
    onJob(job: JobView): void {
      if (!READING_KINDS.includes(job.kind) || bySource.size === 0) return;
      const row = db.prepare(`SELECT params_json FROM jobs WHERE id = ?`).get(job.id) as { params_json: string } | undefined;
      const sourceId = row ? (JSON.parse(row.params_json) as { sourceId?: string }).sourceId : undefined;
      const entry = sourceId ? entries.get(bySource.get(sourceId) ?? "") : undefined;
      if (!entry) return;
      const view = refresh(entry);
      // The text of a scan is read from its pages, so a document that came out as a scan starts that reading itself.
      const status = db.prepare(`SELECT status FROM sources WHERE id = ?`).pluck().get(entry.sourceId) as string | undefined;
      // A scan whose import ended on its indexing step (the job failed after its passages were stored) is read all the same.
      if (status === "needs-ocr" && view.state === "reading" && ["succeeded", "failed"].includes(job.state)) void startScanning(entry);
    },

    /** Reads a scan that waited for its OCR data. Errors: `ocr-data-*` while the data is not there. */
    async scan(id: string): Promise<AttachmentView> {
      const entry = entries.get(id);
      if (!entry?.sourceId) throw new Error("attachment-missing");
      entry.needsData = false;
      entry.scanTried = false;
      await startScanning(entry);
      return refresh(entry);
    },

    /** Waits until none of the files is being read. Stops with the signal. */
    async settle(ids: string[], signal?: AbortSignal): Promise<void> {
      const reading = () =>
        ids.some((id) => {
          const entry = entries.get(id);
          return entry ? viewOf(entry).state === "reading" : false;
        });
      for (;;) {
        signal?.throwIfAborted();
        // A photo being fitted wakes the waiters when it ends (`refresh`), like a document's job does, so the wait below
        // is the only one and a stop ends it at once; the photo's own work goes on in the background.
        if (!reading()) return;
        await new Promise<void>((resolve, reject) => {
          const done = () => {
            waiters.delete(wake);
            signal?.removeEventListener("abort", stop);
          };
          const wake = () => (done(), resolve());
          const stop = () => (done(), reject(signal!.reason));
          waiters.add(wake);
          signal?.addEventListener("abort", stop, { once: true });
          // A stop that came before the listener was there has already been heard.
          if (signal?.aborted) stop();
        });
      }
    },

    /**
     * The files of a message, once they are settled: the ones that are read, and the ones left out with their reason.
     * Files past the most a message carries are left out the same way. Nothing is taken off here: the files stay held
     * until the message is stored and answered (`release`), so a send that fails keeps them.
     */
    take(ids: string[]): TakenFiles {
      const taken: TakenFiles = { order: [], documents: [], photos: [], leftOut: [] };
      let kept = 0;
      for (const id of new Set(ids)) {
        const entry = entries.get(id);
        if (!entry) continue;
        const view = viewOf(entry);
        if (view.state !== "ready" || kept >= MAX_ATTACHED_FILES) {
          taken.leftOut.push({
            id,
            name: entry.name,
            kind: entry.kind,
            error: view.state === "ready" ? "too-many" : view.state === "needs-data" ? "data" : (view.error ?? "unreadable"),
          });
          continue;
        }
        kept += 1;
        taken.order.push(id);
        if (entry.sourceId) taken.documents.push({ id, sourceId: entry.sourceId, name: entry.name, size: entry.size });
        else if (entry.photo)
          taken.photos.push({
            id,
            name: entry.name,
            size: entry.size,
            ext: entry.ext,
            sha: entry.photo.sha,
            file: readBlob(workspace, entry.photo.sha).file,
            fitted: entry.photo.fitted ?? null,
          });
      }
      return taken;
    },

    /** The files that go with a question: they are tied to it once it is stored (`finishSend` lets them go). */
    tie(ids: string[], messageId: string): void {
      const mark = db.prepare(`UPDATE held_files SET message_id = ? WHERE id = ?`);
      for (const id of ids) mark.run(messageId, id);
    },

    /** The question the files were tied to was taken back: they are the composer's again, tied to no question. */
    untie(messageId: string): void {
      db.prepare(`UPDATE held_files SET message_id = NULL WHERE message_id = ?`).run(messageId);
    },

    /**
     * The question was answered: the files tied to it let go. A file its stored rows name is simply no longer held, and one
     * they do not (a copy the chat already had, a file that could not be read) goes the way a file taken off does. A Try
     * again that answers a stored question lets its files go the same way, so none goes out again with the next one.
     */
    finishSend(messageId: string): void {
      const named = db.prepare(`SELECT 1 FROM attachments WHERE message_id = ? AND (source_id = ? OR blob_sha = ?)`);
      for (const row of db
        .prepare(`SELECT id, source_id, blob_sha, extracted_sha FROM held_files WHERE message_id = ?`)
        .all(messageId) as Record[]) {
        const entry = entries.get(row.id);
        if (named.get(messageId, row.source_id, row.blob_sha)) {
          if (entry) {
            entries.delete(row.id);
            if (entry.sourceId) bySource.delete(entry.sourceId);
          }
          db.prepare(`DELETE FROM held_files WHERE id = ?`).run(row.id);
        } else if (entry) discard(entry);
        else discardRecord(row);
      }
      notify();
    },

    /** A new chat took the composer a draft was in, so the files left in it follow. */
    rehome(from: string, to: string): void {
      for (const entry of entries.values()) if (entry.draft === from) entry.draft = to;
      db.prepare(`UPDATE held_files SET draft = ? WHERE draft = ?`).run(to, from);
    },

    /** A chat was deleted: the files of its composer go, including the ones a send that was stopped still held. */
    discardDraft(draft: string): void {
      for (const entry of [...entries.values()]) if (entry.draft === draft) discard(entry);
      for (const row of db.prepare(`SELECT id, source_id, blob_sha, extracted_sha FROM held_files WHERE draft = ?`).all(draft) as Record[])
        discardRecord(row);
      notify();
    },

    /**
     * At start, removes what the last run left held. Core held the files in memory, so after a quit nothing can send them:
     * each row the table still lists and this run does not hold goes the way a file taken off does, which keeps whatever a
     * stored question or a plan names. Run in the middle of a session, it leaves what this composer holds alone.
     */
    sweep(): number {
      const rows = (db.prepare(`SELECT id, source_id, blob_sha, extracted_sha FROM held_files`).all() as Record[]).filter(
        (row) => !entries.has(row.id),
      );
      for (const row of rows) discardRecord(row);
      return rows.length;
    },
  };
}

export type HeldFiles = ReturnType<typeof createHeldFiles>;

let current: HeldFiles | null = null;

/** The files held by the running core, so the job runner's updates reach them. */
export function setHeldFiles(held: HeldFiles | null): void {
  current = held;
}

export function heldFiles(): HeldFiles | null {
  return current;
}
