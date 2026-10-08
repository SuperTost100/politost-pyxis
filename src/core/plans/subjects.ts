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
    db.prepare("UPDATE chats SET subject = ? WHERE subject = ?").run(clean, current.name);
    return { id, name: clean };
  })();
}

export function removeSubject(db: Database.Database, id: string): void {
  db.prepare("DELETE FROM subjects WHERE id = ?").run(id);
}
