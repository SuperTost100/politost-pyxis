import { realpathSync, statSync } from "node:fs";
import { basename, extname, isAbsolute, relative, sep } from "node:path";
import type Database from "better-sqlite3";
import { uuidv7 } from "../../shared/ids";
import { MAX_FOLDER_ENTRIES, maxSourceBytes, isImageExt } from "../../shared/source-types";
import { MAX_SUBJECT_NAME, type LinkMode, type MaterialKind } from "../../shared/linked-folders";
import type { GenerateInput } from "../engine/generate";
import type { Runner } from "../jobs/runner";
import { addSubject } from "../plans/subjects";
import { inside } from "../path-inside";
import { kindFor, mimeFor } from "./documents";
import { listImportable } from "./folder";
import { imageMime } from "./heic";
import { hasUnfinishedJob } from "./jobs";
import { detectSubjects, type FolderCandidate } from "./linked-subjects";
import { watchFolder } from "./linked-watch";

/** Hashes files without holding them: the extract worker in the app, in-process in tests. Null for one it cannot read. */
export type HashFiles = (paths: string[], maxBytes: number, signal?: AbortSignal) => Promise<Array<string | null>>;

export type LinkedDeps = {
  db: Database.Database;
  runner: Runner;
  /** The workspace and the app's own data. A linked folder may not lie inside them, and a walk never enters them. */
  protectedPaths: string[];
  hash: HashFiles;
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
};

/** What a walk left out, so the student is told: the same caps as a folder import. */
export type FolderCut = { files: boolean; depth: boolean; entries: boolean; unreadable: boolean };

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
};

type FolderRow = {
  id: string;
  path: string;
  mode: LinkMode;
  detection: "ai" | "names" | null;
  cut_json: string | null;
  confirmed_at: number | null;
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
};

/** A file found in a linked folder: where it is, and the subfolder that decides its subject. */
type Found = { path: string; rel: string; subfolder: string };

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

/**
 * Reads a folder's importable files with the folder-import caps. The walk never enters `exclude`. In `root` mode a
 * file's subfolder is the first folder of its path; in `subject` mode every file belongs to the folder itself ("").
 */
export function readFolder(
  root: string,
  mode: LinkMode,
  exclude: readonly string[],
): { found: Found[]; cut: FolderCut } {
  const listing = listImportable(root, MAX_FOLDER_ENTRIES, exclude);
  return {
    // A PoliTost book package is a library import, not a file to read in place.
    found: listing.files.filter((path) => extname(path).toLowerCase() !== ".ptsb").map((path) => {
      const rel = relative(root, path);
      const parts = rel.split(sep);
      return { path, rel, subfolder: mode === "root" && parts.length > 1 ? parts[0]! : "" };
    }),
    cut: {
      files: listing.cappedFiles,
      depth: listing.cappedDepth,
      entries: listing.cappedEntries,
      unreadable: listing.unreadable,
    },
  };
}

/**
 * The folders that may be subjects. In `subject` mode the folder itself is one. In `root` mode each first-level
 * subfolder with material is one; files at the top stay without a subject, unless the folder has no subfolders with
 * material, when the folder itself is the one subject. Keys are subfolder names, "" for the folder itself.
 */
export function subjectCandidates(root: string, mode: LinkMode, found: Found[]): Map<string, FolderCandidate> {
  const groups = new Map<string, FolderCandidate>();
  const add = (key: string, folder: string, file: string) => {
    const group = groups.get(key) ?? { folder, files: [] };
    group.files.push(file);
    groups.set(key, group);
  };
  for (const file of found) {
    if (file.subfolder === "") add("", basename(root), file.rel);
    else add(file.subfolder, file.subfolder, relative(file.subfolder, file.rel));
  }
  if (mode === "root" && groups.size > 1) groups.delete("");
  return groups;
}

/** A folder name as a subject name: trimmed and cut to what `subjects` holds, so `addSubject` never refuses it. */
const subjectNameOf = (folder: string) => folder.trim().slice(0, MAX_SUBJECT_NAME).trim();
const isComplete = (cut: FolderCut) => !cut.files && !cut.depth && !cut.entries && !cut.unreadable;
const noCut: FolderCut = { files: false, depth: false, entries: false, unreadable: false };
const mtimeOf = (stat: { mtimeMs: number }) => Math.floor(stat.mtimeMs);

/** Every watch a linked folder has open in this process, by folder, so quitting can close them all. */
const watched = new Map<string, { close(): void }>();

/** Closes every folder watch. Core calls this when it shuts down. */
export function closeLinkedWatches(): void {
  for (const watch of watched.values()) watch.close();
  watched.clear();
}

/**
 * Linked folders: the student's own folders, read in place. Pyxis keeps the extracted text, never a copy of a file, and
 * only reads: nothing here creates, renames, moves or deletes anything inside a linked folder. Each file becomes a
 * source whose import job reads it from its real path. Looking at a folder again (`sync`, at every start and when the
 * watch sees a change) reads new files, reads a changed file again as the next version of its source, follows a file
 * that moved by its size and hash, and marks a file that is gone as missing without touching its text or citations.
 */
export function linkedFolders(deps: LinkedDeps) {
  const { db, runner } = deps;
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
      .prepare(`SELECT id, path, mode, detection, cut_json, confirmed_at FROM linked_folders WHERE id = ?`)
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
    return {
      id: folder.id,
      path: folder.path,
      name: basename(folder.path),
      mode: folder.mode,
      detection: folder.detection ?? "names",
      cut: folder.cut_json ? (JSON.parse(folder.cut_json) as FolderCut) : noCut,
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
    };
  }

  /** Starts reading one new file: its source, its record and its import job, in one transaction. */
  function addFile(folderId: string, file: Found & { size: number; mtime: number }, subjectId: string | null) {
    const ext = extname(file.path).toLowerCase();
    const title = basename(file.path, extname(file.path));
    const image = isImageExt(ext);
    const now = Date.now();
    const sourceId = uuidv7(now);
    db.transaction(() => {
      db.prepare(
        `INSERT INTO sources (id, subject_id, kind, title, blob_sha, mime, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, NULL, ?, 'queued', ?, ?)`,
      ).run(sourceId, subjectId, image ? "image" : kindFor(ext), title, image ? imageMime(ext) : mimeFor(ext), now, now);
      db.prepare(
        `INSERT INTO linked_files (folder_id, rel_path, subfolder, source_id, size, mtime_ms) VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(folderId, file.rel, file.subfolder, sourceId, file.size, file.mtime);
      runner.start("source-import", { sourceId, sha: "", ext, title, version: 1, linked: true });
    })();
  }

  /** Reads a changed file again as the next version of its source. The earlier text stays for its citations. */
  function rereadFile(row: FileRow, size: number, mtime: number, sha: string | null) {
    const sourceId = row.source_id!;
    const ext = extname(row.rel_path).toLowerCase();
    db.transaction(() => {
      const version = (
        db
          .prepare(`SELECT COALESCE(MAX(version), 0) + 1 AS n FROM source_documents WHERE source_id = ?`)
          .get(sourceId) as { n: number }
      ).n;
      const title = (db.prepare(`SELECT title FROM sources WHERE id = ?`).get(sourceId) as { title: string }).title;
      db.prepare(
        `UPDATE linked_files SET size = ?, mtime_ms = ?, content_hash = ?, missing_at = NULL WHERE folder_id = ? AND rel_path = ?`,
      ).run(size, mtime, sha, row.folder_id, row.rel_path);
      // A file whose first reading never finished is read as a first version.
      runner.start("source-import", {
        sourceId,
        sha: "",
        ext,
        title,
        version,
        linked: true,
        ...(version > 1 ? { reextract: true } : {}),
      });
    })();
  }

  async function syncOnce(folderId: string, signal?: AbortSignal): Promise<void> {
    const folder = folderRow(folderId);
    if (!folder) return;
    const now = Date.now();
    let changes = 0;
    const markMissing = db.prepare(
      `UPDATE linked_files SET missing_at = ? WHERE folder_id = ? AND rel_path = ? AND missing_at IS NULL`,
    );
    let listing: ReturnType<typeof readFolder>;
    try {
      if (!statSync(folder.path).isDirectory()) throw new Error("not-a-directory");
      listing = readFolder(folder.path, folder.mode, excludes());
    } catch {
      // The folder itself is gone, renamed or on a drive that is not plugged in: every file in it is missing until
      // it is back. Nothing is removed.
      if (db.prepare(`UPDATE linked_files SET missing_at = ? WHERE folder_id = ? AND missing_at IS NULL`).run(now, folderId).changes)
        deps.onChange?.();
      return;
    }
    // What a look already committed is announced even when a later step fails, so the Library is never left stale.
    try {
      const subfolders = new Map(subfolderRows(folderId).map((row) => [row.name, row]));
      const known = new Map(
        (
          db
            .prepare(
              `SELECT l.*, s.status = 'removed' AS removed FROM linked_files l LEFT JOIN sources s ON s.id = l.source_id
               WHERE l.folder_id = ?`,
            )
            .all(folderId) as Array<FileRow & { removed: number | null }>
        ).map((row) => [row.rel_path, row]),
      );
      const listed = new Set<string>();
      const fresh: Array<Found & { size: number; mtime: number }> = [];
      const changed: Array<{ row: FileRow; size: number; mtime: number; path: string }> = [];
      for (const file of listing.found) {
        let sub = subfolders.get(file.subfolder);
        if (!sub && !(folder.mode === "root" && file.subfolder === "")) {
          // A subfolder added after the folder was linked is a new subject, named as the folder is, once setup is over.
          // The first file in a subject folder that was empty when linked makes the folder itself the subject.
          const name = subjectNameOf(file.subfolder || basename(folder.path));
          const subjectId = folder.confirmed_at && name ? addSubject(db, name).id : null;
          db.prepare(
            `INSERT OR IGNORE INTO linked_subfolders (folder_id, name, subject_id, suggested) VALUES (?, ?, ?, ?)`,
          ).run(folderId, file.subfolder, subjectId, name || null);
          sub = { name: file.subfolder, subject_id: subjectId, suggested: name || null, kinds_json: "[]", skipped: 0 };
          subfolders.set(file.subfolder, sub);
        }
        if (sub?.skipped) continue;
        let stat: ReturnType<typeof statSync>;
        try {
          stat = statSync(file.path);
        } catch {
          continue;
        }
        listed.add(file.rel);
        const row = known.get(file.rel);
        const size = stat.size;
        const mtime = mtimeOf(stat);
        if (!row) fresh.push({ ...file, size, mtime });
        // The student removed this source from the Library: its file is not read again.
        else if (row.source_id === null || row.removed) continue;
        else if (row.size === size && row.mtime_ms === mtime) {
          if (row.missing_at !== null)
            changes += db
              .prepare(`UPDATE linked_files SET missing_at = NULL WHERE folder_id = ? AND rel_path = ?`)
              .run(folderId, file.rel).changes;
        } else changed.push({ row, size, mtime, path: file.path });
      }
      // A cut walk cannot tell a file that is gone from one it did not reach, so it marks nothing missing.
      const vanished = isComplete(listing.cut)
        ? [...known.values()].filter(
            (row) =>
              row.source_id !== null &&
              !listed.has(row.rel_path) &&
              !subfolders.get(row.subfolder)?.skipped,
          )
        : [];
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
      const sizes = new Set(gone.map((row) => row.size));
      const maybeMoved = fresh.filter((file) => sizes.has(file.size));
      if (maybeMoved.length) {
        const hashes = await deps.hash(
          maybeMoved.map((file) => file.path),
          Math.max(...maybeMoved.map((file) => maxSourceBytes(extname(file.path).toLowerCase()))),
          signal,
        );
        maybeMoved.forEach((file, index) => {
          const sha = hashes[index];
          const match = sha ? gone.find((row) => row.size === file.size && row.content_hash === sha) : undefined;
          if (!match) return;
          gone.splice(gone.indexOf(match), 1);
          const subjectId = subfolders.get(file.subfolder)?.subject_id ?? null;
          const moved = db.transaction(() => {
            const { changes } = db
              .prepare(
                `UPDATE linked_files SET folder_id = ?, rel_path = ?, subfolder = ?, mtime_ms = ?, missing_at = NULL
                 WHERE folder_id = ? AND rel_path = ?`,
              )
              .run(folderId, file.rel, file.subfolder, file.mtime, match.folder_id, match.rel_path);
            // Moved into another subject's folder, the source follows it there.
            if (changes && subjectId && (match.folder_id !== folderId || match.subfolder !== file.subfolder))
              db.prepare(`UPDATE sources SET subject_id = ? WHERE id = ?`).run(subjectId, match.source_id);
            return changes > 0;
          })();
          // A look at another folder took that file first: this one is a new file after all.
          if (!moved) return;
          changes += 1;
          fresh.splice(fresh.indexOf(file), 1);
          const vanishedAt = vanished.findIndex((row) => row === match);
          if (vanishedAt >= 0) vanished.splice(vanishedAt, 1);
        });
      }
      for (const row of vanished) changes += markMissing.run(now, folderId, row.rel_path).changes;
      for (const item of changed) {
        signal?.throwIfAborted();
        const [sha] = await deps.hash([item.path], maxSourceBytes(extname(item.path).toLowerCase()), signal);
        // Touched or copied over with the same contents: only the recorded time changes.
        if (sha && item.row.content_hash === sha) {
          db.prepare(
            `UPDATE linked_files SET size = ?, mtime_ms = ?, missing_at = NULL WHERE folder_id = ? AND rel_path = ?`,
          ).run(item.size, item.mtime, folderId, item.row.rel_path);
          if (item.row.missing_at !== null) changes += 1;
          continue;
        }
        // A reading still going (or stopped, waiting for the student) is left alone. The next look reads the file again.
        if (hasUnfinishedJob(db, item.row.source_id!)) continue;
        rereadFile(item.row, item.size, item.mtime, sha ?? null);
      }
      const photosReadable = fresh.some((file) => isImageExt(extname(file.path).toLowerCase()))
        ? await deps.ocrReady()
        : true;
      for (const file of fresh) {
        signal?.throwIfAborted();
        // Without the OCR data a photo would only fail. It is left unrecorded, so a look after the download reads it.
        if (!photosReadable && isImageExt(extname(file.path).toLowerCase())) continue;
        addFile(folderId, file, subfolders.get(file.subfolder)?.subject_id ?? null);
      }
      db.prepare(`UPDATE linked_folders SET synced_at = ?, cut_json = ? WHERE id = ?`).run(
        Date.now(),
        JSON.stringify(listing.cut),
        folderId,
      );
    } finally {
      if (changes) deps.onChange?.();
    }
  }

  // One look at a time per folder. A request during a look runs one more look after it, never several.
  const running = new Map<string, Promise<void>>();
  const again = new Set<string>();
  function sync(folderId: string): Promise<void> {
    const current = running.get(folderId);
    if (current) {
      again.add(folderId);
      return current;
    }
    const next = (async () => {
      try {
        do {
          again.delete(folderId);
          await syncOnce(folderId);
        } while (again.has(folderId));
      } finally {
        running.delete(folderId);
      }
    })();
    running.set(folderId, next);
    return next;
  }

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

  function assignSubject(folderId: string, key: string, subjectId: string): void {
    db.prepare(`UPDATE linked_subfolders SET subject_id = ?, skipped = 0 WHERE folder_id = ? AND name = ?`).run(
      subjectId,
      folderId,
      key,
    );
    db.prepare(
      `UPDATE sources SET subject_id = ?
       WHERE id IN (SELECT source_id FROM linked_files WHERE folder_id = ? AND subfolder = ?)`,
    ).run(subjectId, folderId, key);
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
     * (one model call), the folders are recorded, and reading starts for every subfolder that is not skipped. A folder
     * already linked is returned as it is. `folder-overlap` when a folder lies inside another linked folder or holds one.
     */
    async link(input: { paths: string[]; mode: LinkMode }, signal?: AbortSignal): Promise<LinkedFolderView[]> {
      const paths = [...new Set(input.paths)];
      const existing = db.prepare(`SELECT id, path FROM linked_folders`).all() as Array<{ id: string; path: string }>;
      for (const path of paths) {
        const others = [...existing.map((row) => row.path), ...paths].filter((other) => other !== path);
        if (others.some((other) => inside(other, path) || inside(path, other))) throw new Error("folder-overlap");
      }
      const known = new Map(existing.map((row) => [row.path, row.id]));
      const fresh = paths
        .filter((path) => !known.has(path))
        .map((path) => {
          const { found, cut } = readFolder(path, input.mode, excludes());
          return { path, cut, groups: subjectCandidates(path, input.mode, found) };
        });
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
          ).run(id, folder.path, input.mode, detection.by, JSON.stringify(folder.cut), Date.now());
          for (const key of folder.groups.keys()) {
            const subject = detection.subjects[at++]!;
            db.prepare(
              `INSERT INTO linked_subfolders (folder_id, name, suggested, kinds_json, skipped) VALUES (?, ?, ?, ?, ?)`,
            ).run(id, key, subject.name, JSON.stringify(subject.kinds), subject.study ? 0 : 1);
          }
        }
      })();
      for (const id of ids) {
        await sync(id);
        startWatch(id);
      }
      return paths.map((path) => view(known.get(path) ?? ids[fresh.findIndex((folder) => folder.path === path)]!));
    },
    /**
     * Saves the subjects the student confirmed in setup. Each name creates a subject or reuses the one with that name,
     * and the folder's sources take it. A subfolder marked as a subject after it was skipped is read now. Subfolders
     * left out keep the subject setup offered. Errors: `linked-folder-missing`.
     */
    async confirm(input: {
      folders: Array<{ folderId: string; subjects: Array<{ key: string; name: string; skipped: boolean }> }>;
    }): Promise<{ subjects: Array<{ id: string; name: string }> }> {
      const subjects = new Map<string, string>();
      db.transaction(() => {
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
            const subject = addSubject(db, choice.name);
            subjects.set(subject.id, subject.name);
            assignSubject(folder.folderId, choice.key, subject.id);
          }
          confirmOffered(folder.folderId);
        }
      })();
      for (const folder of input.folders) await sync(folder.folderId);
      return { subjects: [...subjects].map(([id, name]) => ({ id, name })) };
    },
    /**
     * At start: a folder setup left unconfirmed gets the subjects it offered, then every folder is looked at again and
     * watched while Pyxis runs. Runs in the background; a folder that fails is reported and left for the next start.
     */
    async start(): Promise<void> {
      for (const id of folderIds()) {
        if (!db.open) return;
        try {
          if (!folderRow(id)?.confirmed_at) confirmOffered(id);
          await sync(id);
        } catch (err) {
          console.error("pyxis-core: linked folder look failed", err instanceof Error ? err.message : "unknown");
        }
        startWatch(id);
      }
    },
    /** Looks at every folder again, as after the OCR data arrives. */
    async syncAll(): Promise<void> {
      for (const id of folderIds()) await sync(id).catch(() => undefined);
    },
  };

  function startWatch(folderId: string): void {
    const folder = folderRow(folderId);
    if (!folder || !deps.watch || watched.has(folderId)) return;
    let failed = false;
    const handle = deps.watch(
      folder.path,
      () => {
        void sync(folderId).catch((err: unknown) =>
          console.error("pyxis-core: linked folder look failed", err instanceof Error ? err.message : "unknown"),
        );
      },
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
