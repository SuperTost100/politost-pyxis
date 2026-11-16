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
import type { PackId } from "../../shared/figure-kinds";

/** Python's download, and the one the Python page starts, which fetches every pack that is missing. */
const RUNTIME_JOB = "local-runtime-download";
/** The drawing pack's own download, started from Settings. */
const DRAWINGS_JOB = "local-drawings-download";
type RuntimeJobParams = { packs?: PackId[] } | undefined;
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

/** The download step of both kinds: it fetches the packs the job's params name, or every pack that is missing. */
function downloadStep(label: string, packsOf: (params: unknown) => PackId[] | undefined) {
  return {
    name: "download",
    label,
    run: async ({ signal, params }: { signal: AbortSignal; params: unknown }) => {
      const packs = packsOf(params);
      const cancel = () => void runtimeRequest("cancel-download", { packs }).catch(() => undefined);
      signal.addEventListener("abort", cancel, { once: true });
      try {
        return await runtimeRequest("download", { packs }, 30 * 60 * 1000);
      } finally {
        signal.removeEventListener("abort", cancel);
      }
    },
  };
}

export function registerRuntimeJob(runner: Runner): void {
  runner.register(RUNTIME_JOB, {
    jobClass: "local",
    // A download of Python alone and one of every missing pack are two jobs: a page asking for one is not given the other.
    ref: (params) => (params as RuntimeJobParams)?.packs?.join(",") ?? "missing",
    steps: [downloadStep("jobs.runtimeDownload", (params) => (params as RuntimeJobParams)?.packs)],
  });
  runner.register(DRAWINGS_JOB, {
    jobClass: "local",
    steps: [downloadStep("jobs.drawingsDownload", () => ["drawing"])],
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
    /**
     * Starts, or re-attaches to, an explicit download job. This is the only place a download starts: from Settings for one
     * pack (Python's or the drawing pack's), and from the Python page for every pack that is missing. A workspace that has
     * Python but lacks a newer pack is not given that pack on its own. A download that finished earlier is not re-attached
     * to, so pressing Download again fetches what is missing now.
     */
    runtimeDownload(input: { pack?: PackId } = {}) {
      if (!runner) throw new Error("runtime-unavailable");
      const kind = input.pack === "drawing" ? DRAWINGS_JOB : RUNTIME_JOB;
      const params: RuntimeJobParams = input.pack === "pyodide" ? { packs: ["pyodide"] } : undefined;
      const ref = kind === RUNTIME_JOB ? (params?.packs?.join(",") ?? "missing") : null;
      const existing = runner
        .list()
        .find((job) => job.kind === kind && job.state !== "succeeded" && (ref === null || job.ref === ref));
      if (existing) {
        if (existing.state === "interrupted") runner.resume(existing.id);
        else if (["failed", "cancelled"].includes(existing.state))
          runner.retry(existing.id);
        return { jobId: existing.id };
      }
      return { jobId: runner.start(kind, params) };
    },
    /** Takes one pack off the disk. What it drew stays in the lessons and answers, which store their pictures. */
    async runtimeRemove(input: { pack: PackId }) {
      await runtimeRequest("remove", { pack: input.pack });
      return {};
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
