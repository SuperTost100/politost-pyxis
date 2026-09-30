import {
  IpcError,
  type RequestInput,
  type RequestOutput,
} from "../../shared/ipc";
import type { Runner } from "./runner";

export function jobHandlers(runner: Runner, dev: boolean) {
  return {
    list(): RequestOutput<"jobs.list"> {
      return runner.list();
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
  };
}
