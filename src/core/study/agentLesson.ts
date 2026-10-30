import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import { generate } from "../engine/generate";
import { endConversation } from "../engine/funnel";
import { systemPrompt, templateVersion } from "../engine/prompts";
import { selectionFor } from "../engine/selection";
import { interestsLine } from "../profile/context";
import { retrieve } from "../sources/retrieve";
import { figureRunner, type FigureRunner } from "../math/figures";
import { IpcError, isAbort } from "../../shared/ipc";
import { smartSections } from "../../shared/smart-text";
import { cacheKey, loadLesson, saveLesson } from "./lesson";
import {
  lessonSystem,
  lessonText,
  modelContext,
  openLesson,
  withFigures,
  writeLesson,
  type LessonResult,
  type Wording,
} from "./openLesson";

/**
 * Prototype: a lesson written by an agent loop instead of the fixed pipeline in `openLesson.ts`. The model gets
 * read-only study tools over the student's sources (an outline, read a section, search, read passages) through a text
 * protocol: it replies with a ```pyxis-tool block, core runs the calls and sends the results back in the same
 * conversation. Every engine cli-funnel reaches can do this at access `none`, so the model never gets the machine.
 * Only a developer build with PYXIS_AGENT_LESSON=1 uses it; see docs/agent-lesson.md.
 */

const AGENT_VERSION = templateVersion("lesson.agent");

export type AgentLimits = {
  /** Tool calls in the whole lesson, refused ones included. */
  calls: number;
  /** Calls the model may put in one reply; the rest are refused. */
  callsPerTurn: number;
  /** Model calls in the whole lesson, the one that writes it included. */
  turns: number;
  /** Wall-clock time for the whole lesson. */
  timeMs: number;
  /** Characters of tool results sent back after one reply, like the pipeline's per-call bound. */
  resultChars: number;
  /** Characters of one passage a tool returns. */
  passageChars: number;
  /** Characters of a passage that search shows. */
  excerptChars: number;
};

export const AGENT_LIMITS: AgentLimits = {
  calls: 16,
  callsPerTurn: 4,
  turns: 8,
  timeMs: 10 * 60_000,
  resultChars: 24_000,
  passageChars: 4_000,
  excerptChars: 300,
};

export type AgentStats = {
  modelCalls: number;
  toolCalls: number;
  refusedCalls: number;
  /** Distinct passages the lesson cites. */
  cited: number;
  /** Citation markers removed because they named a passage the model had not read in full. */
  dropped: string[];
  /** From the start until the first ## section was complete (the next heading appeared), as the lesson page shows it. */
  firstSectionMs: number | null;
  totalMs: number;
  sections: number;
  /** Each tool call, in order, for the comparison. */
  log: string[];
};

type Row = { id: string; text: string; section_path: string | null };

const Call = z.discriminatedUnion("tool", [
  z.object({ tool: z.literal("list_sections") }),
  z.object({ tool: z.literal("read_section"), section: z.string().min(1).max(300) }),
  z.object({
    tool: z.literal("search"),
    query: z.string().min(1).max(300),
    limit: z.number().int().min(1).max(8).optional(),
  }),
  z.object({ tool: z.literal("read"), labels: z.array(z.string().max(20)).min(1).max(4) }),
]);
type Call = z.infer<typeof Call>;

const TOOL_NAMES = ["list_sections", "read_section", "search", "read"];
const FENCE = "```pyxis-tool";

/**
 * The tool calls a reply asks for, an error to send back when the request is malformed, or null when the reply is the
 * lesson. A request is a ```pyxis-tool block; a bare JSON object with `calls` counts too, since models drop fences.
 */
export function toolRequest(text: string): { calls: unknown[] } | { error: string } | null {
  const trimmed = text.trim();
  let body: string | null = null;
  const start = trimmed.indexOf(FENCE);
  if (start >= 0) {
    const open = trimmed.indexOf("\n", start);
    const close = open < 0 ? -1 : trimmed.indexOf("```", open);
    if (close < 0) return { error: "The pyxis-tool block is not closed with ```." };
    body = trimmed.slice(open + 1, close);
  } else if (trimmed.startsWith("{") && trimmed.includes('"calls"')) {
    body = trimmed;
  }
  if (body == null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    return { error: `The pyxis-tool block is not valid JSON (${(error as Error).message}).` };
  }
  const calls = (parsed as { calls?: unknown } | null)?.calls;
  if (!Array.isArray(calls) || calls.length === 0)
    return { error: 'The pyxis-tool block needs {"calls": [ ... ]} with at least one call.' };
  return { calls };
}

/**
 * Read-only tools over one topic and the sources of its plan. Passages get short labels (P1, P2, ...) the first time a
 * tool shows them; the model can read only a label it was shown, and cite only one whose full text it was given.
 */
export function studyTools(
  db: Database.Database,
  planId: string,
  topicId: string,
  limits: AgentLimits = AGENT_LIMITS,
) {
  const topic = db
    .prepare(
      `SELECT p.id, p.text, p.section_path, json_extract(p.locator_json, '$.paragraph') AS paragraph
       FROM topic_passages tp JOIN passages p ON p.id = tp.passage_id
       WHERE tp.topic_id = ? ORDER BY p.created_at, p.id`,
    )
    .all(topicId) as Array<Row & { paragraph: string | null }>;
  const sourceIds = (
    db.prepare("SELECT source_id AS id FROM plan_sources WHERE plan_id = ?").all(planId) as Array<{ id: string }>
  ).map((row) => row.id);
  const labels = new Map<string, Row>();
  const byId = new Map<string, string>();
  const citable = new Set<string>();
  const labelOf = (row: Row) => {
    let label = byId.get(row.id);
    if (!label) {
      label = `P${labels.size + 1}`;
      labels.set(label, row);
      byId.set(row.id, label);
    }
    return label;
  };
  // The topic's passages get their labels in reading order, so the outline reads P1, P2, ...
  for (const row of topic) labelOf(row);
  // A section is a run of passages under one heading of the source (a book's paragraph, a PDF's outline entry), named
  // by the first heading in its text when it has one.
  const sections = new Map<string, Row[]>();
  let key: string | null = null;
  let group: Row[] = [];
  const close = () => {
    if (!group.length) return;
    const heading = /^#{1,6}\s+(.+)$/m.exec(group[0]!.text)?.[1];
    const base = (heading ?? [group[0]!.section_path, (group[0] as { paragraph?: string | null }).paragraph].filter(Boolean).join(" ")).replace(/[*_`]/g, "").trim() || "—";
    let name = base;
    for (let n = 2; sections.has(name); n++) name = `${base} (${n})`;
    sections.set(name, group);
  };
  for (const row of topic) {
    const next = `${row.section_path ?? ""}\u0000${row.paragraph ?? ""}`;
    if (next !== key) {
      close();
      key = next;
      group = [];
    }
    group.push(row);
  }
  close();

  const firstWords = (text: string) => {
    const flat = text.replace(/^#{1,6}\s+/gm, "").replace(/\s+/g, " ").trim();
    return flat.length > 70 ? `${flat.slice(0, 70)}…` : flat;
  };
  const outline = () =>
    [...sections]
      .map(
        ([name, rows]) =>
          `- ${name} (${rows.reduce((sum, row) => sum + row.text.length, 0)} characters)\n${rows
            .map((row) => `  ${labelOf(row)}: ${firstWords(row.text)}`)
            .join("\n")}`,
      )
      .join("\n");
  const fullText = (row: Row) =>
    `${labelOf(row)} (${row.section_path?.trim() || "—"}):\n${
      row.text.length > limits.passageChars ? `${row.text.slice(0, limits.passageChars)} […]` : row.text
    }`;
  /**
   * Full texts that fit in `room` characters. Only a passage whose text went back becomes citable; the rest are named
   * so the model can read them in a later reply.
   */
  const fullTexts = (rows: Row[], room: number) => {
    const shown: string[] = [];
    const left: string[] = [];
    let used = 0;
    for (const row of rows) {
      const text = fullText(row);
      if (used + text.length > room) {
        left.push(labelOf(row));
        continue;
      }
      used += text.length + 2;
      citable.add(labelOf(row));
      shown.push(text);
    }
    if (left.length) shown.push(`Not shown, over the results limit: ${left.join(", ")}. Read them in a later reply.`);
    return shown.join("\n\n");
  };

  function run(call: Call, room: number): string {
    switch (call.tool) {
      case "list_sections":
        return (outline() || "This topic has no passages.").slice(0, room);
      case "read_section": {
        const wanted = call.section.trim().toLocaleLowerCase();
        const match = [...sections].find(([name]) => name.toLocaleLowerCase() === wanted);
        if (!match) throw new Error(`no section named ${JSON.stringify(call.section)} in the outline`);
        return fullTexts(match[1], room);
      }
      case "search": {
        if (sourceIds.length === 0) return "No passages found.";
        const { hits } = retrieve(db, call.query, { sourceIds, limit: call.limit ?? 5, embed: null });
        if (hits.length === 0) return "No passages found.";
        const lines: string[] = [];
        let used = 0;
        for (const hit of hits) {
          const row = { id: hit.id, text: hit.text, section_path: hit.sectionPath };
          // A short passage comes back whole, so it is read; a long one only as an excerpt.
          const line =
            hit.text.length <= limits.excerptChars
              ? fullTexts([row], room - used)
              : `${labelOf(row)} (${hit.sectionPath?.trim() || "—"}): ${hit.text.slice(0, limits.excerptChars).replace(/\s+/g, " ")} […]`;
          if (used + line.length > room) break;
          used += line.length + 1;
          lines.push(line);
        }
        return lines.join("\n");
      }
      case "read": {
        const unknown = call.labels.filter((label) => !labels.has(label.trim().toUpperCase()));
        if (unknown.length)
          throw new Error(`unknown label ${unknown.join(", ")}: read only labels a tool has shown you`);
        return fullTexts(
          call.labels.map((label) => labels.get(label.trim().toUpperCase())!),
          room,
        );
      }
    }
  }

  return {
    outline,
    /** Passage behind a label the model may cite (its full text was returned), else undefined. */
    citable: (label: string) => (citable.has(label) ? labels.get(label)!.id : undefined),
    /**
     * Runs one raw call with `room` characters for its results. A call that fails validation or names something unknown
     * is refused with the reason.
     */
    call(raw: unknown, room: number = limits.resultChars): { ok: boolean; text: string; name: string } {
      const name =
        raw && typeof raw === "object" && typeof (raw as { tool?: unknown }).tool === "string"
          ? (raw as { tool: string }).tool
          : "?";
      if (!TOOL_NAMES.includes(name))
        return { ok: false, name, text: `refused: unknown tool ${JSON.stringify(name)}. Tools: ${TOOL_NAMES.join(", ")}.` };
      const parsed = Call.safeParse(raw);
      if (!parsed.success)
        return { ok: false, name, text: `refused: bad arguments for ${name} (${parsed.error.issues.map((issue) => `${issue.path.join(".") || "call"}: ${issue.message}`).join("; ")}).` };
      try {
        return { ok: true, name, text: run(parsed.data, room) };
      } catch (error) {
        return { ok: false, name, text: `refused: ${(error as Error).message}.` };
      }
    },
  };
}

const GROUP = /([ \t]?)\[\s*(P\s*\d+(?:\s*[,;]\s*P?\s*\d+)*)\s*\]/gi;

/**
 * Turns the model's [Pk] tool labels into the lesson's own [Pn] numbering, n being the place of the passage in the
 * returned `passageIds` (first cited first), which is what the lesson page's chips open. A label the model had not read
 * in full is removed with the space before it and listed in `dropped`. The same text always gives the same result, so
 * it can run on a draft that is still streaming.
 */
export function citeLesson(markdown: string, citable: (label: string) => string | undefined) {
  const passageIds: string[] = [];
  const dropped: string[] = [];
  const text = markdown.replace(GROUP, (_, space: string, group: string) => {
    const kept: string[] = [];
    for (const raw of group.split(/[,;]/)) {
      const label = `P${raw.replace(/\D/g, "")}`;
      const id = citable(label);
      if (!id) {
        dropped.push(label);
        continue;
      }
      let index = passageIds.indexOf(id);
      if (index < 0) index = passageIds.push(id) - 1;
      const marker = `[P${index + 1}]`;
      if (!kept.includes(marker)) kept.push(marker);
    }
    return kept.length ? `${space}${kept.join("")}` : "";
  });
  return { markdown: text, passageIds, dropped };
}

/** The lesson rules of the pipeline, with its "do not cite" rule replaced by the agent's citation rule. */
const NO_CITES =
  'Do not cite sources, passages or page numbers, and do not mention "the material", "the passages" or "the book": the student reads a lesson, not a commentary on it.';

export function agentSystem(context: ReturnType<typeof modelContext>, figures: boolean): string {
  const rules = lessonSystem(context, true, figures);
  if (!rules.includes(NO_CITES)) throw new Error("lesson-agent-rules");
  return [
    rules.replace(
      NO_CITES,
      'Do not mention "the material", "the passages" or "the book" in the prose: the student reads a lesson, not a commentary on it. Cite passages as the tool rules below say.',
    ),
    systemPrompt("lesson.agent", { contentLanguage: context.language }),
  ].join("\n\n");
}

function agentKey(context: ReturnType<typeof modelContext>, topicId: string) {
  return cacheKey({
    kind: "lesson",
    scopeId: topicId,
    passageIds: context.passageIds,
    promptVersion: [AGENT_VERSION, ...context.variant].join("|"),
  });
}

export type AgentLessonOptions = {
  signal?: AbortSignal;
  onDelta?: (text: string) => void;
  onPassages?: (passageIds: string[]) => void;
  wording?: Wording;
  regenerate?: boolean;
  python?: FigureRunner | null;
  limits?: Partial<AgentLimits>;
  /** Clock for the stats; tests pass a fake one. */
  now?: () => number;
  /** Called once a model starts writing, which a saved lesson never does. */
  onWriting?: () => void;
};

/**
 * Writes the lesson with the agent loop and saves it like a model lesson, under its own cache key. Throws when the
 * engine fails, the model does not finish within the limits, or the time runs out; `writeAgentLesson` turns that into
 * the book fallback the pipeline gives.
 */
export async function agentLesson(
  db: Database.Database,
  planId: string,
  topicId: string,
  run: Parameters<typeof generate>[0]["run"],
  options: AgentLessonOptions = {},
): Promise<{ lesson: LessonResult; stats: AgentStats }> {
  const limits = { ...AGENT_LIMITS, ...options.limits };
  const now = options.now ?? Date.now;
  const started = now();
  const context = modelContext(db, planId, topicId, options.wording);
  const tools = studyTools(db, planId, topicId, limits);
  const topic = db.prepare("SELECT title FROM topics WHERE id = ?").get(topicId) as { title: string };
  const python = await figureRunner(options.python);
  const system = [agentSystem(context, python != null), interestsLine(db)].filter(Boolean).join("\n");
  const selection = selectionFor(db, "lesson");
  const stats: AgentStats = {
    modelCalls: 0,
    toolCalls: 0,
    refusedCalls: 0,
    cited: 0,
    dropped: [],
    firstSectionMs: null,
    totalMs: 0,
    sections: 0,
    log: [],
  };
  const deadline = AbortSignal.timeout(limits.timeMs);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  const conversation = `agent-lesson:${randomUUID()}`;
  const opening = `Topic: ${topic.title}\n\nOutline of the topic in the student's sources (what list_sections returns):\n${tools.outline()}\n\nTool calls you may make in all: ${limits.calls}. Use the tools, then write the lesson.`;
  const transcript = [opening];
  let followUp = opening;
  let callsLeft = limits.calls;
  let lesson: string | null = null;
  let seen = 0;
  const models = new Set<string>();
  let provider: string = selection.provider;
  try {
    for (let turn = 0; turn < limits.turns && lesson == null; turn++) {
      let shown = false;
      stats.modelCalls += 1;
      const result = await generate({
        prompt: transcript.join("\n\n"),
        system,
        selection,
        run,
        signal,
        conversation: { key: conversation, followUp },
        onDelta: (text) => {
          const head = text.trimStart();
          // A tool request, or too little text to tell, never reaches the page.
          if (head.startsWith("{") || FENCE.startsWith(head) || text.includes(FENCE)) {
            if (shown) options.onDelta?.("");
            shown = false;
            return;
          }
          if (stats.firstSectionMs == null && smartSections(text).length >= 2) stats.firstSectionMs = now() - started;
          if (!options.onDelta) return;
          const live = citeLesson(text, tools.citable);
          if (live.passageIds.length > seen) {
            seen = live.passageIds.length;
            options.onPassages?.(live.passageIds);
          }
          options.onDelta(live.markdown);
          shown = true;
        },
      });
      signal.throwIfAborted();
      provider = result.provider;
      models.add(result.model);
      const request = toolRequest(result.text);
      if (request == null) {
        lesson = lessonText(result.text);
        break;
      }
      // A request in the last allowed reply ends the loop without a lesson.
      if (turn + 1 >= limits.turns) break;
      const lines: string[] = [];
      // Every call's results share the reply's budget, so nothing is cut after a passage was marked as read.
      let room = limits.resultChars;
      if ("error" in request) {
        stats.refusedCalls += 1;
        callsLeft -= 1;
        stats.log.push(`refused request: ${request.error}`);
        lines.push(`refused: ${request.error}`);
      } else {
        request.calls.forEach((raw, index) => {
          if (index >= limits.callsPerTurn || callsLeft <= 0) {
            stats.refusedCalls += 1;
            lines.push(`[${index + 1}] refused: ${callsLeft <= 0 ? "no tool calls left" : `at most ${limits.callsPerTurn} calls per reply`}.`);
            return;
          }
          callsLeft -= 1;
          const done = tools.call(raw, Math.max(0, room));
          room -= done.text.length;
          if (done.ok) stats.toolCalls += 1;
          else stats.refusedCalls += 1;
          stats.log.push(`${done.ok ? "" : "refused "}${JSON.stringify(raw)}`);
          lines.push(`[${index + 1}] ${done.name}: ${done.text}`);
        });
      }
      // The next reply is the last one allowed, or the calls are used up: it has to be the lesson.
      const last = turn + 2 >= limits.turns || callsLeft <= 0;
      followUp = `Tool results (calls left: ${Math.max(0, callsLeft)}):\n\n${lines.join("\n\n")}${
        last
          ? "\n\nNo more tool calls: write the lesson now, citing only passages you have read in full."
          : ""
      }`;
      transcript.push(`Your reply:\n${result.text}`, followUp);
    }
  } catch (error) {
    // The time limit, not the student's Stop: say so instead of reporting a cancel.
    if (deadline.aborted && !options.signal?.aborted)
      throw new IpcError("agent-timeout", "errors.invalidOutput", {}, `The lesson took longer than ${limits.timeMs} ms.`);
    throw error;
  } finally {
    endConversation(conversation);
  }
  if (lesson == null) throw new IpcError("agent-limit", "errors.invalidOutput", {}, "The model did not write the lesson within the tool and turn limits.");
  if (!lesson) throw new IpcError("invalid-output", "errors.invalidOutput", {}, "The model wrote an empty lesson.");
  const cited = citeLesson(lesson, tools.citable);
  const drawn = await withFigures(cited.markdown, python, { signal });
  const itemId = saveLesson(db, {
    planId,
    topicId,
    kind: "lesson",
    key: agentKey(context, topicId),
    markdown: drawn.markdown,
    passageIds: cited.passageIds,
    engine: { provider, model: [...models].join(", ") },
    prompt: { template: "lesson.agent", version: AGENT_VERSION },
    grounding: "sources",
    figures: drawn.figures,
  });
  stats.cited = cited.passageIds.length;
  stats.dropped = cited.dropped;
  stats.sections = smartSections(drawn.markdown).length;
  stats.totalMs = now() - started;
  return {
    lesson: {
      markdown: drawn.markdown,
      passageIds: cited.passageIds,
      itemId,
      wording: context.wording,
      ...(Object.keys(drawn.figures).length ? { figures: drawn.figures } : {}),
    },
    stats,
  };
}

/**
 * The developer flag's lesson: the saved agent lesson, or a new one. A topic without passages has nothing to read, so
 * the pipeline writes it from general knowledge. A failure gives the book text, as the pipeline does.
 */
export async function writeAgentLesson(
  db: Database.Database,
  planId: string,
  topicId: string,
  run: Parameters<typeof generate>[0]["run"],
  options: AgentLessonOptions = {},
): Promise<LessonResult> {
  const context = modelContext(db, planId, topicId, options.wording);
  if (context.passageIds.length === 0) return writeLesson(db, planId, topicId, run, options);
  const cached = loadLesson(db, { planId, kind: "lesson", key: agentKey(context, topicId) });
  if (cached?.provider && !options.regenerate)
    return {
      markdown: cached.markdown,
      passageIds: cached.passageIds,
      itemId: cached.itemId,
      wording: context.wording,
      ...(Object.keys(cached.figures).length ? { figures: cached.figures } : {}),
    };
  options.onWriting?.();
  try {
    return (await agentLesson(db, planId, topicId, run, options)).lesson;
  } catch (error) {
    if (isAbort(error) || options.signal?.aborted) throw error;
    if (options.regenerate && cached?.provider) throw error;
    return {
      ...openLesson(db, planId, topicId),
      wording: context.wording,
      fallback: true,
      ...(error instanceof IpcError && error.messageKey.startsWith("engines.errors.")
        ? { fallbackReason: error.messageKey }
        : {}),
    };
  }
}
