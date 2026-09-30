import type Database from "better-sqlite3";
import { extname } from "node:path";
import { IpcError } from "../../shared/ipc";
import { importDocumentFile } from "./documents";
import { requestOcr } from "./ocr";
import {
  chapterPassages,
  importSmartbookFile,
  listSources,
  passagesAround,
  searchPassages,
  smartbookChapters,
  smartbookMeta,
  sourcePassages,
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
    meta(input: { sourceId: string }) {
      return smartbookMeta(db, input.sourceId);
    },
    ocr(input: { sourceId: string }) {
      requestOcr(db, input.sourceId);
      return { status: "ocr-queued" as const };
    },
    passage(input: { passageId: string }) {
      return passagesAround(db, input.passageId);
    },
    chapter(input: { sourceId: string; chapter: number; paragraph?: string }) {
      const rows =
        smartbookChapters(db, input.sourceId).length === 0
          ? sourcePassages(db, input.sourceId)
          : chapterPassages(db, input.sourceId, input.chapter);
      return rows.map((row) => ({
        ...row,
        current: input.paragraph
          ? row.locator.paragraph === input.paragraph
          : false,
      }));
    },
  };
}
