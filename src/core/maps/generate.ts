import type Database from "better-sqlite3";
import { z } from "zod";
import { uuidv7 } from "../../shared/ids";
import { mapOpSchema } from "../../shared/concept-map";
import { generate, type GenerateInput } from "../engine/generate";
import {
  contentLanguage,
  languageName,
  planLanguage,
  promptProvenance,
  systemPrompt,
} from "../engine/prompts";
import { selectionFor, type StoredSelection } from "../engine/selection";
import { requireTopic } from "../study/openLesson";
import type { Runner } from "../jobs/runner";
import {
  applyOps,
  layoutGraph,
  validateGraph,
  type ConceptGraph,
} from "./graph";
import {
  listTopicMaps,
  readStoredMap,
  storeMap,
  type StoredMap,
} from "./store";

type Input = { planId: string; topicId: string };
type Passage = { id: string; text: string; section: string };
type Part = { id: string; title: string; passages: Passage[] };
type Params = {
  input: Input;
  parts: Part[];
  selection: StoredSelection;
  language: string;
  next: number;
};
const generatedSchema = z.object({
  title: z.string().trim().min(1).max(200),
  nodes: z
    .array(
      z.object({
        id: z.string().min(1).max(160),
        label: z.string().trim().min(1).max(500),
        parent: z.string().nullable(),
        sources: z.array(z.string()).max(24),
      }),
    )
    .min(8)
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
function graphOf(value: z.infer<typeof generatedSchema>): ConceptGraph {
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
export function prepareMaps(db: Database.Database, input: Input): Params {
  requireTopic(db, input.planId, input.topicId);
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
        id: uuidv7(),
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
    parts.push({ id: uuidv7(), title: topic.title, passages: [] });
  return {
    input,
    parts,
    selection: selectionFor(db, "map"),
    language: contentLanguage(db, topic.language),
    next: 0,
  };
}
async function buildPart(
  part: Part,
  params: Params,
  run?: GenerateInput["run"],
  signal?: AbortSignal,
) {
  const ids = new Set(part.passages.map((passage) => passage.id));
  const schema = generatedSchema.superRefine((value, ctx) => {
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
  });
  const result = await generate({
    selection: params.selection,
    run,
    signal,
    schema,
    system: systemPrompt("map.generate", {
      contentLanguage: languageName(params.language),
    }),
    prompt: JSON.stringify({
      title: part.title,
      language: params.language,
      passages: part.passages,
    }),
  });
  const value = result.data as z.infer<typeof generatedSchema>;
  return {
    id: part.id,
    title: value.title,
    passageIds: [...ids],
    graph: layoutGraph(graphOf(value)),
    provider: result.provider,
    model: result.model,
    prompt: promptProvenance("map.generate"),
    grounding: ids.size ? ("sources" as const) : ("general" as const),
  };
}
export function registerMapJobs(
  db: Database.Database,
  runner: Runner,
  run?: GenerateInput["run"],
): void {
  runner.register("map-build", {
    retryParams: (params) => ({ ...(params as Params), selection: selectionFor(db, "map") }),
    jobClass: "model-cli",
    steps: [
      {
        name: "maps",
        label: "jobs.maps",
        async run(ctx) {
          const params = ctx.params as Params;
          while (params.next < params.parts.length) {
            ctx.signal.throwIfAborted();
            const part = params.parts[params.next]!;
            const done = listTopicMaps(
              db,
              params.input.planId,
              params.input.topicId,
            ).some((map) => map.id === part.id);
            if (!done) {
              const map = await buildPart(part, params, run, ctx.signal);
              ctx.signal.throwIfAborted();
              db.transaction(() => {
                storeMap(db, params.input.planId, params.input.topicId, map);
                params.next++;
                ctx.setParams(params);
              })();
            } else {
              params.next++;
              ctx.setParams(params);
            }
          }
          return true;
        },
      },
    ],
  });
}
export function enqueueMaps(
  db: Database.Database,
  runner: Runner,
  input: Input,
) {
  requireTopic(db, input.planId, input.topicId);
  const existing = db
    .prepare(
      "SELECT id, state FROM jobs WHERE kind = 'map-build' AND json_extract(params_json, '$.input.planId') = ? AND json_extract(params_json, '$.input.topicId') = ? ORDER BY created_at DESC LIMIT 1",
    )
    .get(input.planId, input.topicId) as
    { id: string; state: string } | undefined;
  if (existing) {
    if (existing.state === "failed" || existing.state === "cancelled")
      runner.retry(existing.id);
    else if (existing.state === "interrupted") runner.resume(existing.id);
    return {
      jobId: existing.id,
      maps: listTopicMaps(db, input.planId, input.topicId),
    };
  }
  const maps = listTopicMaps(db, input.planId, input.topicId);
  const params = prepareMaps(db, input);
  const jobId = runner.start("map-build", params);
  return { jobId, maps };
}
export async function generateMaps(
  db: Database.Database,
  input: Input,
  run?: GenerateInput["run"],
) {
  const maps = listTopicMaps(db, input.planId, input.topicId);
  if (maps.some((map) => map.provider)) return { maps };
  const params = prepareMaps(db, input);
  const built: StoredMap[] = [];
  for (const part of params.parts)
    built.push(await buildPart(part, params, run));
  db.transaction(() => {
    for (const map of built) storeMap(db, input.planId, input.topicId, map);
  })();
  return { maps: listTopicMaps(db, input.planId, input.topicId) };
}
export async function editMap(
  db: Database.Database,
  input: Input & { mapId?: string; instruction: string },
  run?: GenerateInput["run"],
) {
  const stored = readStoredMap(db, input.planId, input.topicId, input.mapId);
  if (!stored) throw new Error("map-missing");
  if (!input.instruction.trim() || input.instruction.length > 2000)
    throw new Error("map-instruction");
  const original = JSON.stringify(stored.graph);
  const schema = z
    .object({ ops: z.array(mapOpSchema).min(1).max(50) })
    .superRefine((value, ctx) => {
      try {
        applyOps(stored.graph, value.ops);
      } catch {
        ctx.addIssue({
          code: "custom",
          message:
            "Patch refers to invalid IDs, removes the root, or exceeds the 25-node limit",
        });
      }
    });
  const result = await generate({
    selection: selectionFor(db, "map"),
    run,
    schema,
    system: systemPrompt("map.edit", {
      contentLanguage: planLanguage(db, input.planId),
    }),
    prompt: JSON.stringify({
      instruction: input.instruction,
      graph: { ...stored.graph, undo: null },
    }),
  });
  return db.transaction(() => {
    const current = readStoredMap(db, input.planId, input.topicId, stored.id);
    if (!current || JSON.stringify(current.graph) !== original)
      throw new Error("map-changed");
    const next = applyOps(
      current.graph,
      (result.data as z.infer<typeof schema>).ops,
    );
    storeMap(db, input.planId, input.topicId, { ...current, graph: next });
    return next;
  })();
}

export function mapBuild(db: Database.Database, input: Input) {
  requireTopic(db, input.planId, input.topicId);
  const row = db
    .prepare(
      "SELECT id AS jobId, state, CASE WHEN state = 'succeeded' THEN 1 ELSE COALESCE(1.0 * json_extract(params_json, '$.next') / NULLIF(json_array_length(params_json, '$.parts'), 0), progress) END AS progress, step_label AS stepLabel, error FROM jobs WHERE kind = 'map-build' AND json_extract(params_json, '$.input.planId') = ? AND json_extract(params_json, '$.input.topicId') = ? ORDER BY created_at DESC LIMIT 1",
    )
    .get(input.planId, input.topicId) as
    | {
        jobId: string;
        state: string;
        progress: number;
        stepLabel: string | null;
        error: string | null;
      }
    | undefined;
  return row ?? null;
}
