import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";

/**
 * A Playwright trace starts with the options the app was launched with, which hold every variable of the environment it
 * was started from, a CI job's secrets included. This returns the zip with that list emptied. It throws when the zip is
 * not a trace with exactly one such record, so a trace of another shape is not passed on as clean.
 */
export function withoutLaunchEnvironment(zip: Uint8Array): Uint8Array {
  const files = unzipSync(zip);
  const log = files["trace.trace"];
  if (!log) throw new Error("the trace has no trace.trace");
  let cleared = 0;
  const lines = strFromU8(log)
    .split("\n")
    .map((line) => {
      if (!line.includes('"context-options"')) return line;
      const event = JSON.parse(line) as { type?: string; options?: { env?: unknown } };
      if (event.type !== "context-options") return line;
      cleared++;
      if (event.options) event.options.env = [];
      return JSON.stringify(event);
    });
  if (cleared !== 1) throw new Error(`the trace has ${cleared} launch options to clear, not 1`);
  files["trace.trace"] = strToU8(lines.join("\n"));
  return zipSync(files);
}
