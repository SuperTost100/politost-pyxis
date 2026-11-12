import type Database from "better-sqlite3";
import { uuidv7 } from "../../shared/ids";
import { IpcError } from "../../shared/ipc";

export function addSubject(db: Database.Database, name: string): { id: string; name: string } {
  const clean = name.trim();
  if (!clean || clean.length > 120) throw new IpcError("invalid", "errors.invalidSubject");
  const existing = db.prepare("SELECT id, name FROM subjects WHERE name = ? COLLATE NOCASE").get(clean) as { id: string; name: string } | undefined;
  if (existing) return existing;
  const id = uuidv7();
  db.prepare("INSERT INTO subjects (id, name, position, created_at) VALUES (?, ?, (SELECT COALESCE(MAX(position), -1) + 1 FROM subjects), ?)").run(id, clean, Date.now());
  return { id, name: clean };
}

export function reorderSubjects(db: Database.Database, ids: string[]): void {
  db.transaction(() => {
    const rows = db.prepare("SELECT id FROM subjects").all() as Array<{ id: string }>;
    if (ids.length !== rows.length || new Set(ids).size !== ids.length || rows.some((row) => !ids.includes(row.id))) {
      throw new IpcError("invalid", "errors.invalidSubject");
    }
    const update = db.prepare("UPDATE subjects SET position = ? WHERE id = ?");
    ids.forEach((id, position) => update.run(position, id));
  })();
}

/** Renames in place: plans follow through their subject id, chats keep the name as text, so those are updated too. */
export function renameSubject(db: Database.Database, id: string, name: string): { id: string; name: string } {
  const clean = name.trim();
  if (!clean || clean.length > 120) throw new IpcError("invalid", "errors.invalidSubject");
  return db.transaction(() => {
    const current = db.prepare("SELECT name FROM subjects WHERE id = ?").get(id) as { name: string } | undefined;
    if (!current) throw new IpcError("invalid", "errors.invalidSubject");
    const clash = db.prepare("SELECT id FROM subjects WHERE name = ? COLLATE NOCASE AND id <> ?").get(clean, id);
    if (clash) throw new IpcError("invalid", "errors.subjectExists");
    db.prepare("UPDATE subjects SET name = ? WHERE id = ?").run(clean, id);
    // A chat names its subject as text, in whatever case it was stored; the Library's own names are unique without case.
    db.prepare("UPDATE chats SET subject = ? WHERE subject = ? COLLATE NOCASE").run(clean, current.name);
    // A subject Pyxis made for files added to the Library says so on their rows until the student names it.
    db.prepare("UPDATE sources SET subject_sort = 'sorted' WHERE subject_id = ? AND subject_sort = 'created'").run(id);
    return { id, name: clean };
  })();
}

/**
 * Whether anything still has the subject, as a condition on `subjects s`: an exam, a file in the Library (a removed one,
 * or a copy only a chat or a plan file keeps, is not there and does not count), a map, a flashcard (a removed one too,
 * since it can be restored) or a chat filed under its name. `listSubjects` reports it as `inUse`, and only a subject
 * without it can be deleted from the Library.
 */
export const SUBJECT_IN_USE = `(EXISTS (SELECT 1 FROM plans p WHERE p.subject_id = s.id)
  OR EXISTS (SELECT 1 FROM sources src WHERE src.subject_id = s.id AND src.library = 1 AND src.status != 'removed')
  OR EXISTS (SELECT 1 FROM maps m WHERE m.subject_id = s.id)
  OR EXISTS (SELECT 1 FROM cards cd WHERE cd.subject_id = s.id)
  OR EXISTS (SELECT 1 FROM chats c WHERE c.subject = s.name COLLATE NOCASE))`;

/**
 * A whole subject's maps go with it; an exam's maps stay with the exam and lose only the subject. A linked folder that
 * named the subject keeps its subfolder without one (the foreign key clears it), so a later look neither makes the
 * subject again nor gives the subfolder's new files another: they wait in "Da sistemare". With `onlyEmpty`, as the
 * Library asks, a subject that anything still has is refused (`sources.shelf.subjectNotEmpty`) and nothing changes.
 */
export function removeSubject(db: Database.Database, id: string, options: { onlyEmpty?: boolean } = {}): void {
  db.transaction(() => {
    if (options.onlyEmpty) {
      const row = db.prepare(`SELECT ${SUBJECT_IN_USE} AS used FROM subjects s WHERE s.id = ?`).get(id) as
        | { used: number }
        | undefined;
      if (!row) throw new IpcError("invalid", "errors.invalidSubject");
      if (row.used) throw new IpcError("invalid", "sources.shelf.subjectNotEmpty");
    }
    const name = (db.prepare("SELECT name FROM subjects WHERE id = ?").get(id) as { name: string } | undefined)?.name;
    db.prepare("DELETE FROM maps WHERE subject_id = ? AND plan_id IS NULL").run(id);
    db.prepare("DELETE FROM subjects WHERE id = ?").run(id);
    // Its chats are left without a subject, which they read as the whole Library (see `readScope` in chat/turn.ts).
    if (name) db.prepare("UPDATE chats SET subject = NULL WHERE subject = ? COLLATE NOCASE").run(name);
  })();
}
