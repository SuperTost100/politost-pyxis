import type Database from "better-sqlite3";
import { extractPlain, storeExtracted, type StoredSource } from "./documents";

/** Astra's floor: about one page. Shorter pastes are refused. */
export const PASTE_MIN = 1500;

export function importPastedText(
  db: Database.Database,
  workspace: string,
  title: string,
  text: string,
): StoredSource {
  const body = text.replace(/\r\n/g, "\n").trim();
  if (body.length < PASTE_MIN) throw new Error("paste-short");
  const name = title.trim() || "Pasted notes";
  return storeExtracted(db, workspace, {
    title: name,
    kind: "text",
    mime: "text/plain",
    ext: "txt",
    bytes: new TextEncoder().encode(body),
    extracted: extractPlain(body, false),
  });
}
