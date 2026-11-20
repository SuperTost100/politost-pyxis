import type { ElectronApplication } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { attachPythonRecording } from "./python-recording";

// The recording is there to explain a failed test, so it must never replace that test's own error: it is attached when it can
// be, and when it cannot, the helper says so on one line and returns. No app is launched; the helper only asks `evaluate`.
const app = {
  evaluate: async () => ({ now: 1, requests: [], marks: [] }),
} as unknown as ElectronApplication;

test("the recording is attached when it can be written", async () => {
  await attachPythonRecording(app, "python-recording-ok");
  const attached = test.info().attachments.find((item) => item.name === "python-recording-ok");
  expect(attached?.path && existsSync(attached.path)).toBe(true);
  expect(JSON.parse(readFileSync(attached!.path!, "utf8"))).toMatchObject({ now: 1 });
});

test("a recording that cannot be written does not reject, and says so once", async () => {
  const lines: string[] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => void lines.push(args.join(" "));
  try {
    // A folder that is not there: the write fails as a full disk would.
    await expect(attachPythonRecording(app, "no-such-folder/python-recording")).resolves.toBeUndefined();
  } finally {
    console.warn = warn;
  }
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain("python recording");
  expect(test.info().attachments.some((item) => item.name === "no-such-folder/python-recording")).toBe(false);
});
