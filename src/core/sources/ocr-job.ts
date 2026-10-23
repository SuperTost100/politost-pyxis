import type Database from "better-sqlite3";
import type { Runner } from "../jobs/runner";
import { hasBlob, readBlob } from "../blobs";
import { sourceTitle } from "./jobs";
import {
  applyOcrPage,
  canStartOcr,
  currentOcrRun,
  finishOcr,
  hasOcrPage,
  ownsOcrRun,
  requestOcr,
  stopOcr,
  type OcrPage,
} from "./ocr";

/** Pages drawn and read per worker run. Each run loads the PDF and the languages once, and the bar moves after each. */
export const OCR_BATCH = 8;

export type ScanDeps = {
  /** Draws and reads `pages` of the PDF at `path`; pages past the end are skipped, and the page count comes back. */
  readPages: (
    path: string,
    pages: number[],
    signal: AbortSignal,
  ) => Promise<{ count: number; pages: OcrPage[] }>;
  /** Refuses with `ocr-data-*` while the language files are missing or damaged. */
  requireData: () => Promise<void>;
  /** A scan that found text, so its passages can be indexed. */
  onReady: (sourceId: string) => void;
};

type ScanParams = { sourceId: string; autoResumedAt?: string };

const ACTIVE = ["queued", "running", "interrupted"];

/**
 * The job that reads a scanned PDF with local OCR, in core. It belongs to no window, so closing or reloading one does not
 * stop it, and a quit leaves it interrupted with its pages kept: at the next start it carries on from the first page
 * without text. A cancel or a failure puts the scan back to `needs-ocr`, also with its pages kept.
 */
export function registerOcrJob(
  db: Database.Database,
  workspace: string,
  runner: Runner,
  deps: ScanDeps,
): void {
  runner.register("source-ocr", {
    jobClass: "local",
    title: (params) => sourceTitle(db, params),
    // A scan stopped before its step ran, while it waited for a slot, or dismissed while paused must not keep showing
    // as reading. Another run the student started for the same source keeps it.
    onCancelled: (params) => {
      const { sourceId } = params as ScanParams;
      if (!activeScanJob(db, sourceId)) stopOcr(db, sourceId);
    },
    steps: [
      {
        name: "read",
        label: "sources.jobs.ocr",
        async run(ctx) {
          const params = ctx.params as ScanParams;
          const { sourceId } = params;
          const row = db
            .prepare(`SELECT status, kind, blob_sha FROM sources WHERE id = ?`)
            .get(sourceId) as { status: string; kind: string; blob_sha: string | null } | undefined;
          if (!row) throw new Error("source-missing");
          if (row.status !== "ocr-queued") {
            // Read already, or removed meanwhile: nothing is left to do.
            if (!canStartOcr(db, sourceId, row.status)) return { status: row.status };
            requestOcr(db, sourceId);
          }
          const mine = currentOcrRun(db, sourceId)!;
          try {
            if (row.kind !== "pdf") throw new Error("ocr-not-scan");
            if (!row.blob_sha || !hasBlob(workspace, row.blob_sha)) throw new Error("source-file-missing");
            await deps.requireData();
            const file = readBlob(workspace, row.blob_sha).file;
            let count: number | null = null;
            let next = 1;
            let progressed = false;
            while (count === null || next <= count) {
              const pages: number[] = [];
              // Pages that have text, from the import or an earlier run, are not read again.
              for (let page = next; pages.length < OCR_BATCH && (count === null || page <= count); page += 1)
                if (!hasOcrPage(db, sourceId, mine, page)) pages.push(page);
              if (count !== null && pages.length === 0) break;
              const batch = await deps.readPages(file, pages, ctx.signal);
              ctx.signal.throwIfAborted();
              count = batch.count;
              // A new file or a new run took the source over while this batch was read: its pages are not ours to store.
              if (!ownsOcrRun(db, sourceId, mine)) throw new Error("ocr-stale");
              let stored = 0;
              for (const page of batch.pages) if (applyOcrPage(db, sourceId, page)) stored += 1;
              next = (pages.at(-1) ?? next) + 1;
              ctx.progress(count > 0 ? Math.min(1, (next - 1) / count) : 1);
              // A run that stores text is making headway, so a later quit may resume it again by itself. Blank pages are
              // read again on every run, so they are not headway.
              if (!progressed && stored > 0 && params.autoResumedAt) {
                ctx.setParams({ ...params, autoResumedAt: undefined });
                progressed = true;
              }
            }
            const status = finishOcr(db, sourceId);
            if (status === "ready") deps.onReady(sourceId);
            return { status };
          } catch (err) {
            // A stale run belongs to the run that replaced it. Anything else stops this one, and the pages read stay.
            if (!(err instanceof Error && err.message === "ocr-stale") && ownsOcrRun(db, sourceId, mine))
              stopOcr(db, sourceId);
            throw err;
          }
        },
      },
    ],
  });
}

/** The scan job for this source that is still going or waiting to resume, if any. */
export function activeScanJob(db: Database.Database, sourceId: string): { id: string; state: string } | undefined {
  return db
    .prepare(
      `SELECT id, state FROM jobs WHERE kind = 'source-ocr' AND state IN (${ACTIVE.map(() => "?").join(", ")})
       AND json_extract(params_json, '$.sourceId') = ? ORDER BY created_at DESC LIMIT 1`,
    )
    .get(...ACTIVE, sourceId) as { id: string; state: string } | undefined;
}

/**
 * Starts reading a scan, or joins the run already going: an interrupted one resumes. Refuses what is not a scan waiting
 * for text. The source turns `ocr-queued` now, so the list shows it reading before the job's first page.
 */
export function startScan(db: Database.Database, runner: Runner, sourceId: string): string {
  const running = activeScanJob(db, sourceId);
  if (running) {
    if (running.state === "interrupted") runner.resume(running.id);
    return running.id;
  }
  const row = db.prepare(`SELECT status FROM sources WHERE id = ?`).get(sourceId) as { status: string } | undefined;
  if (!row) throw new Error("source-missing");
  if (row.status !== "ocr-queued") requestOcr(db, sourceId);
  return runner.start("source-ocr", { sourceId });
}

/**
 * At startup: a scan left `ocr-queued` without a job, such as one an older version read in its window, goes back to
 * `needs-ocr` so it can be started again. One whose job was interrupted keeps waiting for that job.
 */
export function stopOrphanScans(db: Database.Database): void {
  const queued = db.prepare(`SELECT id FROM sources WHERE status = 'ocr-queued'`).all() as Array<{ id: string }>;
  for (const { id } of queued) if (!activeScanJob(db, id)) stopOcr(db, id);
}

/** Scans waiting for text whose file is still here, oldest first. Started for the student once the OCR data is ready. */
export function waitingScans(db: Database.Database): string[] {
  return (
    db
      .prepare(
        `SELECT id FROM sources WHERE status = 'needs-ocr' AND kind = 'pdf' AND blob_sha IS NOT NULL
         ORDER BY created_at, rowid`,
      )
      .all() as Array<{ id: string }>
  ).map((row) => row.id);
}
