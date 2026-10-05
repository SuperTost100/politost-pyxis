import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ocrScratchRoot } from "./ocr-data";
import { ReusableWorker } from "./reusable-worker";

let workerDirectory = resolve("out/main");
export function setSourceWorkerDirectory(dir: string): void { workerDirectory = dir; }

// resourceLimits bound the V8 heap only. Buffers, WebAssembly memory and native decoders sit outside it, so the real
// bounds on those are the byte caps at each read and the archive limits in `zip-bounded.ts`, not this number.
const spawn = (name: string, data?: unknown) =>
  new Worker(join(workerDirectory, `${name}.js`), {
    workerData: data,
    ...(name === "extract-worker" ? { resourceLimits: { maxOldGenerationSizeMb: 2048, maxYoungGenerationSizeMb: 64 } } : {}),
  });
// A parked worker must not keep the process alive.
const spawnShared = (name: string, data?: unknown) => {
  const worker = spawn(name, data);
  worker.unref();
  return worker;
};

/**
 * Holds the ONNX Runtime addon open on this thread for the life of the process.
 *
 * Node keeps a process-wide table of the addons that worker threads have loaded and drops an addon's entry when the
 * last thread that loaded it closes (nodejs/node#48353, closed as not planned). `onnxruntime_binding.node` registers
 * itself from a static constructor, and the OS does not really unload it when Node asks: glibc pins an object that
 * defines a GNU_UNIQUE symbol (it has `Ort::Global<void>::api_`), and macOS dyld pins one that has thread-local
 * variables (libonnxruntime has them). So once every embed worker had exited, for instance a cancelled call followed by the
 * idle close, the next worker found the addon still mapped, no entry and no constructor run, and failed with
 * "Module did not self-register". Loading it here first keeps one reference, so every worker finds the entry.
 * It must run before the first embed worker is spawned. It only maps the addon: no session or environment is created.
 */
let pinnedAddon = false;
function pinInferenceAddon(): void {
  if (pinnedAddon) return;
  try {
    createRequire(join(workerDirectory, "embed-worker.js"))("onnxruntime-node/dist/binding.js");
    pinnedAddon = true;
  } catch {
    // Not installed here, such as a test pointing at stand-in workers. A real worker reports its own load error.
  }
}

/**
 * Caps how many one-shot workers of a kind run at once, so a burst of requests queues instead of spawning a thread
 * and a model or a decoded photo for each. A waiting call can be cancelled.
 */
export class Gate {
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  constructor(private readonly limit: number) {}

  async hold<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    while (this.active >= this.limit) {
      signal?.throwIfAborted();
      await new Promise<void>((resolve, reject) => {
        const wake = () => {
          signal?.removeEventListener("abort", leave);
          resolve();
        };
        const leave = () => {
          this.waiting.splice(this.waiting.indexOf(wake), 1);
          reject(signal?.reason);
        };
        this.waiting.push(wake);
        signal?.addEventListener("abort", leave, { once: true });
      });
    }
    this.active += 1;
    try {
      return await work();
    } finally {
      this.active -= 1;
      this.waiting.shift()?.();
    }
  }
}

/** Decoding a photo, or reading a chat attachment, can take hundreds of MB, so two at a time. Job extraction is bounded by the job runner instead. */
const decodeGate = new Gate(2);
/** The shared embedding worker serves one call. One more may run beside it, so chat does not wait on indexing. */
const embedFallbackGate = new Gate(1);

/** The embedding model is slow to load, so one worker stays up between calls. It serves one call at a time. */
let embedder: { dir: string; worker: ReusableWorker<{ texts: string[] }, number[][]> } | null = null;

/** Stops the shared embedding worker. The app lets it idle out, so this is for tests and shutdown. */
export function closeSourceWorkers(): void {
  embedder?.worker.close();
  embedder = null;
}

/** Workers own extraction and inference; only core writes the database. */
export function runSourceWorker<T>(name: "extract-worker" | "embed-worker", input: unknown, signal?: AbortSignal): Promise<T> {
  if (name === "embed-worker") {
    const { dir, texts } = input as { dir: string; texts: string[] };
    pinInferenceAddon();
    if (embedder?.dir !== dir) {
      embedder?.worker.close();
      embedder = { dir, worker: new ReusableWorker(() => spawnShared("embed-worker", { dir })) };
    }
    // A call that arrives while the shared worker is busy gets one extra worker, and further calls queue for it.
    if (!embedder.worker.busy) return embedder.worker.run({ texts }, signal) as Promise<T>;
    return embedFallbackGate.hold(() => oneShot<T>(name, input, signal), signal);
  }
  const mode = (input as { mode?: string }).mode;
  if (name === "extract-worker" && (mode === "vision" || mode === "pixels" || mode === "quality" || mode === "ocr" || mode === "extract"))
    return decodeGate.hold(() => oneShot<T>(name, input, signal), signal);
  return oneShot<T>(name, input, signal);
}

/**
 * Local OCR of an image's bytes in the extract worker, behind the decode gate. The recognizer turns a sideways JPEG
 * upright inside the worker, so the EXIF decode never runs on the core thread. The stored original is not touched.
 */
export function ocrBytes(bytes: Uint8Array, tess: string, signal?: AbortSignal): Promise<string> {
  return runSourceWorker<string>("extract-worker", { path: "", ext: "", tess, mode: "ocr", bytes }, signal);
}

function oneShot<T>(name: string, input: unknown, signal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    // A worker that can OCR gets a scratch folder named here, under the workspace. It is removed once the worker has
    // stopped, whether it finished, failed, was cancelled or timed out, so a terminated run leaves nothing behind.
    const tess = (input as { tess?: unknown } | null)?.tess;
    const scratch = name === "extract-worker" && typeof tess === "string" && tess ? join(ocrScratchRoot(tess), randomUUID()) : undefined;
    const worker = spawn(name, scratch ? { ...(input as object), scratch } : input);
    let settled = false;
    const finish = (error: unknown, value?: T) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      const stopped = worker.terminate();
      if (scratch) void Promise.resolve(stopped).finally(() => rm(scratch, { recursive: true, force: true })).catch(() => undefined);
      if (error) reject(error);
      else resolve(value as T);
    };
    const abort = () => finish(new DOMException("Cancelled", "AbortError"));
    signal?.addEventListener("abort", abort, { once: true });
    worker.on("message", (message: { value?: T; error?: string }) => {
      finish(message.error ? new Error(message.error) : null, message.value);
    });
    worker.on("error", (error) =>
      finish((error as { code?: string }).code === "ERR_WORKER_OUT_OF_MEMORY" ? new Error("source-worker-memory") : error),
    );
    worker.on("exit", () => {
      if (!settled) finish(new Error("source-worker-exited"));
    });
  });
}
