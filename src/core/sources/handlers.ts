import type Database from "better-sqlite3";
import { extname } from "node:path";
import { IpcError } from "../../shared/ipc";
import { importDocumentFile } from "./documents";
import {
  chapterPassages,
  importSmartbookFile,
  listSources,
  searchPassages,
  smartbookChapters,
} from "./smartbook";

export function sourceHandlers(db: Database.Database, workspace: string) {
  return {
    list() {
      return listSources(db);
    },
    async importFile(input: { path: string }) {
      try {
        const ext = extname(input.path).toLowerCase();
        if (ext === ".ptsb") return importSmartbookFile(db, workspace, input.path);
        return await importDocumentFile(db, workspace, input.path);
      } catch (err) {
        const message = err instanceof Error ? err.message : "";
        if (message === "encrypted-smartbook" || message === "licensed-smartbook") {
          throw new IpcError("unsupported", "sources.encrypted");
        }
        throw new IpcError("invalid-output", "sources.importFailed", {}, message);
      }
    },
    search(input: { query: string }) {
      return searchPassages(db, input.query);
    },
    chapters(input: { sourceId: string }) {
      return smartbookChapters(db, input.sourceId);
    },
    chapter(input: { sourceId: string; chapter: number; paragraph?: string }) {
      return chapterPassages(db, input.sourceId, input.chapter).map((row) => ({
        ...row,
        current: input.paragraph
          ? row.locator.paragraph === input.paragraph
          : false,
      }));
    },
  };
}
