import { realpathSync, statSync } from "node:fs";
import { basename, extname, isAbsolute, sep } from "node:path";
import type Database from "better-sqlite3";
import { uuidv7 } from "../../shared/ids";
import { IpcError } from "../../shared/ipc";
import { maxSourceBytes, isImageExt } from "../../shared/source-types";
import { MAX_LINKED_DEPTH, MAX_SUBJECT_NAME, type LinkMode, type MaterialKind } from "../../shared/linked-folders";
import type { GenerateInput } from "../engine/generate";
import type { Runner } from "../jobs/runner";
import { addSubject, renameSubject } from "../plans/subjects";
import { inside } from "../path-inside";
import { kindFor, mimeFor } from "./documents";
import { removeSource } from "./manage";
import { walkImportable, type WalkCut, type WalkedFile } from "./folder";
import { imageMime } from "./heic";
import { hasUnfinishedJob } from "./jobs";
import { detectSubjects, MAX_LOOSE_SENT, sortLooseFiles, type FolderCandidate } from "./linked-subjects";
import { WATCH_MAX_PATHS, watchFolder } from "./linked-watch";

/** Hashes files without holding them: the extract worker in the app, in-process in tests. Null for one it cannot read. */
export type HashFiles = (paths: string[], maxBytes: number, signal?: AbortSignal) => Promise<Array<string | null>>;

export type LinkedDeps = {
  db: Database.Database;
  runner: Runner;
  /** The workspace and the app's own data. A linked folder may not lie inside them, and a walk never enters them. */
  protectedPaths: string[];
  hash: HashFiles;
  /** The size of a stored file in bytes, or null when it is not there: a look hashes only new files that size. */
  storedSize: (sha: string) => number | null;
  /** Whether local OCR can read a photo now. A photo found before then is left for a later look. */
  ocrReady: () => Promise<boolean>;
  /** Stands in for the engine in tests. */
  run?: GenerateInput["run"];
  /** Starts a watch on a folder. Tests pass a fake, or nothing to leave folders unwatched. */
  watch?: typeof watchFolder | null;
  /**
   * A look changed what the Library shows without a job: a file went missing or came back, or moved. Jobs announce
   * their own changes.
   */
  onChange?: () => void;
  /** At most this many file readings wait or run at once; the rest of a folder waits as recorded files. */
  queueWindow?: number;
  /** How often recorded files are handed to the job queue while some wait. */
  pumpMs?: number;
  /** A look that lasts longer than this is listed in Attività. */
  listAfterMs?: number;
};

/** What the last look could not read, so the student is told. A linked folder has no cap on files. */
export type FolderCut = WalkCut;

export type LinkedSubjectView = {
  /** The first-level subfolder, or "" for the linked folder itself. */
  key: string;
  /** The folder's name on disk. */
  folder: string;
  /** The subject it maps to, or the name setup offers before the student confirms. */
  name: string;
  kinds: MaterialKind[];
  skipped: boolean;
};

export type LinkedFolderView = {
  id: string;
  path: string;
  name: string;
  mode: LinkMode;
  detection: "ai" | "names";
  cut: FolderCut;
  subjects: LinkedSubjectView[];
  /** The files Pyxis reads there now: present, not removed by the student, read or waiting for their first reading. */
  files: number;
  /** Of those, the ones read: their reading ended with a source Pyxis can use. */
  read: number;
  /** The ones whose reading ended without one (failed, stopped, or waiting for the student), which Attività can retry. */
  failed: number;
  /** When the last look at the folder ended, or null before the first one. */
  checkedAt: number | null;
  /** `missing`: the folder is not on disk. `reading`: a look runs, or some of its files wait or are being read. */
  state: "ready" | "reading" | "missing";
};

/** What unlinking a folder did: its files that left the Library, and the copies imported earlier that stay there. */
export type UnlinkResult = { removed: number; kept: number };

/**
 * Whether a folder found again is the same folder: how many of the files read from it are at the same place under the
 * new path with the same size, out of how many. `same` when more than half are.
 */
export type RelocateResult = { same: boolean; matched: number; total: number };

type FolderRow = {
  id: string;
  path: string;
  mode: LinkMode;
  detection: "ai" | "names" | null;
  cut_json: string | null;
  confirmed_at: number | null;
  synced_at: number | null;
};
type SubfolderRow = {
  name: string;
  subject_id: string | null;
  suggested: string | null;
  kinds_json: string;
  skipped: number;
};
type FileRow = {
  folder_id: string;
  rel_path: string;
  subfolder: string;
  source_id: string | null;
  size: number;
  mtime_ms: number;
  content_hash: string | null;
  missing_at: number | null;
  /** 1: found, waiting for its first reading (no source yet). 2: changed, waiting to be read again. */
  pending: number;
};

/** A file a look found: where it is, the subfolder that decides its subject, and its size and time. */
type Found = { path: string; rel: string; subfolder: string; size: number; mtime: number };

/** File readings waiting or running at once, by default: enough to keep the import slots busy, few enough to list. */
const QUEUE_WINDOW = 48;
const PUMP_MS = 400;
const LIST_AFTER_MS = 1_000;
/** A look's count of files found reaches Attività at most this often. */
const REPORT_MS = 250;
/** Files hashed in one call to the worker, so a look stays cancellable between calls. */
const HASH_BATCH = 32;
/** What a look reads of each subfolder to name the subjects, before the full walk: at most this many file names... */
const PEEK_FILES = 40;
/** ...and this many entries, so linking never waits on a huge subfolder. */
const PEEK_ENTRIES = 5_000;
/** ...and of the folder's own top level, which may hold thousands of loose files. */
const PEEK_TOP_ENTRIES = 20_000;

/**
 * Checks a folder the renderer asks to link, after the folder grant: an absolute path to a directory, outside the
 * workspace and the app's own data. Returns its real path. `folder-missing` or `folder-inside-data` otherwise.
 */
export function checkLinkPath(path: string, protectedPaths: readonly string[]): string {
  if (!isAbsolute(path)) throw new Error("folder-missing");
  let real: string;
  try {
    real = realpathSync.native(path);
    if (!statSync(real).isDirectory()) throw new Error("not-a-directory");
  } catch {
    throw new Error("folder-missing");
  }
  for (const place of protectedPaths) {
    let protectedPath = place;
    try {
      protectedPath = realpathSync.native(place);
    } catch {
      // A place that does not exist yet is compared by its path.
    }
    if (inside(protectedPath, real) || inside(place, path)) throw new Error("folder-inside-data");
  }
  return real;
}

/** The subfolder that decides a file's subject: in `root` mode the first folder of its path, in `subject` mode "". */
export function subfolderOf(mode: LinkMode, rel: string): string {
  const parts = rel.split(sep);
  return mode === "root" && parts.length > 1 ? parts[0]! : "";
}

/** A PoliTost book package is a library import, not a file to read in place. */
const isPackage = (rel: string) => extname(rel).toLowerCase() === ".ptsb";

/** Up to `PEEK_FILES` file names under `within` (all of `root` when ""), relative to it, sorted. */
async function sample(root: string, within: string, exclude: readonly string[], signal?: AbortSignal) {
  const names: string[] = [];
  const stop = new AbortController();
  const both = signal ? AbortSignal.any([signal, stop.signal]) : stop.signal;
  try {
    await walkImportable(root, {
      within: within || undefined,
      exclude,
      maxDepth: MAX_LINKED_DEPTH,
      maxEntries: PEEK_ENTRIES,
      signal: both,
      onFiles: (files) => {
        for (const file of files) {
          if (isPackage(file.rel)) continue;
          names.push(within ? file.rel.slice(within.length + 1) : file.rel);
          if (names.length >= PEEK_FILES) stop.abort();
        }
      },
    });
  } catch (err) {
    if (!stop.signal.aborted || signal?.aborted) throw err;
  }
  return names.slice(0, PEEK_FILES).sort();
}

/**
 * The folders that may be subjects, read before the full walk so setup can name them at once: a sample of file names
 * under each, never the whole tree. In `subject` mode the folder itself is one. In `root` mode each first-level
 * subfolder with material is one; files at the top stay without a subject, unless the folder has no subfolders with
 * material, when the folder itself is the one subject. A subfolder whose material lies past the sample is found by the
 * full walk and named as the folder is. Keys are subfolder names, "" for the folder itself.
 */
export async function peekFolder(
  root: string,
  mode: LinkMode,
  exclude: readonly string[],
  signal?: AbortSignal,
): Promise<Map<string, FolderCandidate>> {
  const groups = new Map<string, FolderCandidate>();
  if (mode === "subject") {
    const files = await sample(root, "", exclude, signal);
    if (files.length) groups.set("", { folder: basename(root), files });
    return groups;
  }
  const loose: string[] = [];
  const subfolders = new Set<string>();
  // The top level only, its files and the subfolders to sample one by one, and only so far: the full walk finds the rest.
  await walkImportable(root, {
    exclude,
    maxDepth: 0,
    maxEntries: PEEK_TOP_ENTRIES,
    signal,
    onFiles: (files) => {
      for (const file of files) if (!isPackage(file.rel)) loose.push(file.rel);
    },
    onFolder: (rel) => subfolders.add(rel),
  });
  for (const name of [...subfolders].sort()) {
    const files = await sample(root, name, exclude, signal);
    if (files.length) groups.set(name, { folder: name, files });
  }
  if (!groups.size && loose.length) groups.set("", { folder: basename(root), files: loose.sort().slice(0, PEEK_FILES) });
  return groups;
}

/**
 * A Library copy a linked file with the same bytes can take over (`adopt`), as a condition on `sources`. A source that
 * is being replaced with another file is not one: its `blob_sha` names the old file until the replacement is published,
 * so the bytes it names are not the text it is about to hold. The import job of a replacement says so (`replace`), where
 * the first import of a copy does not, and that one is taken over as it is read.
 */
const ADOPTABLE = `library = 1 AND blob_sha IS NOT NULL AND origin_url IS NULL AND kind != 'smartbook'
  AND status NOT IN ('removed', 'failed', 'cancelled', 'interrupted')
  AND NOT EXISTS (
    SELECT 1 FROM jobs j WHERE j.state IN ('queued', 'running', 'interrupted')
      AND j.kind IN ('source-import', 'source-import-vision')
      AND json_extract(j.params_json, '$.sourceId') = sources.id AND json_extract(j.params_json, '$.replace') = 1)`;

/** A folder name as a subject name: trimmed and cut to what `subjects` holds, so `addSubject` never refuses it. */
const subjectNameOf = (folder: string) => folder.trim().slice(0, MAX_SUBJECT_NAME).trim();
const isComplete = (cut: FolderCut) => !cut.depth && !cut.unreadable;
const noCut: FolderCut = { depth: false, unreadable: false };
const mtimeOf = (stat: { mtimeMs: number }) => Math.floor(stat.mtimeMs);

/**
 * The places a burst of changes touched, relative to the folder, as a look reads them: a place inside another one is
 * left to it. Null for the whole folder, when one of them is the folder itself or there are too many.
 */
function scopesOf(paths: Iterable<string>): string[] | null {
  const places = [...new Set([...paths].map((path) => path.split(sep).filter(Boolean).join(sep)))].sort();
  if (places.includes("") || places.length > WATCH_MAX_PATHS) return null;
  const kept = new Set<string>();
  for (const place of places) {
    const parts = place.split(sep);
    if (parts.some((_, index) => index > 0 && kept.has(parts.slice(0, index).join(sep)))) continue;
    kept.add(place);
  }
  return [...kept];
}

/** Every watch a linked folder has open in this process, by folder, so quitting can close them all. */
const watched = new Map<string, { close(): void }>();
/** Every queue of recorded files that is handing them over, so quitting can stop them all. */
const pumps = new Set<() => void>();

/** Closes every folder watch and stops handing recorded files to the job queue. Core calls this when it shuts down. */
export function closeLinkedWatches(): void {
  for (const watch of watched.values()) watch.close();
  watched.clear();
  for (const stop of [...pumps]) stop();
}

/**
 * Linked folders: the student's own folders, read in place. Pyxis keeps the extracted text, never a copy of a file, and
 * only reads: nothing here creates, renames, moves or deletes anything inside a linked folder. A folder is read in full,
 * with no cap on files. A look (`sync`, at every start, after linking and when the watch sees a change) walks the
 * folder in the background, a batch at a time, and records each new file; recorded files are then read a window at a
 * time (`pump`), so a folder of tens of thousands of files never floods the job queue, and a restart carries on with
 * the files still waiting. A look reads a changed file again as the next version of its source, follows a file that
 * moved by its size and hash, and marks a file that is gone as missing without touching its text or citations. A
 * watch's look reads only the places that changed.
 */
export function linkedFolders(deps: LinkedDeps) {
  const { db, runner } = deps;
  const queueWindow = deps.queueWindow ?? QUEUE_WINDOW;
  // The jobs list counts, on a folder's readings, the files not queued yet.
  const waitingFiles = db.prepare(
    `SELECT folder_id, COUNT(*) AS n FROM linked_files WHERE pending > 0 AND missing_at IS NULL GROUP BY folder_id`,
  );
  runner.waitingIn(
    () =>
      new Map(
        (waitingFiles.all() as Array<{ folder_id: string; n: number }>).map((row) => [`folder:${row.folder_id}`, row.n]),
      ),
  );
  runner.register("linked-folder-sort", {
    jobClass: "model-cli",
    title: (params) => {
      const folder = folderRow((params as { folderId: string }).folderId);
      return folder ? basename(folder.path) : null;
    },
    steps: [
      {
        name: "sort",
        label: "sources.jobs.sortSubjects",
        async run(ctx) {
          const { folderId } = ctx.params as { folderId: string };
          // Riprova asks again, whatever failed before.
          sortGaveUp.delete(folderId);
          await sortLoose(folderId, { strict: true, signal: ctx.signal });
          return {};
        },
      },
    ],
  });
  const excludes = () =>
    deps.protectedPaths.map((place) => {
      try {
        return realpathSync.native(place);
      } catch {
        return place;
      }
    });
  const folderRow = (id: string) =>
    db
      .prepare(`SELECT id, path, mode, detection, cut_json, confirmed_at, synced_at FROM linked_folders WHERE id = ?`)
      .get(id) as FolderRow | undefined;
  const subfolderRows = (id: string) =>
    db
      .prepare(
        `SELECT name, subject_id, suggested, kinds_json, skipped FROM linked_subfolders WHERE folder_id = ?`,
      )
      .all(id) as SubfolderRow[];

  function view(id: string): LinkedFolderView {
    const folder = folderRow(id);
    if (!folder) throw new Error("linked-folder-missing");
    const subjectName = db.prepare(`SELECT name FROM subjects WHERE id = ?`).pluck();
    // A cut saved before linked folders were read in full also named the file and entry caps: only these two remain.
    const cut = folder.cut_json ? (JSON.parse(folder.cut_json) as Partial<FolderCut>) : noCut;
    const counts = db
      .prepare(
        `SELECT COUNT(*) AS files, COALESCE(SUM(l.pending > 0), 0) AS waiting FROM linked_files l
         LEFT JOIN sources s ON s.id = l.source_id
         WHERE l.folder_id = ? AND l.missing_at IS NULL AND (l.pending = 1 OR (s.id IS NOT NULL AND s.status != 'removed'))`,
      )
      .get(id) as { files: number; waiting: number };
    // Readings that wait or run for the folder's files. Few jobs are ever queued or running, so this starts from them.
    const busy = db
      .prepare(
        `SELECT COUNT(DISTINCT f.rel_path) FROM jobs j
         JOIN linked_files f ON f.source_id = json_extract(j.params_json, '$.sourceId')
         WHERE j.state IN ('queued', 'running')
           AND j.kind IN ('source-import', 'source-import-vision', 'source-ocr', 'source-index')
           AND f.folder_id = ? AND f.pending = 0 AND f.missing_at IS NULL`,
      )
      .pluck()
      .get(id) as number;
    // Readings that ended without a usable source and are not being tried again: the states the Library marks as a problem.
    const failed = db
      .prepare(
        `SELECT COUNT(*) FROM linked_files l JOIN sources s ON s.id = l.source_id
         WHERE l.folder_id = ? AND l.pending = 0 AND l.missing_at IS NULL
           AND s.status IN ('failed', 'needs-ocr', 'interrupted', 'cancelled')
           AND NOT EXISTS (
             SELECT 1 FROM jobs j WHERE j.state IN ('queued', 'running')
               AND j.kind IN ('source-import', 'source-import-vision', 'source-ocr', 'source-index')
               AND json_extract(j.params_json, '$.sourceId') = s.id)`,
      )
      .pluck()
      .get(id) as number;
    let present = false;
    try {
      present = statSync(folder.path).isDirectory();
    } catch {
      // Unplugged, renamed or deleted: the list says so.
    }
    const unread = Math.min(counts.files, counts.waiting + busy);
    return {
      id: folder.id,
      path: folder.path,
      name: basename(folder.path),
      mode: folder.mode,
      detection: folder.detection ?? "names",
      cut: { depth: cut.depth === true, unreadable: cut.unreadable === true },
      subjects: subfolderRows(id)
        .map((row) => ({
          key: row.name,
          folder: row.name || basename(folder.path),
          name:
            (row.subject_id ? (subjectName.get(row.subject_id) as string | undefined) : undefined) ??
            row.suggested ??
            (row.name || basename(folder.path)),
          kinds: JSON.parse(row.kinds_json) as MaterialKind[],
          skipped: row.skipped === 1,
        }))
        .sort((a, b) => Number(a.skipped) - Number(b.skipped) || a.folder.localeCompare(b.folder)),
      files: counts.files,
      read: Math.max(0, counts.files - unread - failed),
      failed,
      checkedAt: folder.synced_at,
      state: !present ? "missing" : running.has(id) || unread > 0 ? "reading" : "ready",
    };
  }

  /** Starts the first reading of a recorded file: its source, and its import job, with the row in one transaction. */
  function readNew(row: FileRow, subjectId: string | null): void {
    const ext = extname(row.rel_path).toLowerCase();
    const title = basename(row.rel_path, extname(row.rel_path));
    const image = isImageExt(ext);
    const now = Date.now();
    const sourceId = uuidv7(now);
    db.prepare(
      `INSERT INTO sources (id, subject_id, kind, title, blob_sha, mime, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, ?, 'queued', ?, ?)`,
    ).run(sourceId, subjectId, image ? "image" : kindFor(ext), title, image ? imageMime(ext) : mimeFor(ext), now, now);
    db.prepare(`UPDATE linked_files SET source_id = ?, pending = 0 WHERE folder_id = ? AND rel_path = ?`).run(
      sourceId,
      row.folder_id,
      row.rel_path,
    );
    runner.start("source-import", { sourceId, sha: "", ext, title, version: 1, linked: true, folderId: row.folder_id });
  }

  /**
   * Reads a changed file again as the next version of its source. The earlier text stays for its citations. A reading
   * still going (or stopped, waiting for the student) is left alone, and so is a file gone since the look: the row keeps
   * the size and time it had, so the next look finds the change again.
   */
  function readAgain(row: FileRow, root: string): void {
    const sourceId = row.source_id!;
    let stat: ReturnType<typeof statSync>;
    try {
      if (hasUnfinishedJob(db, sourceId)) throw new Error("source-busy");
      stat = statSync(`${root}${sep}${row.rel_path}`);
    } catch {
      db.prepare(`UPDATE linked_files SET pending = 0 WHERE folder_id = ? AND rel_path = ?`).run(row.folder_id, row.rel_path);
      return;
    }
    const ext = extname(row.rel_path).toLowerCase();
    const version = (
      db
        .prepare(`SELECT COALESCE(MAX(version), 0) + 1 AS n FROM source_documents WHERE source_id = ?`)
        .get(sourceId) as { n: number }
    ).n;
    const title = (db.prepare(`SELECT title FROM sources WHERE id = ?`).get(sourceId) as { title: string }).title;
    // The reading takes the hash as it goes, and keeps it on the row.
    db.prepare(
      `UPDATE linked_files SET size = ?, mtime_ms = ?, content_hash = NULL, missing_at = NULL, pending = 0
       WHERE folder_id = ? AND rel_path = ?`,
    ).run(stat.size, mtimeOf(stat), row.folder_id, row.rel_path);
    // A file whose first reading never finished is read as a first version.
    runner.start("source-import", {
      sourceId,
      sha: "",
      ext,
      title,
      version,
      linked: true,
      folderId: row.folder_id,
      ...(version > 1 ? { reextract: true } : {}),
    });
  }

  /**
   * Library copies a new linked file may turn out to be: a file the student imported, still usable, that is not a link's
   * page and that no linked file reads yet. A copy kept out of the Library by a chat or a plan file goes with that chat
   * or plan, so it is never one. Newest first, as the import's own duplicate check finds them.
   */
  function importedCopies(): Array<{ id: string; sha: string; size: number }> {
    const rows = db
      .prepare(
        `SELECT id, blob_sha AS sha FROM sources
         WHERE ${ADOPTABLE} AND NOT EXISTS (SELECT 1 FROM linked_files l WHERE l.source_id = sources.id)
         ORDER BY created_at DESC, rowid DESC`,
      )
      .all() as Array<{ id: string; sha: string }>;
    return rows.flatMap((row) => {
      const size = deps.storedSize(row.sha);
      return size === null ? [] : [{ ...row, size }];
    });
  }

  /**
   * Makes a Library copy the source of a new linked file with the same bytes, so the material shows once and keeps the
   * citations, lessons, maps and cards that point at it. The copy's text is that file's text already, so nothing is read
   * again; from now on a look follows the file as it follows any linked file. The copy keeps its stored original until
   * the file changes, and its own subject; one without a subject takes the subfolder's. False when the file or the copy
   * changed hands since the look listed them.
   */
  function adopt(folderId: string, file: Found, sourceId: string, sha: string): boolean {
    return db.transaction(() => {
      const still = db
        .prepare(
          `SELECT 1 FROM sources WHERE id = ? AND blob_sha = ? AND ${ADOPTABLE}
           AND NOT EXISTS (SELECT 1 FROM linked_files l WHERE l.source_id = sources.id)`,
        )
        .get(sourceId, sha);
      if (!still) return false;
      const { changes } = db
        .prepare(
          `UPDATE linked_files SET source_id = ?, content_hash = ?, pending = 0
           WHERE folder_id = ? AND rel_path = ? AND pending = 1 AND source_id IS NULL`,
        )
        .run(sourceId, sha, folderId, file.rel);
      if (!changes) return false;
      // Read now, not at the start of the look: setup may have been confirmed while the look walked.
      const subjectId = db
        .prepare(`SELECT subject_id FROM linked_subfolders WHERE folder_id = ? AND name = ?`)
        .pluck()
        .get(folderId, file.subfolder) as string | null | undefined;
      if (subjectId)
        db.prepare(`UPDATE sources SET subject_id = ? WHERE id = ? AND subject_id IS NULL`).run(subjectId, sourceId);
      return true;
    })();
  }

  /** Folders a look is walking. Their recorded files wait, since one may turn out to be a file that moved. */
  const walking = new Set<string>();
  let pumpTimer: ReturnType<typeof setInterval> | undefined;
  const stopPump = () => {
    clearInterval(pumpTimer);
    pumpTimer = undefined;
    pumps.delete(stopPump);
  };

  /**
   * Hands recorded files to the job queue until `queueWindow` readings wait or run, oldest first, and says whether any
   * file still waits. A file in a subfolder the student skipped since it was recorded is dropped instead.
   */
  function pump(): boolean {
    const busy = db
      .prepare(`SELECT COUNT(*) FROM jobs WHERE state IN ('queued', 'running') AND kind = 'source-import'`)
      .pluck()
      .get() as number;
    let room = queueWindow - busy;
    // A folder whose readings the student stopped waits until they are resumed or cleared, so stopping them does not
    // just make room for its next files. The folder is found from the reading's source, which also covers readings
    // queued before they recorded their folder. The unary plus keeps SQLite on the state index, which holds only the
    // few stopped jobs; the kind index would read every import of a large folder at every tick.
    const stopped = new Set(
      db
        .prepare(
          `SELECT DISTINCT l.folder_id FROM jobs j
           JOIN linked_files l ON l.source_id = json_extract(j.params_json, '$.sourceId')
           WHERE j.state = 'cancelled' AND +j.kind = 'source-import' AND j.dismissed = 0`,
        )
        .pluck()
        .all() as string[],
    );
    const recorded = db
      .prepare(`SELECT DISTINCT folder_id FROM linked_files WHERE pending > 0 AND missing_at IS NULL`)
      .pluck()
      .all() as string[];
    // A stopped folder still counts as waiting, so the pump keeps going and finds it again once it is resumed.
    if (!recorded.length) return false;
    const waiting = recorded.filter((folderId) => !stopped.has(folderId));
    const rows = db.prepare(
      `SELECT l.*, s.subject_id, s.skipped FROM linked_files l
       LEFT JOIN linked_subfolders s ON s.folder_id = l.folder_id AND s.name = l.subfolder
       WHERE l.folder_id = ? AND l.pending > 0 AND l.missing_at IS NULL ORDER BY l.rowid LIMIT ?`,
    );
    for (const folderId of waiting) {
      if (room <= 0) break;
      if (walking.has(folderId)) continue;
      const folder = folderRow(folderId);
      if (!folder) continue;
      db.transaction(() => {
        for (const row of rows.all(folderId, room) as Array<FileRow & { subject_id: string | null; skipped: number | null }>) {
          if (row.skipped) {
            if (row.pending === 1)
              db.prepare(`DELETE FROM linked_files WHERE folder_id = ? AND rel_path = ?`).run(folderId, row.rel_path);
            else db.prepare(`UPDATE linked_files SET pending = 0 WHERE folder_id = ? AND rel_path = ?`).run(folderId, row.rel_path);
            continue;
          }
          if (row.pending === 1) readNew(row, row.subject_id);
          // The source was deleted while its change waited: the row stays, with no source, so it is not read again.
          else if (row.source_id === null)
            db.prepare(`UPDATE linked_files SET pending = 0 WHERE folder_id = ? AND rel_path = ?`).run(folderId, row.rel_path);
          else readAgain(row, folder.path);
          room -= 1;
        }
      })();
    }
    return true;
  }

  /** Keeps handing recorded files over while any wait. A look and a start call it; it stops once none is left. */
  function schedulePump(): void {
    if (pumpTimer || !db.open) return;
    const tick = () => {
      if (!db.open) return stopPump();
      try {
        if (!pump() && !walking.size) stopPump();
      } catch (err) {
        console.error("pyxis-core: linked files could not be queued", err instanceof Error ? err.message : "unknown");
      }
    };
    pumpTimer = setInterval(tick, deps.pumpMs ?? PUMP_MS);
    pumpTimer.unref?.();
    pumps.add(stopPump);
    tick();
  }

  /** Lists a look in Attività once it has lasted `listAfterMs`, with the count of files found so far. */
  function listing(folder: FolderRow) {
    const startedAt = Date.now();
    const known = db.prepare(`SELECT COUNT(*) FROM linked_files WHERE folder_id = ?`).pluck().get(folder.id) as number;
    let entry: ReturnType<Runner["track"]> | undefined;
    let shownAt = 0;
    return {
      found(count: number, done = false) {
        const now = Date.now();
        if (!entry && now - startedAt >= (deps.listAfterMs ?? LIST_AFTER_MS))
          entry = runner.track("linked-folder-read", {}, "sources.folderReading", {
            title: basename(folder.path),
            keep: false,
          });
        if (!entry || (!done && now - shownAt < REPORT_MS)) return;
        shownAt = now;
        entry.count(count);
        // The files recorded at the last look are the best guess of how many there are.
        if (known) entry.progress(Math.min(0.95, count / known));
      },
      finish(succeeded: boolean) {
        entry?.finish(succeeded);
      },
    };
  }

  /**
   * One look at a folder: the whole folder (`scope` null), or only the places a watch saw change, each a subfolder or a
   * file relative to the folder.
   */
  async function look(folderId: string, scope: string[] | null): Promise<void> {
    const stop = new AbortController();
    stops.set(folderId, stop);
    try {
      await lookOnce(folderId, scope, stop.signal);
    } catch (err) {
      // Unlinked while it walked: it ends quietly, having written nothing since.
      if (!stop.signal.aborted) throw err;
    } finally {
      if (stops.get(folderId) === stop) stops.delete(folderId);
    }
  }

  async function lookOnce(folderId: string, scope: string[] | null, signal: AbortSignal): Promise<void> {
    const folder = folderRow(folderId);
    if (!folder) return;
    const now = Date.now();
    let changes = 0;
    const markMissing = db.prepare(
      `UPDATE linked_files SET missing_at = ? WHERE folder_id = ? AND rel_path = ? AND missing_at IS NULL`,
    );
    try {
      if (!statSync(folder.path).isDirectory()) throw new Error("not-a-directory");
    } catch {
      // The folder itself is gone, renamed or on a drive that is not plugged in: every file in it is missing until
      // it is back. Nothing is removed.
      if (db.prepare(`UPDATE linked_files SET missing_at = ? WHERE folder_id = ? AND missing_at IS NULL`).run(now, folderId).changes)
        deps.onChange?.();
      return;
    }
    const subfolders = new Map(subfolderRows(folderId).map((row) => [row.name, row]));
    const rowOf = db.prepare(
      `SELECT l.*, s.status = 'removed' AS removed FROM linked_files l LEFT JOIN sources s ON s.id = l.source_id
       WHERE l.folder_id = ? AND l.rel_path = ?`,
    );
    const record = db.prepare(
      `INSERT INTO linked_files (folder_id, rel_path, subfolder, source_id, size, mtime_ms, pending) VALUES (?, ?, ?, NULL, ?, ?, 1)`,
    );
    const restat = db.prepare(`UPDATE linked_files SET size = ?, mtime_ms = ? WHERE folder_id = ? AND rel_path = ?`);
    const back = db.prepare(`UPDATE linked_files SET missing_at = NULL WHERE folder_id = ? AND rel_path = ?`);
    const listed = new Set<string>();
    const fresh: Found[] = [];
    const changed: Array<{ row: FileRow; size: number; mtime: number; path: string }> = [];
    let photosReadable: boolean | undefined;
    const shown = listing(folder);

    /** Compares one file with its row, and records it if it is new. Runs inside a batch's transaction. */
    const see = (file: WalkedFile) => {
      if (isPackage(file.rel)) return;
      const subfolder = subfolderOf(folder.mode, file.rel);
      let sub = subfolders.get(subfolder);
      if (!sub && !(folder.mode === "root" && subfolder === "")) {
        // A subfolder added after the folder was linked is a new subject, named as the folder is, once setup is over.
        // The first file in a subject folder that was empty when linked makes the folder itself the subject.
        // Read now, not at the start of the look: setup may have been confirmed while the look walked.
        const name = subjectNameOf(subfolder || basename(folder.path));
        const subjectId = folderRow(folderId)?.confirmed_at && name ? addSubject(db, name).id : null;
        db.prepare(
          `INSERT OR IGNORE INTO linked_subfolders (folder_id, name, subject_id, suggested) VALUES (?, ?, ?, ?)`,
        ).run(folderId, subfolder, subjectId, name || null);
        sub = { name: subfolder, subject_id: subjectId, suggested: name || null, kinds_json: "[]", skipped: 0 };
        subfolders.set(subfolder, sub);
      }
      if (sub?.skipped) return;
      const row = rowOf.get(folderId, file.rel) as (FileRow & { removed: number | null }) | undefined;
      // Without the OCR data a new photo would only fail. It is left unrecorded, so a look after the download reads it.
      if (!row && !photosReadable && isImageExt(extname(file.rel))) return;
      listed.add(file.rel);
      const size = file.size;
      const mtime = mtimeOf(file);
      if (!row) {
        record.run(folderId, file.rel, subfolder, size, mtime);
        fresh.push({ path: file.path, rel: file.rel, subfolder, size, mtime });
      } else if (row.pending === 1) {
        // Not read yet: its reading will see the file as it is then.
        if (row.size !== size || row.mtime_ms !== mtime) restat.run(size, mtime, folderId, file.rel);
      }
      // The student removed this source from the Library: its file is not read again.
      else if (row.source_id === null || row.removed) return;
      else if (row.size === size && row.mtime_ms === mtime) {
        if (row.missing_at !== null) changes += back.run(folderId, file.rel).changes;
      } else if (row.pending !== 2) changed.push({ row, size, mtime, path: file.path });
    };

    walking.add(folderId);
    let finished = false;
    let cut: WalkCut = { ...noCut };
    // What a look already committed is announced even when a later step fails, so the Library is never left stale.
    try {
      const onFiles = async (files: WalkedFile[]) => {
        if (photosReadable === undefined && files.some((file) => isImageExt(extname(file.rel))))
          photosReadable = await deps.ocrReady();
        signal.throwIfAborted();
        db.transaction(() => files.forEach(see))();
        shown.found(listed.size);
      };
      const walk = (within?: string) =>
        walkImportable(folder.path, { within, exclude: excludes(), maxDepth: MAX_LINKED_DEPTH, onFiles, signal });
      if (scope === null) cut = await walk();
      else
        for (const place of scope) {
          const part = await walk(place);
          cut = { depth: cut.depth || part.depth, unreadable: cut.unreadable || part.unreadable };
        }
      shown.found(listed.size, true);
      signal.throwIfAborted();

      // The rows the look covered: the whole folder, or what lies at or under each place it read.
      const columns = `folder_id, rel_path, subfolder, source_id, size, mtime_ms, content_hash, missing_at, pending`;
      const covered: FileRow[] =
        scope === null
          ? (db.prepare(`SELECT ${columns} FROM linked_files WHERE folder_id = ?`).all(folderId) as FileRow[])
          : scope.flatMap(
              (place) =>
                db
                  .prepare(
                    `SELECT ${columns} FROM linked_files
                     WHERE folder_id = ? AND (rel_path = ? OR (rel_path >= ? AND rel_path < ?))`,
                  )
                  // The separator's next character bounds every path under the place, in SQLite's byte order.
                  .all(folderId, place, place + sep, place + String.fromCharCode(sep.charCodeAt(0) + 1)) as FileRow[],
            );
      const unlisted = covered.filter((row) => !listed.has(row.rel_path) && !subfolders.get(row.subfolder)?.skipped);
      // A cut walk cannot tell a file that is gone from one it did not reach, so it marks nothing missing.
      const complete = isComplete(cut);
      const vanished = complete ? unlisted.filter((row) => row.source_id !== null) : [];
      // A file recorded but never read that is gone again leaves nothing behind.
      if (complete)
        db.transaction(() => {
          for (const row of unlisted)
            if (row.pending === 1)
              db.prepare(`DELETE FROM linked_files WHERE folder_id = ? AND rel_path = ? AND pending = 1`).run(
                folderId,
                row.rel_path,
              );
        })();
      // A file that moved shows up as a new file with the size and contents of one that is gone. Only new files with a
      // matching size are hashed, so a folder full of new files is not read twice.
      const gone = [
        ...new Map(
          [
            ...vanished,
            ...(db
              .prepare(
                `SELECT * FROM linked_files WHERE missing_at IS NOT NULL AND source_id IS NOT NULL AND content_hash IS NOT NULL`,
              )
              .all() as FileRow[]),
          ]
            .filter((row) => row.content_hash)
            .map((row) => [`${row.folder_id}\0${row.rel_path}`, row]),
        ).values(),
      ];
      // A new file may also hold the same bytes as a file the student imported into the Library before. That copy
      // becomes the linked file instead of a second source (`adopt`), so new files of a copy's size are hashed too.
      const copies = fresh.length ? importedCopies() : [];
      const sizes = new Set([...gone.map((row) => row.size), ...copies.map((copy) => copy.size)]);
      const taken = new Error("moved-already");
      const maybeMoved = fresh.filter((file) => sizes.has(file.size));
      for (let at = 0; at < maybeMoved.length && (gone.length || copies.length); at += HASH_BATCH) {
        const batch = maybeMoved.slice(at, at + HASH_BATCH);
        const hashes = await deps.hash(
          batch.map((file) => file.path),
          Math.max(...batch.map((file) => maxSourceBytes(extname(file.path).toLowerCase()))),
          signal,
        );
        signal.throwIfAborted();
        batch.forEach((file, index) => {
          const sha = hashes[index];
          const match = sha ? gone.find((row) => row.size === file.size && row.content_hash === sha) : undefined;
          if (!match) {
            const copy = sha ? copies.find((item) => item.size === file.size && item.sha === sha) : undefined;
            if (copy && adopt(folderId, file, copy.id, sha!)) {
              copies.splice(copies.indexOf(copy), 1);
              changes += 1;
            }
            return;
          }
          gone.splice(gone.indexOf(match), 1);
          const subjectId = subfolders.get(file.subfolder)?.subject_id ?? null;
          const moved = db.transaction(() => {
            // The new file's own record makes way for the row that moved there.
            db.prepare(`DELETE FROM linked_files WHERE folder_id = ? AND rel_path = ? AND pending = 1`).run(folderId, file.rel);
            const { changes } = db
              .prepare(
                `UPDATE linked_files SET folder_id = ?, rel_path = ?, subfolder = ?, mtime_ms = ?, missing_at = NULL
                 WHERE folder_id = ? AND rel_path = ?`,
              )
              .run(folderId, file.rel, file.subfolder, file.mtime, match.folder_id, match.rel_path);
            // A look at another folder took that file first: this one is a new file after all, and keeps its record.
            if (!changes) throw taken;
            // Moved into another subject's folder, the source follows it there, unless the student chose its subject.
            if (subjectId && (match.folder_id !== folderId || match.subfolder !== file.subfolder))
              db.prepare(`UPDATE sources SET subject_id = ? WHERE id = ? AND subject_sort IS NOT 'manual'`).run(
                subjectId,
                match.source_id,
              );
          });
          try {
            moved();
          } catch (err) {
            if (err !== taken) throw err;
            return;
          }
          changes += 1;
          const vanishedAt = vanished.findIndex((row) => row === match);
          if (vanishedAt >= 0) vanished.splice(vanishedAt, 1);
        });
      }
      for (const row of vanished) changes += markMissing.run(now, folderId, row.rel_path).changes;
      // The new files of this folder can go to the queue now; the changed ones below are hashed first.
      walking.delete(folderId);
      schedulePump();
      for (let at = 0; at < changed.length; at += HASH_BATCH) {
        const batch = changed.slice(at, at + HASH_BATCH);
        const hashes = await deps.hash(
          batch.map((item) => item.path),
          Math.max(...batch.map((item) => maxSourceBytes(extname(item.path).toLowerCase()))),
          signal,
        );
        signal.throwIfAborted();
        db.transaction(() => {
          batch.forEach((item, index) => {
            const sha = hashes[index];
            // Touched or copied over with the same contents: only the recorded time changes.
            if (sha && item.row.content_hash === sha) {
              db.prepare(
                `UPDATE linked_files SET size = ?, mtime_ms = ?, missing_at = NULL WHERE folder_id = ? AND rel_path = ?`,
              ).run(item.size, item.mtime, folderId, item.row.rel_path);
              if (item.row.missing_at !== null) changes += 1;
              return;
            }
            db.prepare(`UPDATE linked_files SET pending = 2, missing_at = NULL WHERE folder_id = ? AND rel_path = ?`).run(
              folderId,
              item.row.rel_path,
            );
            if (item.row.missing_at !== null) changes += 1;
          });
        })();
      }
      // A look at the whole folder says what it could not read; a look at a few places leaves that as it was.
      if (scope === null)
        db.prepare(`UPDATE linked_folders SET synced_at = ?, cut_json = ? WHERE id = ?`).run(
          Date.now(),
          JSON.stringify(cut),
          folderId,
        );
      else db.prepare(`UPDATE linked_folders SET synced_at = ? WHERE id = ?`).run(Date.now(), folderId);
      finished = true;
    } finally {
      walking.delete(folderId);
      shown.finish(finished);
      if (changes) deps.onChange?.();
      schedulePump();
    }
    // Loose files at the top of the folder are sorted into subjects once they are recorded. A look at a few places
    // asks only when it found a loose file.
    if (scope === null || fresh.some((file) => file.subfolder === "")) await sortLoose(folderId, { signal });
  }

  /**
   * Folders whose loose files the AI tool failed to sort since this start: they are not asked again until the next
   * start, or until the student presses Riprova on the failed `linked-folder-sort` job in Attività.
   */
  const sortGaveUp = new Set<string>();

  /**
   * Asks the AI tool which subject each file lying loose at the top of a `root` folder belongs to, by its name alone,
   * `MAX_LOOSE_SENT` names a call. A file it sorts takes that subfolder, so it follows that subject from then on, as if
   * it lay inside it; one it cannot place stays without a subject and is not asked about again. Without an AI tool the
   * files stay without a subject, and the next look asks again; with `strict` the job fails as `engine-missing`, so it
   * is not listed as done. When the call fails, the files stay without a subject
   * and a `linked-folder-sort` job asks once more, so a failure that lasts ends as a failed job in Attività; with
   * `strict` (that job) the failure is thrown as `linked-sort-failed` instead. The job's `signal` is passed to the call,
   * so a stop aborts the call in flight, starts no other and saves nothing more: the files not placed yet stay without
   * a subject, and the job's Riprendi asks about those only. The first sort, which follows a look at the folder, runs under no job, so Ferma does not reach it.
   */
  async function sortLoose(folderId: string, options: { strict?: boolean; signal?: AbortSignal } = {}): Promise<void> {
    const { strict = false, signal } = options;
    const folder = folderRow(folderId);
    if (!folder || folder.mode !== "root" || sortGaveUp.has(folderId)) return;
    const rows = subfolderRows(folderId);
    // The folder itself is the subject: its loose files already have it.
    if (rows.some((row) => row.name === "")) return;
    const subjectName = db.prepare(`SELECT name FROM subjects WHERE id = ?`).pluck();
    const subjects = rows
      .filter((row) => !row.skipped)
      .map((row) => ({
        folder: row.name,
        name: (row.subject_id ? (subjectName.get(row.subject_id) as string | undefined) : undefined) ?? row.suggested ?? row.name,
      }));
    if (!subjects.length) return;
    const loose = db
      .prepare(
        `SELECT rel_path FROM linked_files WHERE folder_id = ? AND subfolder = '' AND sorted_at IS NULL
         AND (pending = 1 OR source_id IS NOT NULL) ORDER BY rel_path`,
      )
      .pluck()
      .all(folderId) as string[];
    let sorted = 0;
    try {
      for (let at = 0; at < loose.length; at += MAX_LOOSE_SENT) {
        const batch = loose.slice(at, at + MAX_LOOSE_SENT);
        signal?.throwIfAborted();
        const answer = await sortLooseFiles(db, subjects, batch, { signal, run: deps.run });
        // A stop that came as the call answered is a stop: nothing of this answer is saved.
        signal?.throwIfAborted();
        if (answer === "no-engine") {
          // The job's Riprova ran without an AI tool: Attività says so and offers to connect one, as for any other job.
          if (strict) throw new IpcError("engine-missing", "engines.errors.engine-missing");
          return;
        }
        if (answer === "failed") {
          sortGaveUp.add(folderId);
          if (strict) throw new Error("linked-sort-failed");
          runner.start("linked-folder-sort", { folderId });
          return;
        }
        if (!db.open) return;
        db.transaction(() => {
          const now = Date.now();
          // A file the answer left out is one no subject fits: it is not asked about again either.
          for (const rel of batch) {
            const key = answer.get(rel) ?? null;
            const placed = db
              .prepare(
                `UPDATE linked_files SET subfolder = ?, sorted_at = ? WHERE folder_id = ? AND rel_path = ? AND subfolder = ''
                 RETURNING source_id`,
              )
              .pluck()
              .get(key ?? "", now, folderId, rel) as string | null | undefined;
            const subjectId = key === null ? null : subfolderRows(folderId).find((row) => row.name === key)?.subject_id;
            if (placed && subjectId)
              sorted += db
                .prepare(`UPDATE sources SET subject_id = ? WHERE id = ? AND subject_id IS NULL`)
                .run(subjectId, placed).changes;
          }
        })();
      }
    } finally {
      if (sorted) deps.onChange?.();
    }
  }

  // One look at a time per folder. Requests during a look are gathered into one more look after it, never several:
  // the places they name together, or the whole folder when one of them asks for it.
  const running = new Map<string, Promise<void>>();
  const queued = new Map<string, Set<string> | null>();
  /** The look running at each folder, so unlinking the folder can stop it. */
  const stops = new Map<string, AbortController>();
  function sync(folderId: string, paths: readonly string[] | null = null): Promise<void> {
    // Nothing to read. A look that ended without waiting would delete its entry before it was set.
    if (paths?.length === 0) return running.get(folderId) ?? Promise.resolve();
    const before = queued.get(folderId);
    queued.set(
      folderId,
      paths === null || before === null ? null : new Set([...(before ?? []), ...paths]),
    );
    const current = running.get(folderId);
    if (current) return current;
    const next = (async () => {
      try {
        while (queued.has(folderId)) {
          const wanted = queued.get(folderId)!;
          queued.delete(folderId);
          const scope = wanted === null ? null : scopesOf(wanted);
          if (scope?.length !== 0) await look(folderId, scope);
        }
      } finally {
        running.delete(folderId);
      }
    })();
    running.set(folderId, next);
    return next;
  }
  /** A look started in the background: a failure is logged, and the next look tries again. */
  const syncInBackground = (folderId: string, paths: readonly string[] | null = null) =>
    void sync(folderId, paths).catch((err: unknown) =>
      console.error("pyxis-core: linked folder look failed", err instanceof Error ? err.message : "unknown"),
    );

  const folderIds = () => (db.prepare(`SELECT id FROM linked_folders ORDER BY created_at`).pluck().all() as string[]);

  /** Gives each subfolder of a folder setup did not finish the subject setup offered, so its files are not left out. */
  function confirmOffered(folderId: string): void {
    db.transaction(() => {
      for (const row of subfolderRows(folderId)) {
        if (row.skipped || row.subject_id) continue;
        const folder = folderRow(folderId)!;
        // A name made only of spaces names no subject: the folder's files stay without one rather than fail the start.
        const name = subjectNameOf(row.suggested || row.name || basename(folder.path));
        if (name) assignSubject(folderId, row.name, addSubject(db, name).id);
      }
      db.prepare(`UPDATE linked_folders SET confirmed_at = ? WHERE id = ?`).run(Date.now(), folderId);
    })();
  }

  /**
   * The subject a confirmed name stands for. A subfolder that already has a subject of its own, as on setup again, keeps
   * it under the new name, so the exams and plans that hang on its id stay with it. Otherwise the name makes a subject
   * or reuses the one with that name: when another subject has the name already, or the subject was shared by several
   * subfolders before this confirmation (`shared`, read once, so the order of the choices does not matter).
   */
  function subjectFor(current: string | null, name: string, shared: ReadonlySet<string>): { id: string; name: string } {
    const clean = name.trim();
    const own =
      current !== null &&
      !shared.has(current) &&
      !db.prepare(`SELECT 1 FROM subjects WHERE name = ? COLLATE NOCASE AND id <> ?`).get(clean, current);
    if (!own) return addSubject(db, clean);
    const stored = db.prepare(`SELECT name FROM subjects WHERE id = ?`).pluck().get(current) as string | undefined;
    if (stored === undefined) return addSubject(db, clean);
    return stored === clean ? { id: current, name: stored } : renameSubject(db, current, clean);
  }

  function assignSubject(folderId: string, key: string, subjectId: string): void {
    const previous =
      (db.prepare(`SELECT subject_id FROM linked_subfolders WHERE folder_id = ? AND name = ?`).pluck().get(folderId, key) as
        | string
        | null
        | undefined) ?? null;
    db.prepare(`UPDATE linked_subfolders SET subject_id = ?, skipped = 0 WHERE folder_id = ? AND name = ?`).run(
      subjectId,
      folderId,
      key,
    );
    // A Library copy that a file here took over (it still has its stored original) keeps a subject of its own. Without a
    // subject, or with the one the subfolder had before, it takes the new one, since that subject came from the folder.
    // A subject the student chose in the Library (`manual`) is never changed, whatever the file is.
    // shortcut: a copy whose own subject, from before it was taken over, is the same as its folder's cannot be told apart
    // from one that inherited it, and follows the folder too; telling them apart takes a column recording where the
    // subject came from.
    db.prepare(
      `UPDATE sources SET subject_id = ?
       WHERE id IN (SELECT source_id FROM linked_files WHERE folder_id = ? AND subfolder = ?)
         AND subject_sort IS NOT 'manual'
         AND (blob_sha IS NULL OR subject_id IS NULL OR subject_id IS ?)`,
    ).run(subjectId, folderId, key, previous);
  }

  return {
    view,
    sync,
    /** Every linked folder as setup shows it. */
    list(): LinkedFolderView[] {
      return folderIds().map(view);
    },
    /**
     * Links folders the student picked, already checked by `checkLinkPath`. The subjects are named once for all of them
     * (one model call per 60 folders) from a sample of each folder, the folders are recorded, and a look reads each in
     * full in the background, for every subfolder that is not skipped. A folder already linked is returned as it is.
     * `folder-overlap` when a folder lies inside another linked folder or holds one.
     */
    async link(input: { paths: string[]; mode: LinkMode }, signal?: AbortSignal): Promise<LinkedFolderView[]> {
      const paths = [...new Set(input.paths)];
      const existing = db.prepare(`SELECT id, path FROM linked_folders`).all() as Array<{ id: string; path: string }>;
      for (const path of paths) {
        const others = [...existing.map((row) => row.path), ...paths].filter((other) => other !== path);
        if (others.some((other) => inside(other, path) || inside(path, other))) throw new Error("folder-overlap");
      }
      const known = new Map(existing.map((row) => [row.path, row.id]));
      const fresh: Array<{ path: string; groups: Map<string, FolderCandidate> }> = [];
      for (const path of paths.filter((path) => !known.has(path)))
        fresh.push({ path, groups: await peekFolder(path, input.mode, excludes(), signal) });
      const candidates = fresh.flatMap((folder) => [...folder.groups.values()]);
      const detection = await detectSubjects(db, candidates, { mode: input.mode, signal, run: deps.run });
      signal?.throwIfAborted();
      const ids: string[] = [];
      let at = 0;
      db.transaction(() => {
        for (const folder of fresh) {
          const id = uuidv7();
          ids.push(id);
          db.prepare(
            `INSERT INTO linked_folders (id, path, mode, detection, cut_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
          ).run(id, folder.path, input.mode, detection.by, JSON.stringify(noCut), Date.now());
          for (const key of folder.groups.keys()) {
            const subject = detection.subjects[at++]!;
            db.prepare(
              `INSERT INTO linked_subfolders (folder_id, name, suggested, kinds_json, skipped) VALUES (?, ?, ?, ?, ?)`,
            ).run(id, key, subject.name, JSON.stringify(subject.kinds), subject.study ? 0 : 1);
          }
        }
      })();
      // The folders are read in the background, so setup shows the subjects at once; Attività shows a long read.
      for (const id of ids) {
        startWatch(id);
        syncInBackground(id);
      }
      return paths.map((path) => view(known.get(path) ?? ids[fresh.findIndex((folder) => folder.path === path)]!));
    },
    /**
     * Saves the subjects the student confirmed in setup. Each name creates a subject or reuses the one with that name,
     * and the folder's sources take it; on setup again a subfolder's own subject is renamed instead (`subjectFor`). A subfolder marked as a subject after it was skipped is read now. Subfolders
     * left out keep the subject setup offered. Errors: `linked-folder-missing`.
     */
    async confirm(input: {
      folders: Array<{ folderId: string; subjects: Array<{ key: string; name: string; skipped: boolean }> }>;
    }): Promise<{ subjects: Array<{ id: string; name: string }> }> {
      // The subfolders skipped before this confirmation: one the student marks as a subject is read after it.
      const skippedBefore = (folderId: string) =>
        new Set(subfolderRows(folderId).filter((row) => row.skipped).map((row) => row.name));
      const before = new Map(input.folders.map((folder) => [folder.folderId, skippedBefore(folder.folderId)]));
      const subjects = new Map<string, string>();
      db.transaction(() => {
        const shared = new Set(
          db
            .prepare(
              `SELECT subject_id FROM linked_subfolders WHERE subject_id IS NOT NULL GROUP BY subject_id HAVING COUNT(*) > 1`,
            )
            .pluck()
            .all() as string[],
        );
        for (const folder of input.folders) {
          if (!folderRow(folder.folderId)) throw new Error("linked-folder-missing");
          const rows = new Map(subfolderRows(folder.folderId).map((row) => [row.name, row]));
          for (const choice of folder.subjects) {
            if (!rows.has(choice.key)) continue;
            if (choice.skipped) {
              db.prepare(
                `UPDATE linked_subfolders SET skipped = 1, subject_id = NULL WHERE folder_id = ? AND name = ?`,
              ).run(folder.folderId, choice.key);
              continue;
            }
            const subject = subjectFor(rows.get(choice.key)!.subject_id, choice.name, shared);
            subjects.set(subject.id, subject.name);
            assignSubject(folder.folderId, choice.key, subject.id);
          }
          confirmOffered(folder.folderId);
        }
      })();
      for (const [folderId, skipped] of before) {
        const now = skippedBefore(folderId);
        const read = [...skipped].filter((key) => !now.has(key));
        // A subject folder's key is "" for the folder itself, which is the whole folder.
        if (read.length) syncInBackground(folderId, read.includes("") ? null : read);
      }
      return { subjects: [...subjects].map(([id, name]) => ({ id, name })) };
    },
    /**
     * At start: a folder setup left unconfirmed gets the subjects it offered, then every folder is watched while Pyxis
     * runs and looked at again. Files recorded before a restart go on to the queue at once, so reading carries on where
     * it stopped. Runs in the background; a folder that fails is reported and left for the next start.
     */
    async start(): Promise<void> {
      // A file recorded before the restart may have moved or gone since: each folder's files wait for its first look.
      const ids = folderIds();
      for (const id of ids) walking.add(id);
      schedulePump();
      // Each folder is looked at on its own, so a long walk in one does not hold back the files of the others.
      await Promise.all(
        ids.map(async (id) => {
          if (!db.open) return;
          try {
            if (!folderRow(id)?.confirmed_at) confirmOffered(id);
          } catch (err) {
            console.error("pyxis-core: linked folder setup failed", err instanceof Error ? err.message : "unknown");
          }
          // Watched before the look, so a change made while it walks is read after it.
          startWatch(id);
          try {
            await sync(id);
          } catch (err) {
            console.error("pyxis-core: linked folder look failed", err instanceof Error ? err.message : "unknown");
          } finally {
            walking.delete(id);
          }
        }),
      );
    },
    /** Looks at every folder again, as after the OCR data arrives. */
    async syncAll(): Promise<void> {
      for (const id of folderIds()) await sync(id).catch(() => undefined);
    },
    /**
     * Reads one folder again now, as the watch would after a change, and watches it again if its watch had stopped.
     * The look runs in the background; the list and Attività show it. Errors: `linked-folder-missing`.
     */
    reread(folderId: string): void {
      if (!folderRow(folderId)) throw new Error("linked-folder-missing");
      startWatch(folderId);
      syncInBackground(folderId);
    },
    /**
     * Unlinks a folder, in one transaction: Pyxis stops reading it and its files leave the Library, as a source the
     * student removes does (`removeSource`): each is marked removed and leaves every exam's material, search and
     * retrieval, and its passages stay so the flashcards, maps, lessons and answers that cite them keep their text. A
     * Library copy the folder took over (`adopt`) whose stored original is still its current file stays in the Library
     * as a file the student added. The folder's subfolder and file rows go, so linking it again reads it as new; its
     * subjects stay, even empty, for the student to keep or delete. After the commit the look at the folder stops, its
     * watch closes, and every reading of its files is dropped from Attività, so nothing offers to resume it. Nothing on
     * disk is touched. Errors: `linked-folder-missing`.
     */
    unlink(folderId: string): UnlinkResult {
      const result = db.transaction(() => {
        if (!folderRow(folderId)) throw new Error("linked-folder-missing");
        const rows = db
          .prepare(
            `SELECT s.id, s.blob_sha AS sha FROM linked_files l JOIN sources s ON s.id = l.source_id
             WHERE l.folder_id = ? AND s.status != 'removed'`,
          )
          .all(folderId) as Array<{ id: string; sha: string | null }>;
        const removed: string[] = [];
        const kept: string[] = [];
        for (const row of rows) {
          // The copy still reads from its own stored file: it was the student's before the folder took it over.
          if (row.sha && deps.storedSize(row.sha) !== null) kept.push(row.id);
          else {
            removeSource(db, row.id, true);
            removed.push(row.id);
          }
        }
        db.prepare(`DELETE FROM linked_folders WHERE id = ?`).run(folderId);
        return { removed, kept };
      })();
      queued.delete(folderId);
      stops.get(folderId)?.abort();
      walking.delete(folderId);
      sortGaveUp.delete(folderId);
      watched.get(folderId)?.close();
      watched.delete(folderId);
      // Every reading of a file that left, and the folder's own readings of a copy that stays (a change it saw), which
      // would read a file Pyxis no longer reads. The copy's other work, such as its index, goes on.
      const jobs = db
        .prepare(
          `SELECT id FROM jobs WHERE kind IN ('source-import', 'source-import-vision', 'source-index', 'source-ocr')
           AND json_extract(params_json, '$.sourceId') = ? AND (? OR json_extract(params_json, '$.linked') = 1)
           AND state IN ('queued', 'running', 'interrupted', 'cancelled', 'failed') AND dismissed = 0`,
        )
        .pluck();
      for (const sourceId of result.removed) for (const id of jobs.all(sourceId, 1) as string[]) runner.discard(id);
      for (const sourceId of result.kept) for (const id of jobs.all(sourceId, 0) as string[]) runner.discard(id);
      for (const id of db
        .prepare(
          `SELECT id FROM jobs WHERE kind = 'linked-folder-sort' AND json_extract(params_json, '$.folderId') = ?
           AND state IN ('queued', 'running', 'interrupted', 'cancelled', 'failed') AND dismissed = 0`,
        )
        .pluck()
        .all(folderId) as string[])
        runner.discard(id);
      deps.onChange?.();
      return { removed: result.removed.length, kept: result.kept.length };
    },
    /**
     * Points a folder that is no longer where it was at the place the student found it, already checked by
     * `checkLinkPath`, when it is the same folder: more than half of the files read from it are at the same place under
     * the new path with the same size (names and sizes are what Pyxis keeps of every file; a hash is kept only for some,
     * and checking it would read every file). A file counts only when the folder's own walk would read it there: a
     * regular file reached through real folders, not a link, so a folder whose matching files are links is not the
     * same one. The folder then keeps its id, subjects and sources, and a look finds its files again. Otherwise nothing
     * changes, and the result says how many matched. A folder with no files read yet has nothing to compare and is
     * always the same. Errors: `linked-folder-missing`, `folder-overlap`.
     */
    async relocate(folderId: string, path: string): Promise<RelocateResult> {
      const folder = folderRow(folderId);
      if (!folder) throw new Error("linked-folder-missing");
      const others = (db.prepare(`SELECT path FROM linked_folders WHERE id != ?`).pluck().all(folderId) as string[]);
      if (others.some((other) => inside(other, path) || inside(path, other))) throw new Error("folder-overlap");
      const files = db
        .prepare(`SELECT rel_path AS rel, size FROM linked_files WHERE folder_id = ? AND source_id IS NOT NULL`)
        .all(folderId) as Array<{ rel: string; size: number }>;
      let matched = 0;
      for (const file of files) {
        // The walk's own rule, asked about this one place: it checks every folder on the way and the file with `lstat`.
        let there: WalkedFile | undefined;
        try {
          await walkImportable(path, {
            within: file.rel,
            exclude: excludes(),
            maxDepth: MAX_LINKED_DEPTH,
            onFiles: (found) => {
              there = found[0];
            },
          });
        } catch {
          // Not there: it does not count.
        }
        if (there?.size === file.size) matched += 1;
      }
      // The folder was unlinked or pointed elsewhere while the files were checked.
      if (folderRow(folderId)?.path !== folder.path) throw new Error("linked-folder-missing");
      const same = matched * 2 > files.length || files.length === 0;
      if (!same) return { same, matched, total: files.length };
      if (path !== folder.path) {
        queued.delete(folderId);
        stops.get(folderId)?.abort();
        watched.get(folderId)?.close();
        watched.delete(folderId);
        db.prepare(`UPDATE linked_folders SET path = ? WHERE id = ?`).run(path, folderId);
      }
      startWatch(folderId);
      syncInBackground(folderId);
      return { same, matched, total: files.length };
    },
    /** Waits until no look is running. Tests use it before they wait for the queue to empty. */
    async idle(): Promise<void> {
      while (running.size) await Promise.allSettled([...running.values()]);
    },
  };

  function startWatch(folderId: string): void {
    const folder = folderRow(folderId);
    if (!folder || !deps.watch || watched.has(folderId)) return;
    let failed = false;
    const handle = deps.watch(
      folder.path,
      (paths) => syncInBackground(folderId, paths),
      {
        exclude: excludes(),
        // The watch is closed already. The next start watches the folder again.
        onError: () => {
          failed = true;
          watched.delete(folderId);
        },
      },
    );
    if (!failed) watched.set(folderId, handle);
  }
}
