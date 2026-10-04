import { randomBytes } from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { Runner } from "../jobs/runner";
import { checkClaim, type CheckClaim } from "./check";
import { runtimeRequest } from "./runtime-client";
import { runPython } from "./python";

export const RUNTIME_JOB = "local-runtime-download";
const MAX_PNG_BYTES = 3_000_000;
const KEEP_STAGED = 20;
const STAGED_MAX_AGE_MS = 60 * 60 * 1000;

/** Drops stale or surplus staged boards; best effort, never throws. */
function pruneStaged(dir: string, now = Date.now()): void {
  try {
    const files = readdirSync(dir)
      .filter((name) => /^pyxis-board-.*\.png$/.test(name))
      .map((name) => ({ name, mtime: statSync(join(dir, name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    files.forEach((file, index) => {
      if (index >= KEEP_STAGED || now - file.mtime > STAGED_MAX_AGE_MS)
        rmSync(join(dir, file.name), { force: true });
    });
  } catch {
    /* Directory may not exist yet. */
  }
}

export function registerRuntimeJob(runner: Runner): void {
  runner.register(RUNTIME_JOB, {
    jobClass: "local",
    steps: [
      {
        name: "download",
        label: "jobs.runtimeDownload",
        run: async ({ signal }) => {
          const cancel = () =>
            void runtimeRequest("cancel-download", {}).catch(() => undefined);
          signal.addEventListener("abort", cancel, { once: true });
          try {
            return await runtimeRequest("download", {}, 30 * 60 * 1000);
          } finally {
            signal.removeEventListener("abort", cancel);
          }
        },
      },
    ],
  });
}

export function toolHandlers(workspace = "", runner?: Runner) {
  const staging = workspace ? join(workspace, "scratch", "whiteboard") : "";
  if (staging) pruneStaged(staging);
  return {
    check(input: CheckClaim) {
      return checkClaim(input);
    },
    runtime() {
      return runtimeRequest("status", {});
    },
    /** Starts, or re-attaches to, the one explicit runtime download job. */
    runtimeDownload() {
      if (!runner) throw new Error("runtime-unavailable");
      const existing = runner.list().find((job) => job.kind === RUNTIME_JOB);
      if (existing) {
        if (existing.state === "interrupted") runner.resume(existing.id);
        else if (["failed", "cancelled"].includes(existing.state))
          runner.retry(existing.id);
        return { jobId: existing.id };
      }
      return { jobId: runner.start(RUNTIME_JOB) };
    },
    python(input: { code: string }) {
      return runPython(input.code);
    },
    stagePng(input: { dataUrl: string }) {
      if (!staging) throw new Error("workspace-missing");
      const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(
        input.dataUrl,
      );
      if (!match?.[1] || match[1].length > (MAX_PNG_BYTES * 4) / 3 + 4)
        throw new Error("png-invalid");
      const bytes = Buffer.from(match[1], "base64");
      const signature = Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      ]);
      if (
        bytes.length < 32 ||
        bytes.length > MAX_PNG_BYTES ||
        !bytes.subarray(0, 8).equals(signature)
      ) {
        throw new Error("png-invalid");
      }
      mkdirSync(staging, { recursive: true });
      pruneStaged(staging);
      const path = join(
        staging,
        `pyxis-board-${Date.now()}-${randomBytes(4).toString("hex")}.png`,
      );
      writeFileSync(path, bytes, { mode: 0o600 });
      return { path };
    },
  };
}
