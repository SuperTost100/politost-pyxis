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

export function removeSubject(db: Database.Database, id: string): void {
  db.prepare("DELETE FROM subjects WHERE id = ?").run(id);
}
