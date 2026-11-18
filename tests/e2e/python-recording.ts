import type { ElectronApplication } from "@playwright/test";
import { test } from "@playwright/test";
import { writeFileSync } from "node:fs";

type Handle = { requests: () => unknown[]; evaluate: (script: string) => Promise<unknown> };

/**
 * Attaches to the failing test what the Python sandbox did, so a run that did not answer in time can be told apart: stuck
 * in the queue or in the clearing of the session, still opening the window, still loading Python, or running the code.
 * `requests` are the main process's records of the last requests (epoch milliseconds). `queued` is when a request was made,
 * before any wait behind earlier ones, and one dropped before its turn has an `outcome` and no `entered`. `marks` are the
 * moments of the sandbox page's lanes (`python-start`, `-ready`, `-run`, `-done`, and `check-` ones) on the same clock, and
 * `now` is the time of the reading. The helper never rejects, and says on one line when it could not record: it runs in the
 * `catch` of a test that has failed, and that test's own error is the one to report, not a full disk or a refused attachment.
 */
export async function attachPythonRecording(app: ElectronApplication, name = "python-recording") {
  try {
    await record(app, name);
  } catch (error) {
    console.warn(`The python recording "${name}" could not be saved: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function record(app: ElectronApplication, name: string) {
  const recording = await app
    .evaluate(async () => {
      const handle = (globalThis as unknown as { pyxisE2ePython: Handle }).pyxisE2ePython;
      let marks: unknown = "no Python window is open";
      try {
        // A page whose main thread is stuck would never answer, and the test must still end with its own error.
        marks = await Promise.race([
          handle.evaluate(
            `performance.getEntriesByType("mark").map((entry) => [entry.name, Math.round(performance.timeOrigin + entry.startTime)])`,
          ),
          new Promise((resolve) => setTimeout(() => resolve("no answer from the page in 5 s"), 5000)),
        ]);
      } catch (error) {
        marks = String(error);
      }
      return { now: Date.now(), requests: handle.requests(), marks };
    })
    .catch((error: unknown) => ({ unavailable: String(error) }));
  // A file in the test's output folder, which the failed job's artifact keeps; a body attached without a path would
  // reach only the reporters that store attachments, and the list reporter drops it.
  const path = test.info().outputPath(`${name}.json`);
  writeFileSync(path, JSON.stringify(recording, null, 2));
  await test.info().attach(name, { path, contentType: "application/json" });
}
