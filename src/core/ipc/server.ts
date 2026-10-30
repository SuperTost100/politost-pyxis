import { MAX_FILES, MAX_FILE_BYTES, MAX_TOTAL_BYTES } from "../chat/attach";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { maxSourceBytes } from "../../shared/source-types";
import { FileGrants, pickedFileGrant, type FileGrant } from "./file-grants";
import { configureDisclosure } from "../engine/funnel";
import { configureSignOuts } from "../engine/bench";
import { signOutStore } from "../engine/choice";
import { setFallbackListener } from "../engine/generate";
import { currentUsageScope, setUsageRecorder, storeUsage } from "../engine/usage";
import type { z } from "zod";
import {
  IpcError,
  requests,
  toIpcError,
  type PortMessage,
  type RequestName,
} from "../../shared/ipc";
import { engineHandlers } from "../engine/handlers";
import { chatHandlers } from "../chat/handlers";
import { setChecksListener } from "../chat/turn";
import { registerRuntimeJob, toolHandlers } from "../math/handlers";
import { mapHandlers } from "../maps/handlers";
import { planHandlers } from "../plans/handlers";
import { studyHandlers } from "../study/handlers";
import { profileHandlers } from "../profile/handlers";
import { sourceHandlers } from "../sources/handlers";
import type { BooksTransport } from "../sources/books";
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
let jobRunner: Runner | null = null;
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
const fileGrants = new FileGrants();
let fileScratch = "";
export function addFileGrants(grants: FileGrant[]): void {
  for (const grant of grants) fileGrants.add(grant);
}

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
  if (name === "sources.scanFolder") {
    const parsed = requests["sources.scanFolder"].input.parse(input);
    try {
      parsed.path = fileGrants.directory(parsed.path);
    } catch {
      throw new IpcError("file-access-denied", "errors.fileAccessDenied");
    }
    return dispatchValidated(name, parsed, signal, emit);
  }
  let parsed: { path?: string; files?: string[] } | undefined;
  if (
    name === "sources.import" ||
    name === "sources.replace" ||
    name === "sources.preview" ||
    name === "study.ankiPreview" ||
    name === "study.ankiImport"
  )
    parsed = requests[name].input.parse(input);
  if (name === "chats.ask" || name === "chats.regenerate")
    parsed = requests[name].input.parse(input);
  const paths = parsed?.path ? [parsed.path] : (parsed?.files ?? []);
  if (!paths.length) return dispatchValidated(name, input, signal, emit);
  let temporary: string | undefined;
  const attachment = name === "chats.ask" || name === "chats.regenerate";
  try {
    if (attachment && paths.length > MAX_FILES)
      throw new Error("attach-too-many");
    if (process.env.PYXIS_E2E === "1") console.error("pyxis-e2e: file boundary read start", name);
    let remaining = MAX_TOTAL_BYTES;
    const bytes = paths.map((path) => {
      const bytes = fileGrants.read(
        path,
        attachment
          ? Math.min(MAX_FILE_BYTES, remaining)
          : maxSourceBytes(extname(path)),
      );
      remaining -= bytes.length;
      return bytes;
    });
    if (process.env.PYXIS_E2E === "1") console.error("pyxis-e2e: file boundary snapshot start", name);
    temporary = mkdtempSync(join(fileScratch, "picked-"));
    const snapshots = paths.map((path, index) => {
      const directory = join(temporary!, String(index));
      mkdirSync(directory, { mode: 0o700 });
      const snapshot = join(directory, basename(path));
      writeFileSync(snapshot, bytes[index]!, { mode: 0o600, flag: "wx" });
      return snapshot;
    });
    if (parsed?.path) parsed.path = snapshots[0]!;
    else if (parsed) parsed.files = snapshots;
    if (process.env.PYXIS_E2E === "1") console.error("pyxis-e2e: file boundary dispatch", name);
    return await dispatchValidated(name, parsed, signal, emit);
  } catch (error) {
    if (error instanceof Error && error.message === "file-access-denied")
      throw new IpcError("file-access-denied", "errors.fileAccessDenied");
    if (error instanceof Error && error.message === "attach-too-big" && !attachment)
      throw new IpcError("source-too-big", "sources.tooBig");
    if (
      error instanceof Error &&
      ["attach-too-big", "attach-too-many"].includes(error.message)
    )
      throw new IpcError("attach-too-big", "errors.attachTooBig");
    throw error;
  } finally {
    if (temporary) rmSync(temporary, { recursive: true, force: true });
  }
}

/** The handler groups a request can be routed to, by name. */
type Handlers = {
  jobs: HandlerMap;
  engines: ReturnType<typeof engineHandlers>;
  sources: ReturnType<typeof sourceHandlers>;
  chats: ReturnType<typeof chatHandlers>;
  profile: ReturnType<typeof profileHandlers>;
  plans: ReturnType<typeof planHandlers>;
  study: ReturnType<typeof studyHandlers>;
  maps: ReturnType<typeof mapHandlers>;
  tools: ReturnType<typeof toolHandlers>;
};

function boundHandlers(): { [K in keyof Handlers]: Handlers[K] | null } {
  return { jobs: handlers, engines, sources, chats, profile, plans, study, maps, tools };
}

/**
 * Requests that only parse their input and pass it to one handler method: as is, with the request's abort signal
 * after it (`signal`), or with no argument after checking it (`bare`).
 */
type Route = readonly [keyof Handlers, string, ("signal" | "bare")?];
const routes = {
  "jobs.list": ["jobs", "list", "bare"],
  "jobs.finished": ["jobs", "finished", "bare"],
  "jobs.startDemo": ["jobs", "startDemo"],
  "jobs.cancel": ["jobs", "cancel"],
  "jobs.retry": ["jobs", "retry"],
  "jobs.resume": ["jobs", "resume"],
  "jobs.dismiss": ["jobs", "dismiss"],
  "engines.overview": ["engines", "overview", "bare"],
  "engines.acknowledge": ["engines", "acknowledge"],
  "engines.choice": ["engines", "choice", "bare"],
  "engines.choose": ["engines", "choose"],
  "engines.setEffort": ["engines", "setEffort"],
  "engines.features": ["engines", "features", "bare"],
  "engines.usage": ["engines", "usage"],
  "engines.autoConfigure": ["engines", "autoConfigure"],
  "engines.capability": ["engines", "capability"],
  "engines.local": ["engines", "local", "bare"],
  "engines.localPull": ["engines", "localPull", "bare"],
  "engines.localCancel": ["engines", "localCancel", "bare"],
  "engines.localCheck": ["engines", "localCheck", "bare"],
  "engines.localEnable": ["engines", "localEnable"],
  "study.lessonSection": ["study", "lessonSection", "signal"],
  "study.lessonAnswer": ["study", "lessonAnswer"],
  "study.markdown": ["study", "markdown"],
  "study.anki": ["study", "anki"],
  "study.ankiPreview": ["study", "ankiPreview"],
  "study.ankiImport": ["study", "ankiImport"],
  "study.csv": ["study", "csv"],
  "study.diagnosticStart": ["study", "diagnosticStart"],
  "study.quizStart": ["study", "quizStart"],
  "study.quizDraft": ["study", "quizDraft"],
  "study.quizRead": ["study", "quizRead"],
  "study.quizCheck": ["study", "quizCheck"],
  "study.quizCheckCancel": ["study", "quizCheckCancel"],
  "study.quizWrong": ["study", "quizWrong"],
  "study.diagnosticPreview": ["study", "diagnosticPreview"],
  "study.quizSubmit": ["study", "quizSubmit"],
  "study.quizGrading": ["study", "quizGrading"],
  "study.rateExercise": ["study", "rateExercise"],
  "study.flag": ["study", "flag"],
  "study.review": ["study", "review"],
  "study.reviewDiscard": ["study", "reviewDiscard"],
  "study.reviewSkipDrill": ["study", "reviewSkipDrill"],
  "study.activeSimulation": ["study", "activeSimulation", "bare"],
  "study.simulationStart": ["study", "simulationStart"],
  "study.simulationPrepare": ["study", "simulationPrepare"],
  "study.pastPapers": ["study", "pastPapers"],
  "study.pastPaperAdd": ["study", "pastPaperAdd"],
  "study.pastPaperRemove": ["study", "pastPaperRemove"],
  "study.pastPracticeStart": ["study", "pastPracticeStart"],
  "study.simulationBuild": ["study", "simulationBuild"],
  "study.simulationSubmit": ["study", "simulationSubmit"],
  "study.simulationRead": ["study", "simulationRead"],
  "study.attemptOutcome": ["study", "attemptOutcome"],
  "study.simulationDraft": ["study", "simulationDraft"],
  "study.cardsGenerate": ["study", "cardsGenerate"],
  "study.cardsBuild": ["study", "cardsBuild"],
  "study.cardsPlaces": ["study", "cardsPlaces"],
  "study.cardsPropose": ["study", "cardsPropose", "signal"],
  "study.cardsSaveProposed": ["study", "cardsSaveProposed"],
  "study.gapDrillStart": ["study", "gapDrillStart"],
  "study.gapDrillRead": ["study", "gapDrillRead"],
  "study.queue": ["study", "queue"],
  "study.cardSettings": ["study", "cardSettings", "bare"],
  "study.saveCardSettings": ["study", "saveCardSettings"],
  "study.save": ["study", "save"],
  "study.remove": ["study", "remove"],
  "study.suspend": ["study", "suspend"],
  "study.browse": ["study", "browse"],
  "study.mistakes": ["study", "mistakes"],
  "study.mistakesRedo": ["study", "mistakesRedo"],
  "study.restore": ["study", "restore"],
  "study.rate": ["study", "rate"],
  "study.undoRate": ["study", "undoRate"],
  "study.active": ["study", "active"],
  "tools.check": ["tools", "check"],
  "tools.runtime": ["tools", "runtime", "bare"],
  "tools.runtimeDownload": ["tools", "runtimeDownload", "bare"],
  "tools.python": ["tools", "python"],
  "maps.list": ["maps", "list"],
  "maps.export": ["maps", "export"],
  "maps.build": ["maps", "build"],
  "maps.generate": ["maps", "generate"],
  "maps.edit": ["maps", "edit", "signal"],
  "maps.open": ["maps", "open"],
  "maps.layout": ["maps", "layout"],
  "maps.move": ["maps", "move"],
  "maps.patch": ["maps", "patch"],
  "maps.redo": ["maps", "redo"],
  "maps.undo": ["maps", "undo"],
  "plans.build": ["plans", "build"],
  "plans.intro": ["plans", "intro"],
  "plans.calendar": ["plans", "calendar"],
  "subjects.add": ["plans", "addSubject"],
  "subjects.reorder": ["plans", "reorderSubjects"],
  "subjects.rename": ["plans", "renameSubject"],
  "subjects.remove": ["plans", "removeSubject"],
  "plans.archive": ["plans", "archive"],
  "plans.delete": ["plans", "delete"],
  "plans.footprint": ["plans", "footprint"],
  "plans.export": ["plans", "export"],
  "plans.import": ["plans", "import"],
  "plans.series": ["plans", "series"],
  "plans.planner": ["plans", "planner", "bare"],
  "plans.schedule": ["plans", "schedule"],
  "plans.plannerHours": ["plans", "plannerHours"],
  "plans.complete": ["plans", "complete"],
  "plans.attachSources": ["plans", "attachSources"],
  "plans.removeSource": ["plans", "removeSource"],
  "plans.item": ["plans", "item"],
  "plans.openQuiz": ["plans", "openQuiz"],
  "plans.settings": ["plans", "settings"],
  "plans.create": ["plans", "create", "signal"],
  "plans.proposeModules": ["plans", "proposeModules", "signal"],
  "plans.proposeTree": ["plans", "proposeTree", "signal"],
  "plans.rebuildStart": ["plans", "rebuildStart"],
  "plans.rebuildApply": ["plans", "rebuildApply"],
  "plans.rebuildDiscard": ["plans", "rebuildDiscard"],
  "plans.education": ["plans", "education"],
  "plans.setEducation": ["plans", "setEducation"],
  "profile.save": ["profile", "save"],
  "chats.list": ["chats", "list", "bare"],
  "chats.read": ["chats", "read"],
  "chats.seed": ["chats", "seed"],
  "chats.leave": ["chats", "leave"],
  "chats.clearContext": ["chats", "clearContext"],
  "chats.rate": ["chats", "rate"],
  "chats.rename": ["chats", "rename"],
  "chats.delete": ["chats", "remove"],
  "chats.search": ["chats", "search"],
  "chats.export": ["chats", "exportChat"],
  "sources.list": ["sources", "list", "bare"],
  "sources.import": ["sources", "importFile"],
  "sources.search": ["sources", "search", "signal"],
  "sources.chapters": ["sources", "chapters"],
  "sources.meta": ["sources", "meta"],
  "sources.details": ["sources", "details"],
  "sources.ocr": ["sources", "ocr"],
  "sources.paste": ["sources", "paste"],
  "sources.linkPreview": ["sources", "linkPreview", "signal"],
  "sources.link": ["sources", "link"],
  "sources.importBook": ["sources", "importBook", "signal"],
  "sources.updateBook": ["sources", "updateBook", "signal"],
  "sources.scanFolder": ["sources", "scanFolder", "signal"],
  "sources.preview": ["sources", "preview", "signal"],
  "sources.rename": ["sources", "rename"],
  "sources.replace": ["sources", "replace"],
  "sources.syllabus": ["sources", "syllabus", "signal"],
  "sources.reextract": ["sources", "reextract"],
  "sources.refresh": ["sources", "refresh", "signal"],
  "sources.unlockPdf": ["sources", "unlockPdf"],
  "sources.remove": ["sources", "remove"],
  "sources.promote": ["sources", "promote"],
  "sources.ocrDataState": ["sources", "ocrDataState", "bare"],
  "sources.ocrData": ["sources", "ocrData"],
  "sources.embedState": ["sources", "embedState", "bare"],
  "sources.embed": ["sources", "embed"],
  "sources.passage": ["sources", "passage"],
  "sources.viewerDocument": ["sources", "viewerDocument"],
  "sources.chapter": ["sources", "chapter"],
} as const;
type RoutedRequest = keyof typeof routes;

/** Requests that need more than a plain route: a stream, file grants, a fallback value or a narrowed type. */
const explicitRequests = [
  "engines.models",
  "engines.test",
  "engines.setFeature",
  "engines.remove",
  "engines.logout",
  "engines.update",
  "engines.login",
  "engines.install",
  "engines.cancelInstall",
  "engines.cancelLogin",
  "engines.sendCode",
  "study.lesson",
  "study.reviewSession",
  "study.simulationOpen",
  "study.cards",
  "study.suspended",
  "study.exercises",
  "tools.stagePng",
  "maps.all",
  "plans.list",
  "subjects.list",
  "plans.usage",
  "plans.freeSpace",
  "plans.importedFile",
  "plans.mastery",
  "plans.masteryBreakdown",
  "plans.simulations",
  "plans.recommend",
  "plans.today",
  "study.dueEverywhere",
  "plans.read",
  "plans.rebuildState",
  "profile.get",
  "chats.ask",
  "chats.regenerate",
  "sources.books",
] as const;
type ExplicitRequest = (typeof explicitRequests)[number];

/** Every request the contract names, for the test that each one is dispatched. */
export const dispatchedRequests: ReadonlySet<string> = new Set<string>([...Object.keys(routes), ...explicitRequests]);

// Each route names a method of its handler group that takes the request's parsed input (and the signal, if it asks).
type RouteFits<R extends RoutedRequest> = (typeof routes)[R] extends readonly [infer S extends keyof Handlers, infer M, ...infer Mode]
  ? M extends keyof Handlers[S]
    ? Handlers[S][M] extends (...args: infer A) => unknown
      ? Mode extends ["bare"]
        ? true
        : z.output<(typeof requests)[R]["input"]> extends A[0]
          ? Mode extends ["signal"]
            ? AbortSignal | undefined extends A[1] ? true : false
            : true
          : false
      : false
    : false
  : false;
type MisroutedRequest = { [R in RoutedRequest]: RouteFits<R> extends true ? never : R }[RoutedRequest];
type UndispatchedRequest = Exclude<RequestName, RoutedRequest | ExplicitRequest>;
type DoublyDispatched = RoutedRequest & ExplicitRequest;
const routesFit: [MisroutedRequest, UndispatchedRequest, DoublyDispatched] extends [never, never, never]
  ? true
  : [MisroutedRequest, UndispatchedRequest, DoublyDispatched] = true;
void routesFit;

async function dispatchValidated(
  name: string,
  input: unknown,
  signal?: AbortSignal,
  emit?: (event: unknown) => void,
): Promise<unknown> {
  if (!handlers) throw new IpcError("not-ready", "errors.notReady");
  // Own keys only: a name such as "toString" from the renderer is an unknown request, not a route.
  const route = Object.hasOwn(routes, name) ? (routes[name as RoutedRequest] as Route) : undefined;
  if (route) {
    const [space, method, mode] = route;
    const schema = requests[name as RoutedRequest].input;
    // A handler not bound yet answers undefined, as optional chaining on it did. A bare request still checks its input.
    const target = boundHandlers()[space] as unknown as Record<string, (...args: unknown[]) => unknown> | null;
    if (mode === "bare") {
      schema.parse(input);
      return target?.[method]!();
    }
    if (!target) return undefined;
    const parsed = schema.parse(input);
    return mode === "signal" ? target[method]!(parsed, signal) : target[method]!(parsed);
  }
  const request = name as ExplicitRequest;
  switch (request) {
    case "engines.models": {
      const parsed = requests["engines.models"].input.parse(input);
      return engines?.models({ provider: parsed.provider as ProviderId });
    }
    case "engines.test": {
      const parsed = requests["engines.test"].input.parse(input);
      return engines?.test(
        {
          provider: parsed.provider as ProviderId,
          model: parsed.model,
          effort: parsed.effort,
          fast: parsed.fast,
        },
        signal,
      );
    }
    case "engines.setFeature": {
      const parsed = requests["engines.setFeature"].input.parse(input);
      return engines?.setFeature({
        ...parsed,
        provider: parsed.provider as ProviderId,
      });
    }
    case "engines.remove": {
      const parsed = requests["engines.remove"].input.parse(input);
      return engines?.remove({ provider: parsed.provider as ProviderId });
    }
    case "engines.logout": {
      const parsed = requests["engines.logout"].input.parse(input);
      return engines?.logout({ provider: parsed.provider as ProviderId });
    }
    case "engines.update": {
      const parsed = requests["engines.update"].input.parse(input);
      return engines?.update({ provider: parsed.provider as ProviderId });
    }
    case "engines.login": {
      const parsed = requests["engines.login"].input.parse(input);
      return engines?.login({ provider: parsed.provider as ProviderId });
    }
    case "engines.install": {
      const parsed = requests["engines.install"].input.parse(input);
      return engines?.install({ provider: parsed.provider });
    }
    case "engines.cancelInstall": {
      const parsed = requests["engines.cancelInstall"].input.parse(input);
      return engines?.cancelInstall({ provider: parsed.provider });
    }
    case "engines.cancelLogin": {
      const parsed = requests["engines.cancelLogin"].input.parse(input);
      return engines?.cancelLogin({ provider: parsed.provider as ProviderId });
    }
    case "engines.sendCode": {
      const parsed = requests["engines.sendCode"].input.parse(input);
      return engines?.sendCode({
        provider: parsed.provider as ProviderId,
        code: parsed.code,
      });
    }
    case "study.lesson":
      return study?.lesson(requests["study.lesson"].input.parse(input), {
        signal,
        onDelta: (text) => emit?.({ type: "text", text }),
        onPassages: (passageIds, citations) => emit?.({ type: "sources", passageIds, citations }),
      });
    case "study.reviewSession":
      return (
        study?.reviewSession(
          requests["study.reviewSession"].input.parse(input),
        ) ?? null
      );
    case "study.simulationOpen":
      return (
        study?.simulationOpen(
          requests["study.simulationOpen"].input.parse(input),
        ) ?? null
      );
    case "study.cards":
      return study?.cards(requests["study.cards"].input.parse(input)) ?? [];
    case "study.suspended":
      return (
        study?.suspended(requests["study.suspended"].input.parse(input)) ?? []
      );
    case "study.exercises":
      return (
        study?.exercises(requests["study.exercises"].input.parse(input)) ?? {
          exercises: [],
          job: null,
        }
      );
    case "tools.stagePng": {
      const staged = tools?.stagePng(
        requests["tools.stagePng"].input.parse(input),
      );
      if (staged) fileGrants.add(pickedFileGrant(staged.path));
      return staged;
    }
    case "maps.all":
      return maps?.all(requests["maps.all"].input.parse(input)) ?? [];
    case "plans.list":
      requests["plans.list"].input.parse(input);
      return plans?.list() ?? [];
    case "subjects.list":
      requests["subjects.list"].input.parse(input);
      return plans?.subjects() ?? [];
    case "plans.usage":
      requests["plans.usage"].input.parse(input);
      return plans?.usage() ?? [];
    case "plans.freeSpace":
      requests["plans.freeSpace"].input.parse(input);
      return plans?.freeSpace() ?? { bytes: 0 };
    case "plans.importedFile":
      return plans?.importedFile(requests["plans.importedFile"].input.parse(input)) ?? null;
    case "plans.mastery":
      return plans?.mastery(requests["plans.mastery"].input.parse(input)) ?? [];
    case "plans.masteryBreakdown":
      return (
        plans?.masteryBreakdown(
          requests["plans.masteryBreakdown"].input.parse(input),
        ) ?? []
      );
    case "plans.simulations":
      return (
        plans?.simulations(requests["plans.simulations"].input.parse(input)) ??
        []
      );
    case "plans.recommend":
      return (
        plans?.recommend(requests["plans.recommend"].input.parse(input)) ?? null
      );
    case "plans.today":
      requests["plans.today"].input.parse(input);
      return plans?.today() ?? { planned: false, behind: [], cards: null, items: [] };
    case "study.dueEverywhere":
      requests["study.dueEverywhere"].input.parse(input);
      return plans?.dueEverywhere() ?? [];
    case "plans.read":
      return plans?.read(requests["plans.read"].input.parse(input)) ?? null;
    case "plans.rebuildState":
      return (
        plans?.rebuildState(requests["plans.rebuildState"].input.parse(input)) ??
        null
      );
    case "profile.get":
      requests["profile.get"].input.parse(input);
      return profile?.get() ?? null;
    case "chats.ask":
      return chats?.ask({
        ...requests["chats.ask"].input.parse(input),
        signal,
        onDelta: (text) => emit?.({ type: "text", text }),
        onPassages: (passages) => emit?.({ type: "passages", passages }),
        onQuestion: (id, chatId) => emit?.({ type: "question", id, chatId }),
      });
    case "chats.regenerate":
      return chats?.regenerate({
        ...requests["chats.regenerate"].input.parse(input),
        signal,
        onDelta: (text) => emit?.({ type: "text", text }),
        onPassages: (passages) => emit?.({ type: "passages", passages }),
      });
    case "sources.books":
      requests["sources.books"].input.parse(input);
      return sources?.books(signal);
    default: {
      const unhandled: never = request;
      void unhandled;
      throw new IpcError("unknown-request", "errors.unknownRequest");
    }
  }
}

export function bindRunner(runner: Runner, dev: boolean): void {
  jobRunner = runner;
  setJobHandlers(jobHandlers(runner, dev));
}

export function removeEngineSelections(provider: string): void {
  engines?.remove({ provider: provider as ProviderId });
}

/** Recomputes automatic engine choices in the background. Never calls a model. */
export function refreshAutoEngines(): void {
  void engines?.autoConfigure({}).catch(() => undefined);
}

export function bindEngines(
  db: Parameters<typeof engineHandlers>[0],
  installerFixture?: string,
): void {
  configureDisclosure(db);
  // A refused sign-in outlasts a restart. When one starts or ends, Settings shows it and the automatic plan follows.
  configureSignOuts(signOutStore(db), (provider) => {
    broadcast("engine.status", { provider });
    void engines?.signInChanged().catch(() => undefined);
  });
  setFallbackListener((event) => {
    broadcast("engine.fallback", event);
    // A call a job made: the finished job tells which engine answered.
    const jobId = currentUsageScope()?.jobId;
    if (jobId) jobRunner?.noteFallback(jobId, event);
    // A refused model leaves the automatic choice, so the tasks that used it move now and Settings shows the new one.
    if (event.reason === "model") refreshAutoEngines();
  });
  setUsageRecorder((usage, where) => {
    // Counting is bookkeeping: a write that fails must not fail the answer it counts.
    try {
      storeUsage(db, usage, where);
    } catch (err) {
      console.error("pyxis: token usage not stored", err);
    }
  });
  engines = engineHandlers(db, (event) => broadcast("engine.login", event), {
    auto: true,
    onAuto: () => broadcast("engine.auto", {}),
    onInstallLog: (event) => broadcast("engine.install", event),
    onLocal: (event) => broadcast("engine.local", event),
    installerFixture,
  });
}

export function bindStudy(
  db: Parameters<typeof studyHandlers>[0],
  runner?: Parameters<typeof studyHandlers>[1],
  run?: Parameters<typeof studyHandlers>[2],
  simulationRun?: Parameters<typeof studyHandlers>[3],
): void {
  study = studyHandlers(db, runner, run, simulationRun);
}

export function bindTools(workspace = "", runner?: Runner): void {
  if (runner) registerRuntimeJob(runner);
  tools = toolHandlers(workspace, runner);
}

export function bindMaps(
  db: Parameters<typeof mapHandlers>[0],
  runner: Runner,
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

export function bindProfile(
  db: Parameters<typeof profileHandlers>[0],
  onSaved?: Parameters<typeof profileHandlers>[1],
): void {
  profile = profileHandlers(db, onSaved);
}

export function bindChat(
  db: Parameters<typeof chatHandlers>[0],
  workspace = "",
  fixtureReply?: string,
  replyDelayMs = 0,
): void {
  chats = chatHandlers(db, workspace, fixtureReply, replyDelayMs);
  setChecksListener((event) => broadcast("chats.checks", event));
}

export function bindSources(
  db: Parameters<typeof sourceHandlers>[0],
  workspace: string,
  runner: Runner,
  booksTransport?: BooksTransport,
): void {
  fileScratch = join(workspace, "scratch");
  sources = sourceHandlers(
    db,
    workspace,
    runner,
    (path) => fileGrants.file(path),
    undefined,
    booksTransport,
  );
}
