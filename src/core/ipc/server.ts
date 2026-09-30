import {
  IpcError,
  requests,
  toIpcError,
  type PortMessage,
} from "../../shared/ipc";
import { engineHandlers } from "../engine/handlers";
import { chatHandlers } from "../chat/handlers";
import { sourceHandlers } from "../sources/handlers";
import type { ProviderId } from "../engine/funnel";
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
let engines: ReturnType<typeof engineHandlers> | null = null;
let sources: ReturnType<typeof sourceHandlers> | null = null;
let chats: ReturnType<typeof chatHandlers> | null = null;
let port: CorePort | null = null;
const inflight = new Map<string, AbortController>();

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
  if (message.kind === "cancel") {
    inflight.get(message.id)?.abort();
    return;
  }
  if (message.kind !== "req") return;
  const controller = new AbortController();
  inflight.set(message.id, controller);
  try {
    const value = await dispatch(message.name, message.input, controller.signal);
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
  } finally {
    inflight.delete(message.id);
  }
}

async function dispatch(
  name: string,
  input: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
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
    case "engines.overview":
      requests["engines.overview"].input.parse(input);
      return engines?.overview();
    case "engines.models": {
      const parsed = requests["engines.models"].input.parse(input);
      return engines?.models({ provider: parsed.provider as ProviderId });
    }
    case "engines.test": {
      const parsed = requests["engines.test"].input.parse(input);
      return engines?.test({
        provider: parsed.provider as ProviderId,
        model: parsed.model,
      });
    }
    case "engines.setFeature": {
      const parsed = requests["engines.setFeature"].input.parse(input);
      return engines?.setFeature({
        ...parsed,
        provider: parsed.provider as ProviderId,
      });
    }
    case "engines.features":
      requests["engines.features"].input.parse(input);
      return engines?.features();
    case "engines.login": {
      const parsed = requests["engines.login"].input.parse(input);
      return engines?.login({ provider: parsed.provider as ProviderId });
    }
    case "engines.capability":
      return engines?.capability(
        requests["engines.capability"].input.parse(input),
      );
    case "engines.sendCode": {
      const parsed = requests["engines.sendCode"].input.parse(input);
      return engines?.sendCode({
        provider: parsed.provider as ProviderId,
        code: parsed.code,
      });
    }
    case "chats.list":
      requests["chats.list"].input.parse(input);
      return chats?.list();
    case "chats.read":
      return chats?.read(requests["chats.read"].input.parse(input));
    case "chats.ask":
      return chats?.ask({
        ...requests["chats.ask"].input.parse(input),
        signal,
      });
    case "sources.list":
      requests["sources.list"].input.parse(input);
      return sources?.list();
    case "sources.import":
      return sources?.importFile(requests["sources.import"].input.parse(input));
    case "sources.search":
      return sources?.search(requests["sources.search"].input.parse(input));
    case "sources.chapters":
      return sources?.chapters(requests["sources.chapters"].input.parse(input));
    case "sources.chapter":
      return sources?.chapter(requests["sources.chapter"].input.parse(input));
    default:
      throw new IpcError("unknown-request", "errors.unknownRequest");
  }
}

export function bindRunner(runner: Runner, dev: boolean): void {
  setJobHandlers(jobHandlers(runner, dev));
}

export function bindEngines(db: Parameters<typeof engineHandlers>[0]): void {
  engines = engineHandlers(db, (event) => broadcast("engine.login", event));
}

export function bindChat(db: Parameters<typeof chatHandlers>[0]): void {
  chats = chatHandlers(db);
}

export function bindSources(
  db: Parameters<typeof sourceHandlers>[0],
  workspace: string,
): void {
  sources = sourceHandlers(db, workspace);
}
