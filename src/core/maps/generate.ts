import type Database from "better-sqlite3";
import { z } from "zod";
import { uuidv7 } from "../../shared/ids";
import { IpcError } from "../../shared/ipc";
import { MAP_INSTRUCTION_MAX, MAP_LIMITS, mapOpSchema } from "../../shared/concept-map";
import { generate, type GenerateInput } from "../engine/generate";
import {
  contentLanguage,
  languageName,
  planLanguage,
  promptProvenance,
  systemPrompt,
} from "../engine/prompts";
import { selectionFor, type StoredSelection } from "../engine/selection";
import type { Runner } from "../jobs/runner";
import { aboutPlan } from "../study/jobAbout";
import {
  applyOps,
  layoutGraph,
  validateGraph,
  type ConceptGraph,
} from "./graph";
import {
  listMaps,
  deleteMap,
  readStoredMap,
  storeMap,
  type StoredMap,
} from "./store";
import { mergeGraphs } from "./merge";
import { isTopicScope, requireScope, type MapScope } from "./scope";
import { subjectPassages } from "./subject-sources";

type Input = MapScope;
type Passage = { id: string; text: string; section: string };
type Part = { title: string; passages: Passage[] };
/** What a part's model call gave, kept in the job until every part is read and the parts join into one map. */
type Built = {
  passageIds: string[];
  /** Null when a part of a focused request answered that it has nothing for the request. */
  graph: ConceptGraph | null;
  provider: string;
  model: string;
};
type Params = {
  input: Input;
  parts: Part[];
  selection: StoredSelection;
  language: string;
  /** How many parts are read; the next one is `parts[next]`. */
  next: number;
  /** The ID the finished map gets, so a resumed build writes the same map. Jobs saved before one map per request have none. */
  mapId?: string;
  /** The read parts, in order. Jobs saved before one map per request have none. */
  built?: Built[];
  /** What the student asked for ("only the theorems, with proofs"), trimmed and never empty. It goes to every part's call. */
  instruction?: string;
};
/** What a map is made of. A request without an instruction needs at least eight concepts; one with it may be smaller. */
function mapShape(minNodes: number) {
  return z.object({
    nodes: z
      .array(
        z.object({
          id: z.string().min(1).max(160),
          label: z.string().trim().min(1).max(500),
          parent: z.string().nullable(),
          sources: z.array(z.string()).max(24),
        }),
      )
      .min(minNodes)
      .max(25),
    edges: z
      .array(
        z.object({
          from: z.string(),
          to: z.string(),
          label: z.string().max(160).optional(),
        }),
      )
      .max(150),
  });
}
type Generated = z.infer<ReturnType<typeof mapShape>>;
function graphOf(value: Generated): ConceptGraph {
  const edges = [...value.edges];
  for (const node of value.nodes)
    if (
      node.parent &&
      !edges.some((edge) => edge.from === node.parent && edge.to === node.id)
    )
      edges.push({ from: node.parent, to: node.id });
  return {
    layout: "tree",
    undo: null,
    nodes: value.nodes.map((node) => ({ ...node, x: 0, y: 0, pinned: false })),
    edges,
  };
}
/** The instruction as a request carries it: trimmed, with an empty one meaning none, and no longer than an edit's. */
function cleanInstruction(instruction: string | undefined): string | undefined {
  const text = instruction?.trim();
  if (text && text.length > MAP_INSTRUCTION_MAX) throw new Error("map-instruction");
  return text || undefined;
}
export function prepareMaps(db: Database.Database, input: Input, instruction?: string): Params {
  requireScope(db, input);
  const params = isTopicScope(input) ? prepareTopicMap(db, input) : prepareSubjectMap(db, input);
  const text = cleanInstruction(instruction);
  return text ? { ...params, instruction: text } : params;
}
function prepareTopicMap(db: Database.Database, input: Input & { planId: string; topicId: string }): Params {
  const topic = db
    .prepare(
      "SELECT t.title, p.content_language AS language FROM topics t JOIN plans p ON p.id = t.plan_id WHERE t.id = ? AND p.id = ?",
    )
    .get(input.topicId, input.planId) as {
    title: string;
    language: string | null;
  };
  const rows = db
    .prepare(
      "SELECT p.id, p.text, p.section_path FROM topic_passages tp JOIN passages p ON p.id = tp.passage_id WHERE tp.topic_id = ? ORDER BY p.created_at, p.id",
    )
    .all(input.topicId) as Array<{
    id: string;
    text: string;
    section_path: string | null;
  }>;
  const units = rows.flatMap((row) => {
    const result: Passage[] = [];
    for (let at = 0; at < row.text.length; at += 8000)
      result.push({
        id: row.id,
        text: row.text.slice(at, at + 8000),
        section: row.section_path ?? topic.title,
      });
    if (!result.length)
      result.push({
        id: row.id,
        text: "",
        section: row.section_path ?? topic.title,
      });
    return result;
  });
  const parts: Part[] = [];
  let current: Passage[] = [],
    size = 0;
  const push = () => {
    if (current.length)
      parts.push({
        title: current[0]!.section,
        passages: current,
      });
    current = [];
    size = 0;
  };
  for (const unit of units) {
    if (
      current.length &&
      (size + unit.text.length > 18000 ||
        current.length >= 24 ||
        (current[0]!.section !== unit.section && current.length >= 8))
    )
      push();
    current.push(unit);
    size += unit.text.length;
  }
  push();
  if (!parts.length)
    parts.push({ title: topic.title, passages: [] });
  // One part is the whole topic, so its root is the topic; the model names the root of each of several parts itself.
  if (parts.length === 1) parts[0]!.title = topic.title;
  return {
    input,
    parts,
    selection: selectionFor(db, "map"),
    language: contentLanguage(db, topic.language),
    next: 0,
    mapId: uuidv7(),
    built: [],
  };
}
/**
 * A request gets one map. A topic's material may be read in several parts, which join into that one map afterwards. A
 * whole subject gets its map built in one call from passages spread over all its sources (`subjectPassages`). The
 * profile's content language is used, since a subject has no exam that sets one.
 */
function prepareSubjectMap(db: Database.Database, input: { subjectId: string }): Params {
  const name = db.prepare("SELECT name FROM subjects WHERE id = ?").pluck().get(input.subjectId) as string;
  return {
    input,
    parts: [{ title: name, passages: subjectPassages(db, input.subjectId) }],
    selection: selectionFor(db, "map"),
    language: contentLanguage(db),
    next: 0,
    mapId: uuidv7(),
    built: [],
  };
}
async function buildPart(
  part: Part,
  params: Params,
  title: string,
  position: number,
  run?: GenerateInput["run"],
  signal?: AbortSignal,
) {
  const ids = new Set(part.passages.map((passage) => passage.id));
  const check = (value: Generated, ctx: z.RefinementCtx) => {
    try {
      validateGraph(graphOf(value));
    } catch {
      ctx.addIssue({
        code: "custom",
        message:
          "Nodes need one root, unique IDs, valid parents, an acyclic tree and valid unique edge references",
      });
    }
    const covered = new Set(value.nodes.flatMap((node) => node.sources));
    // A map made on request may leave out what the request does not ask for; one without covers every passage.
    if (!params.instruction)
      for (const id of ids)
        if (!covered.has(id))
          ctx.addIssue({ code: "custom", message: `Missing passage ${id}` });
    if ([...covered].some((id) => !ids.has(id)))
      ctx.addIssue({ code: "custom", message: "Unknown passage ID" });
    if (ids.size && value.nodes.some((node) => !node.sources.length))
      ctx.addIssue({
        code: "custom",
        message: "Each grounded node needs source passages",
      });
  };
  // A request with an instruction may find nothing for it in this part, so its answer is either a (possibly small) map
  // or an explicit "nothing". The answer sits under `result` because a strict structured-output schema needs an object
  // at its root. A request without one keeps the plain schema: every part must give a map of at least eight concepts.
  const schema = params.instruction
    ? z.object({
        result: z.discriminatedUnion("kind", [
          mapShape(2).extend({ kind: z.literal("map") }).superRefine(check),
          z.object({ kind: z.literal("nothing") }),
        ]),
      })
    : mapShape(8).superRefine(check);
  const result = await generate({
    selection: params.selection,
    run,
    signal,
    schema,
    system: systemPrompt("map.generate", {
      contentLanguage: languageName(params.language),
    }),
    // The topic's title always goes in. Several parts add which one this is, and the model then names its root for what
    // the part covers, since the root becomes a main branch of the map with that title.
    prompt: JSON.stringify({
      title,
      ...(params.parts.length > 1 ? { part: position + 1, of: params.parts.length } : {}),
      ...(params.instruction ? { instruction: params.instruction } : {}),
      language: params.language,
      passages: part.passages,
    }),
  });
  const answer = params.instruction
    ? (result.data as { result: { kind: "map" | "nothing" } & Partial<Generated> }).result
    : (result.data as Generated);
  if ("kind" in answer && answer.kind === "nothing")
    return { passageIds: [], graph: null, provider: result.provider, model: result.model };
  const value = answer as Generated;
  return {
    // A map made on request lists only the passages its concepts cite.
    passageIds: params.instruction
      ? [...ids].filter((id) => value.nodes.some((node) => node.sources.includes(id)))
      : [...ids],
    graph: graphOf(value),
    provider: result.provider,
    model: result.model,
  };
}
/** The topic's or subject's own name, which the finished map's root and title take. */
function scopeTitle(db: Database.Database, input: Input): string {
  return (
    isTopicScope(input)
      ? db.prepare("SELECT title FROM topics WHERE id = ?").pluck().get(input.topicId)
      : db.prepare("SELECT name FROM subjects WHERE id = ?").pluck().get(input.subjectId)
  ) as string;
}
/** Joins the parts that gave a map; a part of a focused request that found nothing is left out. */
function joinParts(db: Database.Database, params: Params, built: Built[]): StoredMap {
  const title = scopeTitle(db, params.input);
  const given = built.filter((part): part is Built & { graph: ConceptGraph } => part.graph !== null);
  const passageIds = [...new Set(given.flatMap((part) => part.passageIds))];
  return {
    id: params.mapId!,
    title,
    passageIds,
    graph: layoutGraph(
      mergeGraphs(
        title,
        given.map((part) => part.graph),
      ),
    ),
    provider: given[0]!.provider,
    model: given[0]!.model,
    prompt: promptProvenance("map.generate"),
    grounding: passageIds.length ? "sources" : "general",
    ...(params.instruction ? { instruction: params.instruction } : {}),
  };
}
export function registerMapJobs(
  db: Database.Database,
  runner: Runner,
  run?: GenerateInput["run"],
): void {
  runner.register("map-build", {
    about: (params) => aboutScope(db, (params as Params).input),
    // The scope, so the jobs list can open the map page of a request that found nothing: `map:<subjectId>` or
    // `map:<planId>:<topicId>`.
    ref: (params) => {
      const input = (params as Params).input;
      return isTopicScope(input) ? `map:${input.planId}:${input.topicId}` : `map:${input.subjectId}`;
    },
    retryParams: (params) => ({ ...(params as Params), selection: selectionFor(db, "map") }),
    jobClass: "model-cli",
    steps: [
      {
        name: "maps",
        label: "jobs.maps",
        async run(ctx) {
          const params = ctx.params as Params;
          // A job saved before one map per request has parts stored as maps of their own; it reads every part again.
          if (!params.built || !params.mapId) {
            params.built = [];
            params.mapId = uuidv7();
            params.next = 0;
          }
          const title = scopeTitle(db, params.input);
          while (params.next < params.parts.length) {
            ctx.signal.throwIfAborted();
            const built = await buildPart(
              params.parts[params.next]!,
              params,
              title,
              params.next,
              run,
              ctx.signal,
            );
            ctx.signal.throwIfAborted();
            params.built.push(built);
            params.next++;
            ctx.setParams(params);
          }
          ctx.signal.throwIfAborted();
          // Every part of a focused request found nothing for it: no map is stored, and the build ends saying so. A retry
          // reads nothing again, since the parts are done; other words are another request.
          if (params.built.every((part) => part.graph === null)) throw new Error("map-nothing-matched");
          storeMap(db, params.input, joinParts(db, params, params.built));
          return true;
        },
      },
    ],
  });
}
/** What the jobs list says a map build is about: the exam and topic, or the subject. */
function aboutScope(db: Database.Database, input: Input) {
  if (isTopicScope(input)) return aboutPlan(db, input.planId, input.topicId);
  const subject = db.prepare("SELECT name FROM subjects WHERE id = ?").pluck().get(input.subjectId) as
    | string
    | undefined;
  return subject ? { topic: subject } : {};
}
/**
 * The scope's newest map-build job, as `columns`, or the scope's job `jobId` when one is given. A subject's job has no
 * topic in its params. `instruction` narrows it to the builds that were asked for with that instruction ("" for none);
 * left out, any build counts.
 */
function latestBuild<T>(
  db: Database.Database,
  input: Input,
  columns: string,
  instruction?: string,
  jobId?: string,
): T | undefined {
  // Without a job named, a build the student gave up (cleared from Attività, or the build of a map they deleted) is not
  // the scope's build any more: the page does not offer to resume it, and a new request starts afresh.
  const asked =
    (instruction === undefined ? "" : " AND COALESCE(json_extract(params_json, '$.instruction'), '') = ?") +
    (jobId === undefined ? " AND NOT (dismissed = 1 AND state <> 'succeeded')" : " AND id = ?");
  const extra = [...(instruction === undefined ? [] : [instruction]), ...(jobId === undefined ? [] : [jobId])];
  return (
    isTopicScope(input)
      ? db
          .prepare(
            `SELECT ${columns} FROM jobs WHERE kind = 'map-build' AND json_extract(params_json, '$.input.planId') = ? AND json_extract(params_json, '$.input.topicId') = ?${asked} ORDER BY created_at DESC, rowid DESC LIMIT 1`,
          )
          .get(input.planId, input.topicId, ...extra)
      : db
          .prepare(
            `SELECT ${columns} FROM jobs WHERE kind = 'map-build' AND json_extract(params_json, '$.input.subjectId') = ? AND json_extract(params_json, '$.input.topicId') IS NULL${asked} ORDER BY created_at DESC, rowid DESC LIMIT 1`,
          )
          .get(input.subjectId, ...extra)
  ) as T | undefined;
}
/**
 * Starts the build of a request. A request without an instruction gets one map per topic or subject: an earlier build of
 * the scope is returned, or retried or resumed when it stopped. A request with an instruction asks for a different map,
 * so a build that finished does not answer it and a new map is added next to the others; only a build still waiting or
 * running for the same scope and the same instruction is the same request, and one that stopped is picked up again.
 */
export function enqueueMaps(
  db: Database.Database,
  runner: Runner,
  input: Input,
  instruction?: string,
) {
  requireScope(db, input);
  const text = cleanInstruction(instruction);
  const existing = latestBuild<{ id: string; state: string; mapId: string | null }>(
    db,
    input,
    "id, state, json_extract(params_json, '$.mapId') AS mapId",
    text ?? "",
  );
  const maps = listMaps(db, input);
  // A finished build answers a plain request only while its map is there: once the student deleted it, a new one is built.
  const answered =
    existing?.state === "succeeded" &&
    !text &&
    (existing.mapId ? maps.some((map) => map.id === existing.mapId) : maps.length > 0);
  if (existing && (existing.state !== "succeeded" || answered)) {
    if (existing.state === "failed" || existing.state === "cancelled")
      runner.retry(existing.id);
    else if (existing.state === "interrupted") runner.resume(existing.id);
    return { jobId: existing.id, maps };
  }
  const params = prepareMaps(db, input, text);
  const jobId = runner.start("map-build", params);
  return { jobId, maps };
}
export async function editMap(
  db: Database.Database,
  input: Input & { mapId?: string; instruction: string },
  run?: GenerateInput["run"],
  signal?: AbortSignal,
) {
  const stored = readStoredMap(db, input, input.mapId);
  if (!stored) throw new Error("map-missing");
  if (!input.instruction.trim() || input.instruction.length > MAP_INSTRUCTION_MAX)
    throw new Error("map-instruction");
  const schema = z
    .object({ ops: z.array(mapOpSchema).min(1).max(50) })
    .superRefine((value, ctx) => {
      try {
        applyOps(stored.graph, value.ops);
      } catch {
        ctx.addIssue({
          code: "custom",
          message:
            `Patch refers to invalid IDs, removes the root, or exceeds the ${MAP_LIMITS.nodes}-node limit`,
        });
      }
    });
  const result = await generate({
    selection: selectionFor(db, "map"),
    run,
    signal,
    schema,
    system: systemPrompt("map.edit", {
      contentLanguage: isTopicScope(input)
        ? planLanguage(db, input.planId)
        : contentLanguage(db),
    }),
    prompt: JSON.stringify({
      instruction: input.instruction,
      graph: { ...stored.graph, undo: null, redo: null },
    }),
  });
  // The student may have moved, renamed or undone something while the model wrote. The model's operations name nodes
  // by id, so they are applied to the map as it is now; that keeps the student's changes and puts the edit on top.
  return db.transaction(() => {
    const current = readStoredMap(db, input, stored.id);
    if (!current) throw editConflict();
    let next: ConceptGraph;
    try {
      next = applyOps(
        current.graph,
        (result.data as z.infer<typeof schema>).ops,
      );
    } catch {
      throw editConflict();
    }
    storeMap(db, input, { ...current, graph: next });
    return next;
  })();
}
/** The map changed while the model was editing, in a way the edit no longer fits (a node it names is gone). */
function editConflict() {
  return new IpcError("map-edit-conflict", "map.editConflict");
}

/**
 * Deletes one map of the scope and gives up every build of it, so a build still writing it or stopped on the way stops
 * and leaves Attività, and none can bring it back. `jobId` names a map still being written, which has no map yet: its
 * build's map is the one deleted. Says whether a stored map was removed.
 */
export function deleteMapAndBuilds(
  db: Database.Database,
  runner: Runner,
  input: Input,
  target: { mapId?: string; jobId?: string },
): boolean {
  requireScope(db, input);
  const build = target.jobId
    ? latestBuild<{ mapId: string | null }>(db, input, "json_extract(params_json, '$.mapId') AS mapId", undefined, target.jobId)
    : undefined;
  const mapId = target.mapId ?? build?.mapId ?? undefined;
  const builds = isTopicScope(input)
    ? (db
        .prepare(
          "SELECT id FROM jobs WHERE kind = 'map-build' AND state <> 'succeeded' AND json_extract(params_json, '$.input.planId') = ? AND json_extract(params_json, '$.input.topicId') = ? AND (id = ? OR json_extract(params_json, '$.mapId') = ?)",
        )
        .pluck()
        .all(input.planId, input.topicId, target.jobId ?? null, mapId ?? null) as string[])
    : (db
        .prepare(
          "SELECT id FROM jobs WHERE kind = 'map-build' AND state <> 'succeeded' AND json_extract(params_json, '$.input.subjectId') = ? AND json_extract(params_json, '$.input.topicId') IS NULL AND (id = ? OR json_extract(params_json, '$.mapId') = ?)",
        )
        .pluck()
        .all(input.subjectId, target.jobId ?? null, mapId ?? null) as string[]);
  // The builds stop first: a running one checks its signal right before it stores the map, so it never stores it now.
  for (const id of builds) runner.discard(id);
  // A map already gone counts as deleted: the student wanted it gone, and it is.
  return mapId ? deleteMap(db, input, mapId) : false;
}
/**
 * How a map build is going: the build `jobId` when the page asks for one (the job `maps.generate` returned, which is not
 * always the scope's newest), else the scope's newest. `mapId` is the map a finished build stored; builds that finish in
 * another order than they started add their maps in that order, so the last map of the scope is not this build's.
 */
export function mapBuild(db: Database.Database, input: Input, jobId?: string) {
  requireScope(db, input);
  const row = latestBuild<{
    jobId: string;
    state: string;
    progress: number;
    stepLabel: string | null;
    error: string | null;
    instruction: string | null;
    mapId: string | null;
  }>(
    db,
    input,
    "id AS jobId, state, CASE WHEN state = 'succeeded' THEN 1 ELSE COALESCE(1.0 * json_extract(params_json, '$.next') / NULLIF(json_array_length(params_json, '$.parts'), 0), progress) END AS progress, step_label AS stepLabel, error, json_extract(params_json, '$.instruction') AS instruction, CASE WHEN state = 'succeeded' THEN json_extract(params_json, '$.mapId') END AS mapId",
    undefined,
    jobId,
  );
  return row ?? null;
}
