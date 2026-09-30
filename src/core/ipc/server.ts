import {
  IpcError,
  requests,
  toIpcError,
  type PortMessage,
} from "../../shared/ipc";
import { jobHandlers } from "../jobs/handlers";
import type { Runner } from "../jobs/runner";

type CorePort = {
  on(event: "message", listener: (event: { data: unknown }) => void): void;
  postMessage(message: unknown): void;
  start(): void;
  close(): void;
};

type HandlerMap = ReturnType<typeof jobHandlers>;

let handlers: HandlerMap | null = null;
let port: CorePort | null = null;

export function setJobHandlers(next: HandlerMap): void {
  handlers = next;
}

export function broadcast(name: string, value: unknown): void {
  port?.postMessage({ kind: "bcast", name, value } satisfies PortMessage);
}

export function attachRendererPort(next: CorePort): void {
  try {
    port?.close();
  } catch {
    // The previous renderer port is already gone after a reload.
  }
  port = next;
  next.start();
  next.on("message", (event) => {
    void onRendererMessage(next, event.data);
  });
}

async function onRendererMessage(from: CorePort, data: unknown): Promise<void> {
  if (!data || typeof data !== "object" || !("kind" in data)) return;
  const message = data as PortMessage;
  if (message.kind === "cancel") return;
  if (message.kind !== "req") return;
  try {
    const value = await dispatch(message.name, message.input);
    from.postMessage({
      kind: "res",
      id: message.id,
      ok: true,
      value,
    } satisfies PortMessage);
  } catch (err) {
    from.postMessage({
      kind: "res",
      id: message.id,
      ok: false,
      error: toIpcError(err),
    } satisfies PortMessage);
  }
}

async function dispatch(name: string, input: unknown): Promise<unknown> {
  if (!handlers) throw new IpcError("not-ready", "errors.notReady");
  switch (name) {
    case "jobs.list":
      requests["jobs.list"].input.parse(input);
      return handlers.list();
    case "jobs.startDemo":
      return handlers.startDemo(requests["jobs.startDemo"].input.parse(input));
    case "jobs.cancel":
      return handlers.cancel(requests["jobs.cancel"].input.parse(input));
    case "jobs.retry":
      return handlers.retry(requests["jobs.retry"].input.parse(input));
    case "jobs.resume":
      return handlers.resume(requests["jobs.resume"].input.parse(input));
    case "jobs.dismiss":
      return handlers.dismiss(requests["jobs.dismiss"].input.parse(input));
    default:
      throw new IpcError("unknown-request", "errors.unknownRequest");
  }
}

export function bindRunner(runner: Runner, dev: boolean): void {
  setJobHandlers(jobHandlers(runner, dev));
}
