import Database from "better-sqlite3";
import { getLoadablePath } from "sqlite-vec";
import { migrate } from "./migrate";

export function openDatabase(file: string): Database.Database {
  const db = new Database(file);
  try {
    db.pragma("journal_mode = WAL");
    // With WAL, NORMAL can lose the last transactions on a power cut but never corrupts the file.
    db.pragma("synchronous = NORMAL");
    db.pragma("foreign_keys = ON");
    // A 32 MB page cache (negative means KiB) and up to 256 MB read through memory mapping.
    db.pragma("cache_size = -32000");
    db.pragma("mmap_size = 268435456");
    const vecPath = getLoadablePath().replaceAll(
      "app.asar",
      "app.asar.unpacked",
    );
    db.loadExtension(vecPath);
    migrate(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

/** Moves every WAL page into the database file and closes it, so `pyxis.db` alone is complete for copying. */
export function closeDatabase(db: Database.Database): void {
  if (!db.open) return;
  try {
    db.pragma("wal_checkpoint(TRUNCATE)");
  } finally {
    db.close();
  }
}
