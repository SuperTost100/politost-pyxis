import type Database from "better-sqlite3";
import { readFileSync, statSync } from "node:fs";
import type { PlanFile } from "../../shared/plan-file";
import { readBlob } from "../blobs";

/**
 * SHR-05 "found in library": embeds the stored original of a library source in place of a missing one.
 * `libraryFor` maps a source index in the file to a library source; the hash must match what the plan
 * expects, and importPlan verifies the bytes again. Call before `importPlan`.
 */
export function withLibraryOriginals(
  db: Database.Database,
  workspace: string | undefined,
  input: PlanFile & { libraryFor?: Record<string, string> },
): PlanFile {
  const { libraryFor, ...file } = input;
  if (!libraryFor || !Object.keys(libraryFor).length) return file;
  if (!workspace) throw new Error("plan-file");
  const sources = file.sources?.map((source, index) => {
    const libraryId = libraryFor[String(index)];
    if (!libraryId || source.data !== undefined) return source;
    const row = db
      .prepare("SELECT blob_sha FROM sources WHERE id = ?")
      .get(libraryId) as { blob_sha: string | null } | undefined;
    if (!source.sha || row?.blob_sha !== source.sha)
      throw new Error("plan-file");
    const path = readBlob(workspace, source.sha).file;
    const size = statSync(path).size;
    if (size > 200 * 1024 * 1024 || (source.bytes != null && size !== source.bytes))
      throw new Error("plan-file");
    return { ...source, data: readFileSync(path).toString("base64") };
  });
  return { ...file, ...(sources ? { sources } : {}) };
}
