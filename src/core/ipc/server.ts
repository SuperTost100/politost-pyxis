import {
  IpcError,
  requests,
  toIpcError,
  type PortMessage,
} from "../../shared/ipc";
import { engineHandlers } from "../engine/handlers";
import { chatHandlers } from "../chat/handlers";
import { toolHandlers } from "../math/handlers";
import { mapHandlers } from "../maps/handlers";
import { planHandlers } from "../plans/handlers";
import { studyHandlers } from "../study/handlers";
import { profileHandlers } from "../profile/handlers";
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
let profile: ReturnType<typeof profileHandlers> | null = null;
let plans: ReturnType<typeof planHandlers> | null = null;
let study: ReturnType<typeof studyHandlers> | null = null;
let maps: ReturnType<typeof mapHandlers> | null = null;
let tools: ReturnType<typeof toolHandlers> | null = null;
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
    const value = await dispatch(
      message.name,
      message.input,
      controller.signal,
      (event) => {
        from.postMessage({
          kind: "stream",
          id: message.id,
          event,
        } satisfies PortMessage);
      },
    );
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
  emit?: (event: unknown) => void,
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
    case "engines.clearFeature":
      return (
        engines?.clearFeature(
          requests["engines.clearFeature"].input.parse(input),
        ) ?? {
          ok: true as const,
        }
      );
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
    case "study.lesson":
      return study?.lesson(requests["study.lesson"].input.parse(input));
    case "study.markdown":
      return study?.markdown(requests["study.markdown"].input.parse(input));
    case "study.anki":
      return study?.anki(requests["study.anki"].input.parse(input));
    case "study.csv":
      return study?.csv(requests["study.csv"].input.parse(input));
    case "study.diagnosticStart":
      return study?.diagnosticStart(
        requests["study.diagnosticStart"].input.parse(input),
      );
    case "study.quizStart":
      return study?.quizStart(requests["study.quizStart"].input.parse(input));
    case "study.quizDraft":
      return study?.quizDraft(requests["study.quizDraft"].input.parse(input));
    case "study.quizRead":
      return study?.quizRead(requests["study.quizRead"].input.parse(input));
    case "study.quizCheck":
      return study?.quizCheck(requests["study.quizCheck"].input.parse(input));
    case "study.quizSubmit":
      return study?.quizSubmit(requests["study.quizSubmit"].input.parse(input));
    case "study.flag":
      return study?.flag(requests["study.flag"].input.parse(input));
    case "study.review":
      return study?.review(requests["study.review"].input.parse(input));
    case "study.simulationOpen":
      return (
        study?.simulationOpen(
          requests["study.simulationOpen"].input.parse(input),
        ) ?? null
      );
    case "study.simulationStart":
      return study?.simulationStart(
        requests["study.simulationStart"].input.parse(input),
      );
    case "study.simulationSubmit":
      return study?.simulationSubmit(
        requests["study.simulationSubmit"].input.parse(input),
      );
    case "study.simulationRead":
      return study?.simulationRead(
        requests["study.simulationRead"].input.parse(input),
      );
    case "study.simulationDraft":
      return study?.simulationDraft(
        requests["study.simulationDraft"].input.parse(input),
      );
    case "study.cards":
      return study?.cards(requests["study.cards"].input.parse(input)) ?? [];
    case "study.queue":
      return study?.queue(requests["study.queue"].input.parse(input));
    case "study.save":
      return study?.save(requests["study.save"].input.parse(input));
    case "study.remove":
      return study?.remove(requests["study.remove"].input.parse(input));
    case "study.suspend":
      return study?.suspend(requests["study.suspend"].input.parse(input));
    case "study.suspended":
      return (
        study?.suspended(requests["study.suspended"].input.parse(input)) ?? []
      );
    case "study.rate":
      return study?.rate(requests["study.rate"].input.parse(input));
    case "study.active":
      return study?.active(requests["study.active"].input.parse(input));
    case "study.exercises":
      return (
        study?.exercises(requests["study.exercises"].input.parse(input)) ?? []
      );
    case "tools.check":
      return tools?.check(requests["tools.check"].input.parse(input));
    case "tools.runtime":
      requests["tools.runtime"].input.parse(input);
      return tools?.runtime();
    case "tools.python":
      return tools?.python(requests["tools.python"].input.parse(input));
    case "tools.stagePng":
      return tools?.stagePng(requests["tools.stagePng"].input.parse(input));
    case "maps.list":
      return maps?.list(requests["maps.list"].input.parse(input));
    case "maps.build":
      return maps?.build(requests["maps.build"].input.parse(input));
    case "maps.generate":
      return maps?.generate(requests["maps.generate"].input.parse(input));
    case "maps.edit":
      return maps?.edit(requests["maps.edit"].input.parse(input));
    case "maps.open":
      return maps?.open(requests["maps.open"].input.parse(input));
    case "maps.layout":
      return maps?.layout(requests["maps.layout"].input.parse(input));
    case "maps.move":
      return maps?.move(requests["maps.move"].input.parse(input));
    case "maps.patch":
      return maps?.patch(requests["maps.patch"].input.parse(input));
    case "maps.undo":
      return maps?.undo(requests["maps.undo"].input.parse(input));
    case "plans.build":
      return plans?.build(requests["plans.build"].input.parse(input));
    case "plans.intro":
      return plans?.intro(requests["plans.intro"].input.parse(input));
    case "plans.list":
      requests["plans.list"].input.parse(input);
      return plans?.list() ?? [];
    case "subjects.add":
      return plans?.addSubject(requests["subjects.add"].input.parse(input));
    case "subjects.reorder":
      return plans?.reorderSubjects(
        requests["subjects.reorder"].input.parse(input),
      );
    case "subjects.remove":
      return plans?.removeSubject(
        requests["subjects.remove"].input.parse(input),
      );
    case "subjects.list":
      requests["subjects.list"].input.parse(input);
      return plans?.subjects() ?? [];
    case "plans.usage":
      requests["plans.usage"].input.parse(input);
      return plans?.usage() ?? [];
    case "plans.delete":
      return plans?.delete(requests["plans.delete"].input.parse(input));
    case "plans.export":
      return plans?.export(requests["plans.export"].input.parse(input));
    case "plans.import":
      return plans?.import(requests["plans.import"].input.parse(input));
    case "plans.mastery":
      return plans?.mastery(requests["plans.mastery"].input.parse(input)) ?? [];
    case "plans.series":
      return plans?.series(requests["plans.series"].input.parse(input));
    case "plans.simulations":
      return (
        plans?.simulations(requests["plans.simulations"].input.parse(input)) ??
        []
      );
    case "plans.recommend":
      return (
        plans?.recommend(requests["plans.recommend"].input.parse(input)) ?? null
      );
    case "plans.complete":
      return plans?.complete(requests["plans.complete"].input.parse(input));
    case "plans.read":
      return plans?.read(requests["plans.read"].input.parse(input)) ?? null;
    case "plans.create":
      return plans?.create(requests["plans.create"].input.parse(input), signal);
    case "plans.rebuild":
      return plans?.rebuild(requests["plans.rebuild"].input.parse(input));
    case "profile.get":
      requests["profile.get"].input.parse(input);
      return profile?.get() ?? null;
    case "profile.save":
      return profile?.save(requests["profile.save"].input.parse(input));
    case "chats.list":
      requests["chats.list"].input.parse(input);
      return chats?.list();
    case "chats.read":
      return chats?.read(requests["chats.read"].input.parse(input));
    case "chats.seed":
      return chats?.seed(requests["chats.seed"].input.parse(input));
    case "chats.clearContext":
      return chats?.clearContext(
        requests["chats.clearContext"].input.parse(input),
      );
    case "chats.rate":
      return chats?.rate(requests["chats.rate"].input.parse(input));
    case "chats.rename":
      return chats?.rename(requests["chats.rename"].input.parse(input));
    case "chats.delete":
      return chats?.remove(requests["chats.delete"].input.parse(input));
    case "chats.ask":
      return chats?.ask({
        ...requests["chats.ask"].input.parse(input),
        signal,
        onDelta: (text) => emit?.({ type: "text", text }),
      });
    case "chats.regenerate":
      return chats?.regenerate({
        ...requests["chats.regenerate"].input.parse(input),
        signal,
        onDelta: (text) => emit?.({ type: "text", text }),
      });
    case "sources.list":
      requests["sources.list"].input.parse(input);
      return sources?.list();
    case "sources.import":
      return sources?.importFile(requests["sources.import"].input.parse(input));
    case "sources.search":
      return sources?.search(
        requests["sources.search"].input.parse(input),
        signal,
      );
    case "sources.chapters":
      return sources?.chapters(requests["sources.chapters"].input.parse(input));
    case "sources.meta":
      return sources?.meta(requests["sources.meta"].input.parse(input));
    case "sources.ocr":
      return sources?.ocr(requests["sources.ocr"].input.parse(input));
    case "sources.paste":
      return sources?.paste(requests["sources.paste"].input.parse(input));
    case "sources.link":
      return sources?.link(requests["sources.link"].input.parse(input));
    case "sources.scanFolder":
      return sources?.scanFolder(
        requests["sources.scanFolder"].input.parse(input),
      );
    case "sources.preview":
      return sources?.preview(requests["sources.preview"].input.parse(input));
    case "sources.rename":
      return sources?.rename(requests["sources.rename"].input.parse(input));
    case "sources.replace":
      return sources?.replace(requests["sources.replace"].input.parse(input));
    case "sources.remove":
      return sources?.remove(requests["sources.remove"].input.parse(input));
    case "sources.promote":
      return sources?.promote(requests["sources.promote"].input.parse(input));
    case "sources.ocrImage":
      return sources?.ocrImage(requests["sources.ocrImage"].input.parse(input));
    case "sources.embedState":
      requests["sources.embedState"].input.parse(input);
      return sources?.embedState();
    case "sources.embed":
      return sources?.embed(requests["sources.embed"].input.parse(input));
    case "sources.passage":
      return sources?.passage(requests["sources.passage"].input.parse(input));
    case "sources.viewerDocument":
      return sources?.viewerDocument(
        requests["sources.viewerDocument"].input.parse(input),
      );
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

export function bindStudy(
  db: Parameters<typeof studyHandlers>[0],
  runner?: Parameters<typeof studyHandlers>[1],
  run?: Parameters<typeof studyHandlers>[2],
  simulationRun?: Parameters<typeof studyHandlers>[3],
): void {
  study = studyHandlers(db, runner, run, simulationRun);
}

export function bindTools(): void {
  tools = toolHandlers();
}

export function bindMaps(
  db: Parameters<typeof mapHandlers>[0],
  runner?: Runner,
  run?: Parameters<typeof mapHandlers>[2],
): void {
  maps = mapHandlers(db, runner, run);
}

export function bindPlans(
  db: Parameters<typeof planHandlers>[0],
  workspace = "",
  runner?: Runner,
  run?: Parameters<typeof planHandlers>[3],
): void {
  plans = planHandlers(db, workspace, runner, run);
}

export function bindProfile(db: Parameters<typeof profileHandlers>[0]): void {
  profile = profileHandlers(db);
}

export function bindChat(
  db: Parameters<typeof chatHandlers>[0],
  workspace = "",
  fixtureReply?: string,
): void {
  chats = chatHandlers(db, workspace, fixtureReply);
}

export function bindSources(
  db: Parameters<typeof sourceHandlers>[0],
  workspace: string,
  runner: Runner,
): void {
  sources = sourceHandlers(db, workspace, runner);
}
