import Database from "better-sqlite3";
import { getLoadablePath } from "sqlite-vec";
import { migrate } from "./migrate";

export function openDatabase(file: string): Database.Database {
  const db = new Database(file);
  try {
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
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
