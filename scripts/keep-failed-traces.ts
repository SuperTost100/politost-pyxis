import { rmSync } from "node:fs";
import type { Reporter, TestCase, TestResult } from "@playwright/test/reporter";

/**
 * Deletes the traces a test saved (`tests/e2e/app-under-test.ts`) once it has passed or been skipped, so the report folder
 * that CI keeps for a failed job holds the traces of the tests that failed and nothing else.
 */
export default class KeepFailedTraces implements Reporter {
  onTestEnd(_test: TestCase, result: TestResult): void {
    if (result.status === "failed" || result.status === "timedOut" || result.status === "interrupted") return;
    for (const attachment of result.attachments)
      if (attachment.name.startsWith("trace-") && attachment.path) rmSync(attachment.path, { force: true });
  }
}
