import {
  IpcError,
  type RequestInput,
  type RequestOutput,
} from "../../shared/ipc";
import type Database from "better-sqlite3";
import { putSetting } from "../settings";
import { callsOf, clearJobLogs, readJobLog, setDebugOn } from "../debug/log";
import { limitedUntil, onLimitChange } from "../engine/bench";
import { engineSeesImages } from "../engine/capabilities";
import { chooseJobEngine, selectionOn } from "../engine/selection";
import type { Runner } from "./runner";

/** The tool a failed job's engine error names ("quota [codex]: …"), when the failure was a usage limit. */
function limitedToolOf(db: Database.Database, jobId: string): string | undefined {
  const row = db.prepare("SELECT state, error FROM jobs WHERE id = ?").get(jobId) as
    | { state: string; error: string | null }
    | undefined;
  if (row?.state !== "failed") return undefined;
  return /^quota \[([\w-]+)\]/.exec(row.error ?? "")?.[1];
}

/** Whether a job sends a picture to the model: a photo import that a vision engine reads (`source-import-vision`). */
function carriesImage(db: Database.Database, jobId: string): boolean {
  const row = db.prepare("SELECT kind FROM jobs WHERE id = ?").get(jobId) as { kind: string } | undefined;
  return row?.kind === "source-import-vision";
}

/** Whether debug mode is on, as stored. Off until the student turns it on. */
export function readDebugSetting(db: Database.Database): boolean {
  const row = db.prepare("SELECT value_json FROM settings WHERE key = 'debug'").get() as { value_json: string } | undefined;
  try {
    return row ? (JSON.parse(row.value_json) as { on?: unknown }).on === true : false;
  } catch {
    return false;
  }
}

export function jobHandlers(runner: Runner, dev: boolean, db?: Database.Database) {
  // A job held for a tool follows the tool's limit: moved when its time changes (the tool's own usage report gives a
  // better one than the first guess), and released at once when a call that answers clears it.
  onLimitChange((tool, until) => runner.retime(tool, until ?? null));
  return {
    list(): RequestOutput<"jobs.list"> {
      return runner.list();
    },
    finished(): RequestOutput<"jobs.finished"> {
      return runner.finished();
    },
    startDemo(
      input: RequestInput<"jobs.startDemo">,
    ): RequestOutput<"jobs.startDemo"> {
      if (!dev) throw new IpcError("not-available", "errors.notAvailable");
      return {
        jobId: runner.start("demo", { failOnce: input.failOnce === true }),
      };
    },
    cancel(input: RequestInput<"jobs.cancel">): RequestOutput<"jobs.cancel"> {
      runner.cancel(input.jobId);
      return {};
    },
    stopAll(): RequestOutput<"jobs.stopAll"> {
      return { jobIds: runner.stopAll() };
    },
    resumeAll(input: RequestInput<"jobs.resumeAll">): RequestOutput<"jobs.resumeAll"> {
      return { jobIds: runner.resumeAll(input.jobIds) };
    },
    retry(input: RequestInput<"jobs.retry">): RequestOutput<"jobs.retry"> {
      runner.retry(input.jobId);
      return {};
    },
    /**
     * The job stopped because its tool ran out of requests, and the student has it go on with `provider`. Every model
     * call of the job goes there from now on, and the job starts again from the step it stopped at. A job that sends a
     * picture only goes to a tool that can see it, as an automatic move does.
     */
    retryWith(input: RequestInput<"jobs.retryWith">): RequestOutput<"jobs.retryWith"> {
      const picture = db ? carriesImage(db, input.jobId) : false;
      const there = selectionOn(input.provider, picture ? "vision" : undefined);
      if (!there || (picture && !engineSeesImages(there)))
        throw new IpcError("engine-missing", "engines.errors.engine-missing");
      chooseJobEngine(input.jobId, input.provider);
      runner.retry(input.jobId);
      return {};
    },
    /**
     * The job stopped because its tool ran out of requests, and the student has it wait: it starts again by itself when
     * the tool's requests are back. Without a known time there is nothing to wait for.
     */
    wait(input: RequestInput<"jobs.wait">): RequestOutput<"jobs.wait"> {
      if (!input.wait) {
        runner.hold(input.jobId, null);
        return {};
      }
      const tool = db ? limitedToolOf(db, input.jobId) : undefined;
      const until = tool ? limitedUntil(tool) : undefined;
      if (until === undefined || !runner.hold(input.jobId, until, tool))
        throw new IpcError("not-ready", "jobs.actionFailed");
      return {};
    },
    resume(input: RequestInput<"jobs.resume">): RequestOutput<"jobs.resume"> {
      runner.resume(input.jobId);
      return {};
    },
    dismiss(
      input: RequestInput<"jobs.dismiss">,
    ): RequestOutput<"jobs.dismiss"> {
      runner.dismiss(input.jobId);
      return {};
    },
    async log(input: RequestInput<"jobs.log">): Promise<RequestOutput<"jobs.log">> {
      const log = await readJobLog(input.jobId);
      if (!log) return null;
      const { calls, capped } = callsOf(log.lines);
      return { calls, text: log.text, truncated: log.truncated, capped };
    },
    debugGet(): RequestOutput<"debug.get"> {
      return { on: db ? readDebugSetting(db) : false };
    },
    debugSet(input: RequestInput<"debug.set">): RequestOutput<"debug.set"> {
      if (db) putSetting(db, "debug", { on: input.on });
      setDebugOn(input.on);
      if (!input.on) void clearJobLogs();
      return { on: input.on };
    },
  };
}
