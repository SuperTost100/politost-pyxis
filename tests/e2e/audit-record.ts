import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

/**
 * The route audit's record of one run: each state's result and the failures so far. A part of the audit that fails or
 * times out ends its worker, and the next part starts a new one that takes the record up where the last stopped, so the
 * record file is the one place that survives. `run` names the invocation: Playwright's `globalSetup` points TMPDIR at a
 * fresh folder once, before any worker starts, and replacement workers inherit it, so it is the same for every worker of
 * a run and never repeats. A file written by another run, or by no run, is not resumed.
 */
export class AuditRecord {
  readonly records: unknown[] = [];
  readonly failures: string[] = [];
  private ready = false;

  constructor(
    private readonly file: string,
    private readonly run: string,
    private readonly fixed: Record<string, unknown>,
  ) {}

  /**
   * Takes up what an earlier worker of this run recorded. Call it first in a worker's setup, before anything that can
   * fail: until it has run, `write` does nothing, so a setup that fails cannot overwrite the record with an empty one.
   */
  resume(): void {
    let kept: { run?: unknown; records?: unknown; failures?: unknown } | null = null;
    try {
      kept = existsSync(this.file) ? JSON.parse(readFileSync(this.file, "utf8")) : null;
    } catch {
      // A file that cannot be read or parsed (a worker was killed while writing) holds nothing to resume.
      kept = null;
    }
    if (this.run && kept?.run === this.run && Array.isArray(kept.records) && Array.isArray(kept.failures)) {
      this.records.push(...kept.records);
      this.failures.push(...(kept.failures as string[]));
    }
    this.ready = true;
  }

  /** Writes the record through a temporary file, so a worker that is killed mid-write leaves the last whole record. */
  write(): void {
    if (!this.ready) return;
    const temp = `${this.file}.tmp`;
    writeFileSync(
      temp,
      JSON.stringify({ run: this.run, ...this.fixed, records: this.records, failures: this.failures }, null, 2),
    );
    renameSync(temp, this.file);
  }
}
