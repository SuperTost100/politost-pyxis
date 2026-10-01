import { Worker } from "node:worker_threads";
import { join, resolve } from "node:path";

let workerDirectory = resolve("out/main");
export function setSourceWorkerDirectory(dir: string): void { workerDirectory = dir; }

/** Workers own extraction and inference; only core writes the database. */
export function runSourceWorker<T>(name: "extract-worker" | "embed-worker", input: unknown, signal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const worker = new Worker(join(workerDirectory, `${name}.js`), { workerData: input });
    let settled = false;
    const finish = (error: unknown, value?: T) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      void worker.terminate();
      if (error) reject(error);
      else resolve(value as T);
    };
    const abort = () => finish(new DOMException("Cancelled", "AbortError"));
    signal?.addEventListener("abort", abort, { once: true });
    worker.on("message", (message: { value?: T; error?: string }) => {
      finish(message.error ? new Error(message.error) : null, message.value);
    });
    worker.on("error", (error) => finish(error));
    worker.on("exit", () => {
      if (!settled) finish(new Error("source-worker-exited"));
    });
  });
}
