/** The slice of `worker_threads.Worker` this needs, so a test can stand in for it. */
export type WorkerLike = {
  postMessage(message: unknown): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the events carry different payloads
  on(event: string, listener: (payload: any) => void): unknown;
  terminate(): Promise<unknown>;
};

type Reply<Res> = { id: number; value?: Res; error?: string };

/**
 * One worker kept alive between requests, so a model loads once instead of per call. It serves one request at a
 * time (`busy` says so, and the caller picks another route). It is dropped after `idleMs` without work, when a
 * request is cancelled, or when it dies, and the next request starts a fresh one.
 * The worker protocol: it receives `{ id, request }` and answers `{ id, value }` or `{ id, error }`. On idle it
 * receives `{ close: true }` first, so it can release native resources, and has `closeMs` to exit before it is terminated.
 */
export class ReusableWorker<Req, Res> {
  private worker: WorkerLike | null = null;
  private pending: { id: number; resolve(value: Res): void; reject(error: unknown): void } | null = null;
  private idle: ReturnType<typeof setTimeout> | undefined;
  private nextId = 1;

  constructor(
    private readonly spawn: () => WorkerLike,
    private readonly idleMs = 60_000,
    private readonly closeMs = 2_000,
  ) {}

  get busy(): boolean {
    return this.pending != null;
  }

  run(request: Req, signal?: AbortSignal): Promise<Res> {
    if (this.pending) throw new Error("worker-busy");
    if (signal?.aborted) return Promise.reject(signal.reason);
    clearTimeout(this.idle);
    const worker = (this.worker ??= this.start());
    const id = this.nextId++;
    return new Promise<Res>((resolve, reject) => {
      const abort = () => {
        this.drop(worker);
        settle(() => reject(new DOMException("Cancelled", "AbortError")));
      };
      const settle = (finish: () => void) => {
        if (this.pending?.id !== id) return;
        this.pending = null;
        signal?.removeEventListener("abort", abort);
        if (this.worker) this.arm();
        finish();
      };
      this.pending = {
        id,
        resolve: (value) => settle(() => resolve(value)),
        reject: (error) => settle(() => reject(error)),
      };
      signal?.addEventListener("abort", abort, { once: true });
      worker.postMessage({ id, request });
    });
  }

  /** Stop the worker now. Anything in flight fails. */
  close(): void {
    clearTimeout(this.idle);
    if (this.worker) this.drop(this.worker);
    this.pending?.reject(new Error("source-worker-exited"));
  }

  private start(): WorkerLike {
    const worker = this.spawn();
    worker.on("message", (message: Reply<Res>) => {
      if (this.worker !== worker || this.pending?.id !== message.id) return;
      if (message.error) this.pending.reject(new Error(message.error));
      else this.pending.resolve(message.value as Res);
    });
    const died = (error: Error) => {
      // A worker that was dropped or closed on purpose says nothing about the call running on its successor.
      if (this.worker !== worker) return;
      this.worker = null;
      this.pending?.reject(error);
    };
    worker.on("error", died);
    worker.on("exit", () => died(new Error("source-worker-exited")));
    return worker;
  }

  private drop(worker: WorkerLike): void {
    if (this.worker === worker) this.worker = null;
    void worker.terminate();
  }

  private arm(): void {
    clearTimeout(this.idle);
    const worker = this.worker;
    this.idle = setTimeout(() => {
      if (!worker || this.worker !== worker || this.pending) return;
      this.worker = null;
      worker.postMessage({ close: true });
      setTimeout(() => void worker.terminate(), this.closeMs).unref();
    }, this.idleMs);
    this.idle.unref();
  }
}
