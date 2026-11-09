import {
  IpcError,
  type RequestInput,
  type RequestOutput,
} from "../../shared/ipc";
import type Database from "better-sqlite3";
import { putSetting } from "../settings";
import { callsOf, clearJobLogs, readJobLog, setDebugOn } from "../debug/log";
import type { Runner } from "./runner";

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
