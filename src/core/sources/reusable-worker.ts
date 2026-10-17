/** The slice of `worker_threads.Worker` this needs, so a test can stand in for it. */
export type WorkerLike = {
  postMessage(message: unknown): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the events carry different payloads
  on(event: string, listener: (payload: any) => void): unknown;
  terminate(): Promise<unknown>;
};

type Reply<Res> = { id: number; value?: Res; error?: string };
type Call<Req, Res> = { request: Req; urgent: boolean; resolve(value: Res): void; reject(error: unknown): void };

/**
 * One worker that serves requests one at a time, so a model loads once instead of per call. More requests wait in
 * order, and an urgent one goes before the others (`busy` says one is running or waiting).
 *
 * The worker is not stopped on purpose, because a thread that runs a native addon such as ONNX Runtime can abort the
 * whole process when it is terminated mid-call, or when it exits close to another thread loading the addon (#58).
 * After `idleMs` without work, or on `unload()`, it receives `{ unload: true }` and releases its model but stays.
 * The protocol: it receives `{ id, request }` and answers `{ id, value }` or `{ id, error }`. A cancelled request
 * fails at once for its caller, and the worker receives `{ cancel: id }`. The next request starts once the worker has
 * answered the cancelled one. A worker that has not answered after `cancelMs` is stuck and is terminated after all;
 * so is one that dies. A new worker starts only once the old one has exited.
 */
export class ReusableWorker<Req, Res> {
  private worker: WorkerLike | null = null;
  private current: { id: number; call: Call<Req, Res> } | null = null;
  private readonly queue: Array<Call<Req, Res>> = [];
  private idle: ReturnType<typeof setTimeout> | undefined;
  private stall: ReturnType<typeof setTimeout> | undefined;
  private nextId = 1;
  /** Settles once the last worker started has exited. */
  private gone: Promise<unknown> = Promise.resolve();
  private spawning = false;

  constructor(
    private readonly spawn: () => WorkerLike,
    private readonly idleMs = 60_000,
    private readonly cancelMs = 30_000,
  ) {}

  get busy(): boolean {
    return this.current != null || this.queue.length > 0;
  }

  run(request: Req, signal?: AbortSignal, urgent = false): Promise<Res> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    return new Promise<Res>((resolve, reject) => {
      let settled = false;
      const settle = (finish: () => void) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", abort);
        finish();
      };
      const call: Call<Req, Res> = {
        request,
        urgent,
        resolve: (value) => settle(() => resolve(value)),
        reject: (error) => settle(() => reject(error)),
      };
      const abort = () => {
        const waiting = this.queue.indexOf(call);
        if (waiting >= 0) this.queue.splice(waiting, 1);
        else if (this.current?.call === call) this.cancel(this.current.id);
        call.reject(new DOMException("Cancelled", "AbortError"));
      };
      signal?.addEventListener("abort", abort, { once: true });
      const behind = urgent ? this.queue.findIndex((waiting) => !waiting.urgent) : -1;
      this.queue.splice(behind >= 0 ? behind : this.queue.length, 0, call);
      this.next();
    });
  }

  /** Fail anything in flight or waiting, stop the running request, and have the worker release its model. */
  unload(): void {
    clearTimeout(this.idle);
    for (const call of this.queue.splice(0)) call.reject(new Error("source-worker-exited"));
    if (this.current) {
      this.current.call.reject(new Error("source-worker-exited"));
      this.cancel(this.current.id);
    }
    this.worker?.postMessage({ unload: true });
  }

  private next(): void {
    if (this.current || this.spawning) return;
    if (this.queue.length === 0) {
      if (this.worker) this.arm();
      return;
    }
    clearTimeout(this.idle);
    if (!this.worker) {
      this.spawning = true;
      void this.gone.then(() => {
        this.spawning = false;
        if (this.queue.length > 0 && !this.worker) {
          try {
            this.worker = this.start();
          } catch (error) {
            // No thread could be started (out of memory or threads): everything waiting fails, and the next call tries again.
            for (const call of this.queue.splice(0)) call.reject(error);
            return;
          }
        }
        this.next();
      });
      return;
    }
    const worker = this.worker;
    const call = this.queue.shift()!;
    const id = this.nextId++;
    this.current = { id, call };
    worker.postMessage({ id, request: call.request });
  }

  private cancel(id: number): void {
    const worker = this.worker;
    worker?.postMessage({ cancel: id });
    clearTimeout(this.stall);
    this.stall = setTimeout(() => {
      // The worker did not answer the cancelled request in time, so it is stuck: the next request gets a fresh one.
      if (!worker || this.worker !== worker || this.current?.id !== id) return;
      this.worker = null;
      this.current = null;
      void worker.terminate();
      this.next();
    }, this.cancelMs);
    this.stall.unref();
  }

  private start(): WorkerLike {
    const worker = this.spawn();
    this.gone = new Promise((resolve) => worker.on("exit", resolve));
    worker.on("message", (message: Reply<Res>) => {
      if (this.worker !== worker || this.current?.id !== message.id) return;
      const { call } = this.current;
      this.current = null;
      clearTimeout(this.stall);
      // A cancelled call has already failed, so its late answer goes nowhere.
      if (message.error) call.reject(new Error(message.error));
      else call.resolve(message.value as Res);
      this.next();
    });
    const died = (error: Error) => {
      // A worker given up as stuck says nothing about the calls its successor serves.
      if (this.worker !== worker) return;
      this.worker = null;
      const call = this.current?.call;
      this.current = null;
      clearTimeout(this.stall);
      call?.reject(error);
      this.next();
    };
    worker.on("error", died);
    worker.on("exit", () => died(new Error("source-worker-exited")));
    return worker;
  }

  private arm(): void {
    clearTimeout(this.idle);
    const worker = this.worker;
    this.idle = setTimeout(() => {
      if (worker && this.worker === worker && !this.busy) worker.postMessage({ unload: true });
    }, this.idleMs);
    this.idle.unref();
  }
}
