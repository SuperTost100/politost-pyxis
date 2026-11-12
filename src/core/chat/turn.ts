import { activeSimulation } from "../study/simulation";
import { needsSolverChecks, splitChecks, solverChecks } from "./checks";
import { stripCheckFences, type AnchoredCheck } from "../../shared/math-check";
import type Database from "better-sqlite3";
import { uuidv7 } from "../../shared/ids";
import {
  figureImages,
  mapFigureBlocks,
  splitCitationGroups,
} from "../../shared/smart-text";
import {
  drawFigures,
  figureCaptions,
  figureRunner,
  noSandbox,
  type FigureRunner,
} from "../math/figures";
import { isAbort, IpcError, toIpcError } from "../../shared/ipc";
import { generate, type GenerateInput } from "../engine/generate";
import { endConversation } from "../engine/funnel";
import { engineSeesImages } from "../engine/capabilities";
import { selectionFor, strongestSelection } from "../engine/selection";
import { withUsageScope } from "../engine/usage";
import type { Embedder, PassageHit } from "../sources/retrieve";
import { contentWords, hitOf, queryEmbedder, retrieveWithModel, type PassageRow } from "../sources/retrieve";
import { sha256 } from "../sources/quality";
import { readingOrder } from "../sources/smartbook";
import { commitStaged, savedImages, stageFiles, type PreparedFiles, type SkippedImage, type StagedFiles } from "./attach";
import { chatListedSources, deleteHiddenSources, removeUnreferencedBlobs } from "./delete";
import { latestDocument } from "../sources/documents";
import { contentLanguage, planLanguage, promptProvenance } from "../engine/prompts";
import { plainTitle } from "../../shared/spoken-math";
import { oneLine, profileContext } from "../profile/context";
import { readProfile } from "../profile/profile";
import {
  type ChatTemplateId,
  chatSystemPrompt,
  chatTemplateId,
  dataBlock,
} from "./prompts";
import { liveSubject, pickSubject, sourceSubjects, subjectSourceIds, type SubjectBy } from "./subject";
import { answerWay, wayOfTemplate, type AnswerWay } from "./way";

export type ChatContext = {
  kind: "answer" | "passage";
  title: string;
  body: string;
};

export type ChatCitation = {
  label: string;
  index: number;
  passageId: string;
  sourceId: string;
  sectionPath: string | null;
  locator: PassageHit["locator"];
  /** The file's title, for the list under "I used N sources". */
  sourceTitle?: string;
  /** The subject the file belongs to (see `sourceSubjects`), null for one without. */
  subject?: string | null;
  /** The file was attached to the chat rather than taken from the Library. */
  attached?: boolean;
};

/**
 * What a reply rests on. `sources`: it cites the student's material. `wider`: it cites material from outside the chat's
 * subject, which had nothing on the question (stored as `mixed`). `general`: Pyxis searched and the reply cites nothing,
 * so it comes from general knowledge. Null: nothing was searched (an older reply, or a turn with only an attached file).
 */
export type Grounding = "sources" | "wider" | "general";

export type ChatMessageView = {
  id: string;
  role: "user" | "assistant";
  body: string;
  modelId: string | null;
  provider: string | null;
  grounding: Grounding | null;
  /** Solved in full, or guided one step at a time. */
  way: AnswerWay;
  followups: string[];
  citations: ChatCitation[];
  reaction: "up" | "down" | null;
  stopped: boolean;
  /** Message key of the engine failure that cut the reply short. Such a reply offers Continue. */
  error: string | null;
  checks: AnchoredCheck[];
  /** Images of the answer's figure blocks, by `figureKey`. */
  figures?: Record<string, string>;
  /** The math check for this reply is still running; its badges arrive with a `chats.checks` broadcast. */
  checking: boolean;
  /**
   * For a reply from general knowledge: whether the search found relevant passages the answer then did not cite, and
   * where it looked (the whole Library, or the files the chat is limited to). Absent when the reply cites sources, and
   * for a reply stopped or saved before this was kept.
   */
  searched?: SearchNote;
};

export type SearchNote = { found: boolean; where: "library" | "files" };

export type AskResult = {
  chatId: string;
  covered: boolean;
  message: ChatMessageView | null;
  /** Saved images this turn could not send, with why. The student is told, since the reply did not see them. */
  skippedImages?: SkippedImage[];
};

type AskInput = {
  chatId?: string;
  text: string;
  sourceIds?: string[];
  /** ASK-07: a plan scopes the chat to the plan's sources; null clears it, undefined keeps it. */
  planId?: string | null;
  /** The way the student asked for with the action under an answer. Without it the question decides (`answerWay`). */
  way?: AnswerWay;
  allowGeneral?: boolean;
  /** A subject the student chose for the chat, null for the whole Library. Undefined keeps the chat's own. */
  subject?: string | null;
  files?: string[];
  workspace?: string;
  recognize?: (bytes: Uint8Array, cachePath: string) => Promise<string>;
  embed?: Embedder | null;
  signal?: AbortSignal;
  onDelta?: (text: string) => void;
  /** The passages this turn's reply may cite, by number, before it streams. A stored reply labels them the same way. */
  onPassages?: (passages: Array<{ index: number; label: string }>) => void;
  /** The stored message that is this turn's question, new or reused, and its chat (new for a first question), before the reply streams. */
  onQuestion?: (messageId: string, chatId: string) => void;
  run?: Parameters<typeof generate>[0]["run"];
  /** Runs figure code; null turns figures off. Defaults to the Pyodide sandbox when its runtime is downloaded. */
  python?: FigureRunner | null;
  /** `strong` answers with the plan task's engine at high effort ("Answer again with the strongest model"). */
  engine?: "chat" | "strong";
  /**
   * Continue: the reply that was cut short. The model writes only the rest, appended to its text, from the passages it
   * was written with (null for a reply saved before they were recorded, which retrieves them again).
   */
  resumeFrom?: { text: string; passages: KeptPassage[] | null; widened?: boolean };
};

/** A passage a stopped reply was written with, and the P-number it had. */
type KeptPassage = { passageId: string; index: number };

/** The passages a cut reply was written with, in its numbering. One deleted since then is left out; the rest keep their numbers. */
function keptPassages(
  db: Database.Database,
  kept: KeptPassage[],
): { hits: PassageHit[]; numbers: number[] } {
  const read = db.prepare(
    `SELECT id, source_id, text, section_path, locator_json FROM passages WHERE id = ?`,
  );
  const hits: PassageHit[] = [];
  const numbers: number[] = [];
  for (const passage of kept) {
    const row = read.get(passage.passageId) as PassageRow | undefined;
    if (!row) continue;
    hits.push(hitOf(row));
    numbers.push(passage.index);
  }
  return { hits, numbers };
}

/** Passages a chat turn sends to the model. Questions that ask for a full explanation need more than the default eight. */
const CHAT_PASSAGES = 12;
/** Passages of a document attached to this turn that always go with it, whatever the question says. */
const ATTACHED_PASSAGES = 4;
/** At most this many passages are added for this turn's documents, on top of the ones retrieval found. */
const ATTACHED_TOTAL = 12;
/** Characters of earlier turns sent with a question. Whole messages are kept, newest first. */
const HISTORY_CHARS = 6000;

/** Math checks still running after their reply was saved, by the message they are for. */
const runningChecks = new Map<
  string,
  { chatId: string; controller: AbortController; done: Promise<void> }
>();
let onChecked: ((event: { chatId: string; messageId: string }) => void) | undefined;

/** Core tells the window when a reply's math check ended, so its badges, or the end of "checking", show. */
export function setChecksListener(
  listener: ((event: { chatId: string; messageId: string }) => void) | undefined,
): void {
  onChecked = listener;
}

/**
 * Checks a saved reply's math after the turn has returned, so the student can read and ask on while it runs. The
 * claims are appended to the stored body. A check that is stopped, fails or times out attaches nothing.
 */
function startChecks(
  db: Database.Database,
  target: { chatId: string; messageId: string; body: string },
  engine: Pick<GenerateInput, "selection" | "run">,
): void {
  const { chatId, messageId, body } = target;
  const controller = new AbortController();
  const done = withUsageScope({ chatId, messageId, kind: "chat" }, () =>
    solverChecks(body, { ...engine, signal: controller.signal }),
  )
    .then((checks) => {
      if (controller.signal.aborted || checks.length === 0 || activeSimulation(db)) return;
      // A reply regenerated or deleted meanwhile is gone, and nothing is attached.
      const row = db
        .prepare(`SELECT body FROM messages WHERE id = ? AND chat_id = ?`)
        .get(messageId, chatId) as { body: string } | undefined;
      if (!row) return;
      db.prepare(`UPDATE messages SET body = ? WHERE id = ?`).run(
        `${row.body}\n<checks>${JSON.stringify(checks)}</checks>`,
        messageId,
      );
    })
    .catch((err: unknown) => {
      console.error("pyxis: math check not saved", err);
    })
    .finally(() => {
      runningChecks.delete(messageId);
      onChecked?.({ chatId, messageId });
    });
  runningChecks.set(messageId, { chatId, controller, done });
}

/** Stops the chat's running math checks, or only the one for `messageId`. */
function cancelChecks(chatId: string, messageId?: string): void {
  for (const [id, check] of runningChecks) {
    if (check.chatId === chatId && (!messageId || id === messageId))
      check.controller.abort();
  }
}

/** Resolves once every running math check has ended. */
export async function settleChecks(): Promise<void> {
  await Promise.all([...runningChecks.values()].map((check) => check.done));
}

/**
 * What the reply message records, and so whether the "general knowledge" badge shows. The badge is only for a turn where
 * the student had sources or a subject selected and the answer cites none of them: that is "general". A cited answer is
 * "sources", and a turn with nothing selected carries no claim (null) and no badge. A turn's own attachment counts as
 * its source. A Socratic question needs no citation, so it stays "sources" whenever passages were found.
 */
export function replyGrounding(turn: {
  selected: boolean;
  cited: number;
  attached: boolean;
  /** The reply is a Socratic question, which is not expected to cite. */
  question: boolean;
  passages: number;
  /** The passages came from outside the chat's subject, which had nothing on the question. */
  widened?: boolean;
}): Grounding | null {
  if (turn.cited > 0) return turn.widened ? "wider" : "sources";
  if (turn.attached) return "sources";
  if (!turn.selected) return null;
  return turn.question && turn.passages > 0 ? (turn.widened ? "wider" : "sources") : "general";
}

/** `wider` is stored as `mixed`, a value the column has allowed from the start. */
function storedGrounding(grounding: Grounding | null): string | null {
  return grounding === "wider" ? "mixed" : grounding;
}

function readGrounding(stored: string | null): Grounding | null {
  return stored === "mixed" ? "wider" : stored === "sources" || stored === "general" ? stored : null;
}

export function splitFollowups(text: string): { body: string; followups: string[] } {
  // A reply cut short, or a model that forgets the closing tag, still has its suggestions read and kept out of the text.
  const match = text.match(/<followups>([\s\S]*?)(?:<\/followups>|$)/i);
  if (!match?.[1]) return { body: text.trim(), followups: [] };
  const followups = match[1]
    .split("\n")
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "").trim())
    .filter(Boolean)
    .slice(0, 3);
  return { body: text.replace(match[0], "").trim(), followups };
}

/**
 * The chat so far, as the model reads it: the question being answered and the reply being replaced are left out, and an
 * answer loses its check blocks and suggestions. Messages are kept whole, newest first, while they fit; only a newest
 * message longer than the whole budget is cut, at its end.
 */
function historyText(
  db: Database.Database,
  chatId: string,
  exclude: string[],
): string {
  const ids = exclude.filter(Boolean);
  const rows = db
    .prepare(
      `SELECT role, body FROM messages WHERE chat_id = ?${
        ids.length ? ` AND id NOT IN (${ids.map(() => "?").join(", ")})` : ""
      } ORDER BY created_at DESC LIMIT 8`,
    )
    .all(chatId, ...ids) as Array<{ role: string; body: string }>;
  const lines: string[] = [];
  let used = 0;
  for (const row of rows) {
    const body =
      row.role === "assistant"
        ? figureCaptions(
            stripCheckFences(splitFollowups(splitChecks(row.body).body).body),
            "Figure",
          ).trim()
        : row.body;
    const line = `${row.role}: ${body}`;
    if (used + line.length > HISTORY_CHARS) {
      if (lines.length === 0) lines.push(`${line.slice(0, HISTORY_CHARS - 1)}…`);
      break;
    }
    lines.push(line);
    used += line.length + 1;
  }
  return lines.reverse().join("\n");
}

/**
 * Passages of the documents attached to this turn, so a question like "summarise this" sees the file even when its
 * words match nothing in it: the best matches retrieval found, then the best matches within each document, then its
 * opening passages, up to ATTACHED_PASSAGES each.
 */
async function attachedPassages(
  db: Database.Database,
  text: string,
  sourceIds: string[],
  found: PassageHit[],
  embed: AskInput["embed"],
): Promise<PassageHit[]> {
  const opening = db.prepare(
    `SELECT p.id, p.source_id, p.text, p.section_path, p.locator_json FROM passages p
     WHERE p.source_id = ? AND p.document_id = ${latestDocument("p.source_id")}
     ORDER BY ${readingOrder("p")} LIMIT ?`,
  );
  const taken = new Set(found.map((hit) => hit.id));
  const added: PassageHit[] = [];
  for (const sourceId of sourceIds) {
    const within = await retrieveWithModel(db, text, { sourceIds: [sourceId], embed, limit: ATTACHED_PASSAGES });
    const first = (opening.all(sourceId, ATTACHED_PASSAGES) as PassageRow[]).map(hitOf);
    let have = found.filter((hit) => hit.sourceId === sourceId).length;
    for (const hit of [...within.hits, ...first]) {
      if (have >= ATTACHED_PASSAGES || added.length >= ATTACHED_TOTAL) break;
      if (taken.has(hit.id)) continue;
      taken.add(hit.id);
      added.push(hit);
      have += 1;
    }
  }
  return added;
}

const FOLLOW = new Set([
  "esempio",
  "example",
  "ancora",
  "spiega",
  "explain",
  "altro",
  "another",
  "dettaglio",
  "detail",
  "continua",
  "continue",
]);

function isFollowUp(text: string): boolean {
  const words = contentWords(text).map((word) => word.toLocaleLowerCase("it"));
  return words.length === 0 || words.every((word) => FOLLOW.has(word));
}

/** `subjectBy` says who set the chat's subject (or chose the whole Library); undefined while Pyxis may still pick one. */
type Scope = { planId: string | null; ids: string[]; subjectBy?: SubjectBy };

/**
 * scope_json holds a source ID array, or { planId, sourceIds, subjectBy } once the chat has a plan or someone set its
 * subject. A chat saved with a subject before `subjectBy` existed had it picked by the student.
 */
function readScope(db: Database.Database, chatId: string): Scope {
  const row = db
    .prepare(`SELECT scope_json, subject FROM chats WHERE id = ?`)
    .get(chatId) as { scope_json: string; subject: string | null } | undefined;
  if (!row) return { planId: null, ids: [] };
  const parsed = JSON.parse(row.scope_json) as unknown;
  const strings = (value: unknown) =>
    Array.isArray(value)
      ? value.filter((id): id is string => typeof id === "string")
      : [];
  const legacy: SubjectBy | undefined = row.subject ? "student" : undefined;
  // A subject that was deleted leaves the chat on the whole Library, as a choice of the student's: Pyxis picked the
  // subject, and a chat with none of its own must not look as if Pyxis were still choosing.
  const gone = (by: SubjectBy | undefined): SubjectBy | undefined =>
    by === "pyxis" && !liveSubject(db, row.subject) ? "student" : by;
  if (Array.isArray(parsed)) return { planId: null, ids: strings(parsed), subjectBy: legacy };
  const object = (parsed ?? {}) as { planId?: unknown; sourceIds?: unknown; subjectBy?: unknown };
  const planId =
    typeof object.planId === "string" &&
    db.prepare(`SELECT 1 FROM plans WHERE id = ?`).get(object.planId)
      ? object.planId
      : null;
  const subjectBy =
    object.subjectBy === "pyxis" || object.subjectBy === "student" ? object.subjectBy : legacy;
  return { planId, ids: strings(object.sourceIds), subjectBy: gone(subjectBy) };
}

/** The stored form of a scope: the plain ID array while there is nothing else to keep, as older chats have it. */
function scopeJson(scope: Scope): string {
  if (!scope.planId && !scope.subjectBy) return JSON.stringify(scope.ids);
  return JSON.stringify({
    ...(scope.planId ? { planId: scope.planId } : {}),
    sourceIds: scope.ids,
    ...(scope.subjectBy ? { subjectBy: scope.subjectBy } : {}),
  });
}

/** Chat attachments among `ids`: files outside the Library that stay in the chat's scope whatever else changes. */
function hiddenSources(db: Database.Database, ids: readonly string[]): string[] {
  if (ids.length === 0) return [];
  return (
    db
      .prepare(`SELECT id FROM sources WHERE library = 0 AND id IN (SELECT value FROM json_each(?))`)
      .all(JSON.stringify(ids)) as Array<{ id: string }>
  ).map((row) => row.id);
}

function planSourceIds(db: Database.Database, planId: string): string[] {
  return (
    db
      .prepare(`SELECT source_id FROM plan_sources WHERE plan_id = ? AND role = 'material'`)
      .all(planId) as Array<{ source_id: string }>
  ).map((row) => row.source_id);
}

function effectiveSources(db: Database.Database, scope: Scope): string[] {
  return [
    ...new Set([
      ...(scope.planId ? planSourceIds(db, scope.planId) : []),
      ...scope.ids,
    ]),
  ];
}

/** Every source the chat retrieves from: the plan's sources plus chosen and attached ones. */
export function chatScope(db: Database.Database, chatId: string): string[] {
  return effectiveSources(db, readScope(db, chatId));
}

export function chatPlan(db: Database.Database, chatId: string): string | null {
  return readScope(db, chatId).planId;
}

/** Sources picked by hand or attached, without the plan's own. */
export function chatPickedSources(db: Database.Database, chatId: string): string[] {
  return readScope(db, chatId).ids;
}

/** Who set the chat's subject, or chose the whole Library; null while Pyxis may still pick one. */
export function chatSubjectBy(db: Database.Database, chatId: string): SubjectBy | null {
  return readScope(db, chatId).subjectBy ?? null;
}

/**
 * The student sets the chat's subject from its chip, or the whole Library with null. It replaces any sources and exam
 * picked by hand for the chat (an older chat's "Fonti scelte"); the chat's attachments stay. Pyxis never changes it.
 */
export function setChatSubject(db: Database.Database, chatId: string, subject: string | null): void {
  db.transaction(() => {
    const scope = readScope(db, chatId);
    // The Library's spelling of the name, and only a subject that exists: the chip lists them, but one may have been
    // renamed or deleted since.
    const name = subject?.trim() ? liveSubject(db, subject) : null;
    if (subject?.trim() && !name) throw new IpcError("invalid", "errors.invalidSubject");
    const info = db
      .prepare(`UPDATE chats SET subject = ?, scope_json = ? WHERE id = ?`)
      .run(name, scopeJson({ planId: null, ids: hiddenSources(db, scope.ids), subjectBy: "student" }), chatId);
    if (info.changes === 0) throw new Error("chat-missing");
  })();
}

/** ASK-09: the plan's language and name, falling back to the profile for an unscoped chat. */
function chatPrompt(db: Database.Database, planId: string | null) {
  const plan = planId
    ? (db
        .prepare(
          `SELECT p.title, s.name AS subject FROM plans p
           LEFT JOIN subjects s ON s.id = p.subject_id WHERE p.id = ?`,
        )
        .get(planId) as { title: string; subject: string | null } | undefined)
    : undefined;
  return {
    language: planId ? planLanguage(db, planId) : contentLanguage(db),
    planLine: plan
      ? `Plan: ${oneLine(plan.title)}.${plan.subject ? ` Subject: ${oneLine(plan.subject)}.` : ""}`
      : "",
  };
}

function priorPassages(
  db: Database.Database,
  chatId: string,
  sourceIds: string[],
): PassageHit[] {
  const rows = db
    .prepare(
      `SELECT p.id, p.source_id, p.text, p.section_path, p.locator_json
       FROM message_passages mp
       JOIN messages m ON m.id = mp.message_id
       JOIN passages p ON p.id = mp.passage_id
       WHERE m.chat_id = ?
       ORDER BY m.created_at DESC
       LIMIT 8`,
    )
    .all(chatId) as PassageRow[];
  const seen = new Set<string>();
  const hits: PassageHit[] = [];
  for (const row of rows) {
    if (seen.has(row.id)) continue;
    if (sourceIds.length > 0 && !sourceIds.includes(row.source_id ?? ""))
      continue;
    seen.add(row.id);
    hits.push(hitOf(row));
  }
  return hits;
}

/** A chat is named after its first question: one line, cut at a word near 60 characters. */
export function chatTitleFrom(text: string, limit = 60): string {
  const line = text.replace(/\s+/g, " ").trim();
  if (line.length <= limit) return line;
  const cut = line.slice(0, limit);
  const space = cut.lastIndexOf(" ");
  return `${(space > limit / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

function ensureChat(
  db: Database.Database,
  chatId: string | undefined,
  title: string,
  now: number,
): { id: string; created: boolean } {
  if (chatId) {
    const existing = db
      .prepare(`SELECT id FROM chats WHERE id = ?`)
      .get(chatId) as { id: string } | undefined;
    if (existing) return { id: existing.id, created: false };
  }
  const id = uuidv7(now);
  db.prepare(
    `INSERT INTO chats (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`,
  ).run(id, chatTitleFrom(title), now, now);
  return { id, created: true };
}

/** A reply stored for a chat deleted while it was written would fail on the missing chat. The turn ends as cancelled instead. */
function requireChat(db: Database.Database, chatId: string) {
  if (!db.prepare(`SELECT 1 FROM chats WHERE id = ?`).get(chatId))
    throw new DOMException("chat-deleted", "AbortError");
}

/** Where a turn searches: `sourceIds` alone, or the whole Library plus them (`withLibrary`). */
type SearchScope = { sourceIds: string[]; withLibrary: boolean };

/** `question` embeds `text` alone; `embed` is the turn's own embedder, for the wider search a follow-up may need. */
async function gather(
  db: Database.Database,
  chatId: string,
  text: string,
  scope: SearchScope,
  embed: AskInput["embed"],
  question: AskInput["embed"],
): Promise<{ hits: PassageHit[]; covered: boolean; usedVectors: boolean; relevant: string[] }> {
  // A subject with no files yet has nothing to search; an empty list would otherwise mean the whole Library.
  if (!scope.withLibrary && scope.sourceIds.length === 0)
    return { hits: [], covered: false, usedVectors: false, relevant: [] };
  const sourceIds = scope.sourceIds;
  const options = { ...scope, embed, limit: CHAT_PASSAGES };
  const found = await retrieveWithModel(db, text, { ...options, embed: question });
  if (found.covered || !isFollowUp(text)) return found;
  const earlier = db
    .prepare(
      `SELECT body FROM messages WHERE chat_id = ? AND role = 'user' AND body != ?
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(chatId, text) as { body: string } | undefined;
  if (earlier) {
    const wider = await retrieveWithModel(
      db,
      `${earlier.body} ${text}`,
      options,
    );
    if (wider.covered) return wider;
  }
  const prior = priorPassages(db, chatId, scope.withLibrary ? [] : sourceIds);
  if (prior.length > 0)
    return { hits: prior, covered: true, usedVectors: false, relevant: [] };
  return found;
}

function requireTutorAvailable(db: Database.Database) {
  if (activeSimulation(db))
    throw new IpcError("exam-active", "simulation.tutorLocked");
}

export function seedChat(
  db: Database.Database,
  input: ChatContext & { sourceIds?: string[]; subject?: string; planId?: string },
): { chatId: string } {
  requireTutorAvailable(db);
  if (input.planId && !db.prepare("SELECT 1 FROM plans WHERE id = ?").get(input.planId))
    throw new IpcError("plan-missing", "errors.internal");
  const now = Date.now();
  const chatId = uuidv7(now);
  // The name is read in a list and a header, where a formula's TeX would show as source.
  const title = plainTitle(input.title);
  // A chat opened from an exam, a lesson or a source knows its subject: the one given, the exam's, or the subject all
  // the given files share.
  const fromPlan = input.planId
    ? (
        db
          .prepare(`SELECT s.name FROM plans p JOIN subjects s ON s.id = p.subject_id WHERE p.id = ?`)
          .get(input.planId) as { name: string } | undefined
      )?.name
    : undefined;
  const fromFiles = [...new Set(sourceSubjects(db, input.sourceIds ?? []).values())];
  const subject =
    liveSubject(db, input.subject) || fromPlan || (fromFiles.length === 1 && fromFiles[0] ? fromFiles[0] : "");
  const context: ChatContext = {
    kind: input.kind,
    title,
    body: input.body,
  };
  db.prepare(
    `INSERT INTO chats (id, title, scope_json, subject, context_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    chatId,
    title,
    // A chat opened from an exam or a lesson already knows its subject, which Pyxis then keeps.
    scopeJson({
      planId: input.planId ?? null,
      ids: input.sourceIds ?? [],
      subjectBy: subject ? "student" : undefined,
    }),
    subject || null,
    JSON.stringify(context),
    now,
    now,
  );
  return { chatId };
}

export function clearChatContext(db: Database.Database, chatId: string): void {
  const info = db
    .prepare(`UPDATE chats SET context_json = NULL WHERE id = ?`)
    .run(chatId);
  if (info.changes === 0) throw new Error("chat-missing");
}

export function chatContext(
  db: Database.Database,
  chatId: string,
): ChatContext | null {
  const row = db
    .prepare(`SELECT context_json FROM chats WHERE id = ?`)
    .get(chatId) as { context_json: string | null } | undefined;
  if (!row?.context_json) return null;
  return JSON.parse(row.context_json) as ChatContext;
}

/** Chats with a reply being written. A second turn into one would interleave with it, so it is refused. */
const generating = new Set<string>();

function requireIdle(chatId: string | undefined) {
  if (chatId && generating.has(chatId))
    throw new IpcError("chat-busy", "errors.chatBusy");
}

/** How the streaming preview names the passages a reply may cite: the same labels a stored reply has (see readChat). */
function passageLabels(citations: ChatCitation[]) {
  return citations.map((cite) => ({
    index: cite.index,
    label: cite.sectionPath || `P${cite.index}`,
  }));
}

/** Whether any file of the Library or of an exam has passages to search. */
function libraryHasPassages(db: Database.Database): boolean {
  return Boolean(
    db
      .prepare(
        `SELECT 1 FROM passages p JOIN sources s ON s.id = p.source_id
          WHERE (s.library = 1 OR s.id IN (SELECT source_id FROM plan_sources WHERE role = 'material'))
            AND s.status NOT IN ('removed', 'failed', 'cancelled', 'interrupted') LIMIT 1`,
      )
      .get(),
  );
}

/** How the reply before this question answered, so a student answering a guided step keeps being guided. */
function previousWay(db: Database.Database, chatId: string, replacing?: string): AnswerWay | null {
  const row = db
    .prepare(
      `SELECT prompt_template FROM messages WHERE chat_id = ? AND role = 'assistant' AND id IS NOT ?
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(chatId, replacing ?? null) as { prompt_template: string | null } | undefined;
  return row ? wayOfTemplate(row.prompt_template) : null;
}

/** Adds each citation's file title, its subject and whether it was attached to the chat, for the "I used" line. */
function describeCitations(db: Database.Database, citations: ChatCitation[]): ChatCitation[] {
  if (citations.length === 0) return citations;
  const ids = [...new Set(citations.map((cite) => cite.sourceId))];
  const files = new Map(
    (
      db
        .prepare(`SELECT id, title, library FROM sources WHERE id IN (SELECT value FROM json_each(?))`)
        .all(JSON.stringify(ids)) as Array<{ id: string; title: string; library: number }>
    ).map((row) => [row.id, row]),
  );
  const subjects = sourceSubjects(db, ids);
  return citations.map((cite) => {
    const file = files.get(cite.sourceId);
    return {
      ...cite,
      sourceTitle: file?.title ?? "",
      subject: subjects.get(cite.sourceId) ?? null,
      attached: file ? file.library === 0 : false,
    };
  });
}

export async function askTurn(
  db: Database.Database,
  input: AskInput,
  replacing?: { assistantId: string; userId: string },
): Promise<AskResult> {
  requireTutorAvailable(db);
  if (input.signal?.aborted) throw new DOMException("aborted", "AbortError");
  requireIdle(input.chatId);
  const now = Date.now();
  const chat = ensureChat(db, input.chatId, input.text, now);
  // Stop also stops a math check still running for an earlier reply in this chat.
  const stopChecks = () => cancelChecks(chat.id);
  input.signal?.addEventListener("abort", stopChecks, { once: true });
  generating.add(chat.id);
  try {
    return await answer(db, input, replacing, chat.id, now);
  } catch (err) {
    // A chat this turn created and could not answer is removed with its question and attachments. The student's
    // message goes back to the composer, so a retry starts one new chat instead of leaving an empty one behind.
    if (
      chat.created &&
      db.prepare(`SELECT 1 FROM chats WHERE id = ?`).get(chat.id) &&
      !db.prepare(`SELECT 1 FROM messages WHERE chat_id = ? AND role = 'assistant'`).get(chat.id)
    )
      deleteChat(db, input.workspace ?? "", chat.id);
    throw err;
  } finally {
    input.signal?.removeEventListener("abort", stopChecks);
    generating.delete(chat.id);
  }
}

async function answer(
  db: Database.Database,
  input: AskInput,
  replacing: { assistantId: string; userId: string } | undefined,
  chatId: string,
  now: number,
): Promise<AskResult> {
  const prior = readScope(db, chatId);
  const planId = input.planId === undefined ? prior.planId : input.planId;
  if (
    planId &&
    !db.prepare(`SELECT 1 FROM plans WHERE id = ?`).get(planId)
  )
    throw new IpcError("plan-missing", "errors.internal");
  const picked0 =
    input.sourceIds ?? (planId === prior.planId ? prior.ids : []);
  let staged: StagedFiles | undefined;
  if (input.files && input.files.length > 0 && input.workspace) {
    try {
      staged = await stageFiles(
        db,
        input.workspace,
        input.files,
        selectionFor(db, "chat"),
        input.recognize,
        input.signal,
      );
    } catch (err) {
      if (
        err instanceof Error &&
        (err.message === "attach-too-big" || err.message === "attach-too-many")
      ) {
        throw new IpcError("attach-too-big", "errors.attachTooBig");
      }
      throw err;
    }
  }
  const notes: string[] = staged?.notes ?? [];
  const images: PreparedFiles["images"] = staged?.images ?? [];
  // The files were read while the chat could be deleted, so it is checked again here, in the one transaction that stores
  // the attached sources with the turn's scope, message and photos. A failure anywhere in it leaves none of them.
  const persist = (attachedIds: string[]) => {
    if (!db.prepare(`SELECT 1 FROM chats WHERE id = ?`).get(chatId)) throw new Error("chat-missing");
    // The chat's own hidden documents stay in its scope whatever the client sends: a picker that lists only library
    // sources, or a `picked` list loaded before an earlier turn attached one, cannot remove them. The scope is read
    // again here, in the transaction, so a turn stored since `prior` was read is not overwritten either.
    const hidden = readScope(db, chatId).ids.filter((id) =>
      db.prepare(`SELECT 1 FROM sources WHERE id = ? AND library = 0`).get(id),
    );
    const picked = [...new Set([...picked0, ...hidden, ...attachedIds])];
    const sourceIds = effectiveSources(db, { planId, ids: picked });
    const current = readScope(db, chatId);
    const storedSubject = liveSubject(
      db,
      (db.prepare(`SELECT subject FROM chats WHERE id = ?`).get(chatId) as
        { subject: string | null } | undefined)?.subject,
    );
    // A subject the student chose with this question (the new chat's chip) is theirs, in the Library's spelling; the
    // whole Library is null. A name no subject has any more (renamed or deleted since the chip showed it) counts as no
    // choice, so the chat keeps its own and Pyxis may still pick.
    const chosen =
      input.subject == null ? input.subject : (liveSubject(db, input.subject) ?? undefined);
    const subject = chosen === undefined ? (storedSubject ?? "") : (chosen ?? "");
    const subjectBy: SubjectBy | undefined = chosen === undefined ? current.subjectBy : "student";
    db.prepare(`UPDATE chats SET scope_json = ?, subject = ? WHERE id = ?`).run(
      scopeJson({ planId, ids: picked, subjectBy }),
      subject || null,
      chatId,
    );
    const userBody =
      notes.length > 0 ? `${input.text}\n\n${notes.join("\n")}` : input.text;
    const pending = db
      .prepare(
        `SELECT id, role, body FROM messages WHERE chat_id = ? ORDER BY created_at DESC LIMIT 1`,
      )
      .get(chatId) as { id: string; role: string; body: string } | undefined;
    let userMessageId =
      replacing?.userId ||
      (pending?.role === "user" && pending.body === userBody ? pending.id : "");
    if (!userMessageId) {
      userMessageId = uuidv7(now + 1);
      db.prepare(
        `INSERT INTO messages (id, chat_id, role, body, created_at) VALUES (?, ?, 'user', ?, ?)`,
      ).run(userMessageId, chatId, userBody, now);
    }
    // A retried turn reuses its user message, so a photo already recorded on it is not recorded twice.
    const hasAttachment = db.prepare(
      `SELECT 1 FROM attachments WHERE message_id = ? AND blob_sha = ? AND mime = ?`,
    );
    const insertAttachment = db.prepare(
      `INSERT INTO attachments (id, message_id, blob_sha, mime, created_at) VALUES (?, ?, ?, ?, ?)`,
    );
    const attach = {
      run: (id: string, messageId: string, sha: string, mime: string, at: number) => {
        if (!hasAttachment.get(messageId, sha, mime))
          insertAttachment.run(id, messageId, sha, mime, at);
      },
    };
    for (const image of images) {
      attach.run(uuidv7(now + 3), userMessageId, image.sha, image.mediaType, now);
      if (image.original)
        attach.run(uuidv7(now + 4), userMessageId, image.original.sha, image.original.mime, now);
    }
    db.prepare(`UPDATE chats SET updated_at = ? WHERE id = ?`).run(now, chatId);
    return { sourceIds, subject, subjectBy, userMessageId, attachedIds };
  };
  // A document this chat already holds (a retry after a failed turn sends the same file again) is reused, not stored twice.
  // Nothing awaits between this lookup and the commit, so the source cannot be removed in between.
  const reused: string[] = [];
  if (staged) {
    const held = db.prepare(
      `SELECT id FROM sources WHERE blob_sha = ? AND library = 0 AND status = 'ready' AND id IN (SELECT value FROM json_each(?))`,
    );
    const scope = JSON.stringify(readScope(db, chatId).ids);
    staged = {
      ...staged,
      documents: staged.documents.filter((doc) => {
        const row = held.get(sha256(doc.bytes), scope) as { id: string } | undefined;
        if (row) reused.push(row.id);
        return !row;
      }),
    };
  }
  const { sourceIds, subject, subjectBy, userMessageId, attachedIds } = staged
    ? commitStaged(db, input.workspace!, staged, (ids) => persist([...new Set([...reused, ...ids])])).value
    : db.transaction(() => persist([]))();
  input.onQuestion?.(userMessageId, chatId);

  const selection =
    input.engine === "strong" ? strongestSelection(db) : selectionFor(db, "chat");
  const seesImage =
    Boolean(input.workspace) &&
    engineSeesImages(selection) &&
    images.some((image) => image.data);
  const thisTurnFile = notes.length > 0 || seesImage;
  // The passages are the main reference, not a gate: a question they do not cover is still answered from the model's own
  // knowledge, and the reply shows it by citing nothing (see replyGrounding).
  // Continue answers from the passages the cut reply was written with, in the same numbering, so the citations in its
  // saved text still point where they did.
  const kept = input.resumeFrom?.passages
    ? keptPassages(db, input.resumeFrom.passages)
    : undefined;
  // Where the turn searches (see docs/engines.md, "What a chat searches"): the files chosen for the chat (an exam's, or
  // ones picked by hand in an older chat) and its subject's files when it has either, otherwise the whole Library. The
  // chat's attachments always come along.
  const attachments = hiddenSources(db, sourceIds);
  const chosen = sourceIds.filter((id) => !attachments.includes(id));
  const subjectFiles = subject ? subjectSourceIds(db, subject) : [];
  // The files that belong to the chat's subject, and its attachments: a reply that cites any other file is "wider".
  const within = subject ? new Set([...subjectFiles, ...attachments]) : null;
  // An exam's chat stays on the exam's files even when it has none (ASK-07); its subject, if any, is searched next.
  const narrowed = chosen.length > 0 || Boolean(planId) || Boolean(subject);
  const scope: SearchScope = narrowed
    ? { sourceIds: [...new Set([...chosen, ...subjectFiles, ...attachments])], withLibrary: false }
    : { sourceIds: attachments, withLibrary: true };
  // A turn that only brings a file, in a chat with nothing chosen, is about that file: the Library is left out of it.
  // An empty Library has nothing to search, so its replies make no claim about the student's material.
  const searches =
    !kept &&
    !(input.allowGeneral || (thisTurnFile && !narrowed)) &&
    (narrowed || attachments.length > 0 || libraryHasPassages(db));
  // The question is embedded once, for its own search and for the search within each attached document.
  const questionEmbed =
    searches || (!kept && attachedIds.length > 0)
      ? await queryEmbedder(input.text, input.embed)
      : input.embed;
  let gathered = kept
    ? { hits: kept.hits, covered: true, usedVectors: false, relevant: [] as string[] }
    : !searches
      ? { hits: [] as PassageHit[], covered: true, usedVectors: false, relevant: [] as string[] }
      : await gather(db, chatId, input.text, scope, input.embed, questionEmbed);
  // A subject with nothing relevant on this question: the whole Library is searched, and the reply says it looked wider.
  let widened = false;
  if (searches && subject && gathered.relevant.length === 0) {
    const wider = await gather(
      db,
      chatId,
      input.text,
      { sourceIds: attachments, withLibrary: true },
      input.embed,
      questionEmbed,
    );
    if (wider.relevant.length > 0) {
      gathered = wider;
      widened = true;
    }
  }
  // What the search did, kept with a reply that cites nothing: a chat with a subject widens to the whole Library before
  // it gives up, and one limited to files looks only in them. A Continue searches nothing.
  const searched: SearchNote | undefined =
    searches && !kept
      ? { found: gathered.relevant.length > 0, where: subject || !narrowed ? "library" : "files" }
      : undefined;
  // Pyxis picks the chat's subject from a search of the whole Library, unless the student already chose (see subject.ts).
  const subjects = sourceSubjects(db, gathered.hits.map((hit) => hit.sourceId));
  const picked =
    searches && !narrowed && !subjectBy
      ? pickSubject(
          gathered.hits.map((hit) => ({
            subject: subjects.get(hit.sourceId) ?? null,
            relevant: gathered.relevant.includes(hit.id),
          })),
        )
      : null;
  const found = {
    ...gathered,
    hits: [
      ...gathered.hits,
      ...(kept ? [] : await attachedPassages(db, input.text, attachedIds, gathered.hits, questionEmbed)),
    ],
  };
  const selected = searches || sourceIds.length > 0 || Boolean(planId) || Boolean(subject);

  const citations: ChatCitation[] = found.hits.map((hit, index) => ({
    label: hit.sectionPath || hit.locator.paragraph || `P${kept?.numbers[index] ?? index + 1}`,
    index: kept?.numbers[index] ?? index + 1,
    passageId: hit.id,
    sourceId: hit.sourceId,
    sectionPath: hit.sectionPath,
    locator: hit.locator,
  }));
  input.onPassages?.(passageLabels(citations));
  const passageBlock =
    citations.length > 0
      ? dataBlock(
          "passages",
          citations
            .map(
              (cite, index) =>
                `[P${cite.index}] ${oneLine(cite.label)}\n${found.hits[index]?.text ?? ""}`,
            )
            .join("\n\n"),
        )
      : "";
  const subjectLine = subject ? `Subject: ${oneLine(subject)}.` : "";
  const pinned = chatContext(db, chatId);
  const pinnedBlock = pinned
    ? `Pinned context: ${oneLine(pinned.title)}\n${dataBlock("pinned", pinned.body)}\n\n`
    : "";
  const attachedBlock =
    notes.length > 0
      ? `Attached text:\n${dataBlock("attached", notes.join("\n"))}\n\n`
      : "";
  const profile = readProfile(db);
  const way = answerWay({ text: input.text, previous: previousWay(db, chatId, replacing?.assistantId), asked: input.way });
  // Nothing searched and no file: the reply can only come from the model's own knowledge.
  const template = chatTemplateId({ way, general: !searches && !thisTurnFile && !kept });
  const where = chatPrompt(db, planId);
  // A guided step asks the student to do the next part, so only solved answers offer figures.
  const python = way === "guided" ? null : await figureRunner(input.python);
  const system = [
    chatSystemPrompt(
      template,
      where.language,
      profile?.followups !== false,
      python != null,
    ),
    profileContext(db, planId, profile),
    where.planLine,
    subjectLine,
  ]
    .filter(Boolean)
    .join("\n");
  const noPassages =
    selected && !input.allowGeneral && !thisTurnFile && citations.length === 0
      ? "No passage matches this question.\n\n"
      : "";
  // What is new for this question goes last, after the parts that stay the same from turn to turn, so a provider's
  // prompt cache keeps the start of the prompt. A conversation the engine still holds gets only the new part.
  // Continue sends the reply that was cut short with the question, so the model writes only what is missing.
  const resume = input.resumeFrom?.text ?? "";
  const resumeBlock = resume
    ? `\n\nYour earlier answer to this question was cut off. It ends here:\n${resume}\n\nContinue from exactly where it stops. Do not repeat any of it.`
    : "";
  const question = `${attachedBlock}${passageBlock}${noPassages}\n\nQuestion:\n${input.text}${resumeBlock}`;
  const prompt = `${pinnedBlock}Earlier turns:\n${historyText(db, chatId, [userMessageId, replacing?.assistantId ?? ""])}\n\n${question}`;
  const followUp = citations.length
    ? `New question. Its passages are numbered from P1 again; cite only these.\n\n${question.trimStart()}`
    : question.trimStart();
  // A regenerated reply replaces one the engine's conversation already holds, so the conversation starts over.
  if (replacing) endConversation(chatId);
  const messageId = uuidv7(now + 2);
  // The engine answering, which differs from the selection when an automatic one was out and another took over.
  let answering: { provider: string; model: string } = selection;
  let streamed = resume;
  let result;
  // Fitting a saved photo can take seconds, so it runs in the extract worker. A photo left out is reported, not dropped silently.
  const saved =
    input.workspace && engineSeesImages(selection)
      ? await savedImages(db, input.workspace, chatId, input.signal)
      : null;
  const skippedImages = saved?.skipped.length ? { skippedImages: saved.skipped } : {};
  try {
    result = await generate({
      prompt,
      system,
      selection,
      attachments: saved
        ? saved.images
        : images
              .filter((image) => image.data)
              .map((image) => ({
                type: "image" as const,
                mediaType: image.mediaType,
                data: image.data,
              })),
      signal: input.signal,
      run: input.run,
      conversation: { key: chatId, followUp },
      cache: true,
      usage: { chatId, messageId, kind: "chat" },
      onEngine: (engine) => (answering = engine),
      onDelta: (text) => {
        requireTutorAvailable(db);
        streamed = resume + text;
        input.onDelta?.(streamed.replace(/<followups>[\s\S]*$/, "").trim());
      },
    });
    // The engine ended the stream without finishing the answer: out of room, or no final event. That is a failure
    // mid-answer like a dropped connection, so the catch below keeps what arrived marked cut off with Continue, saves
    // nothing when nothing arrived, and leaves the earlier reply in place when an answer is regenerated.
    if (result.finishReason === "length" || result.finishReason === "error") {
      if (streamed === resume && result.text.trim() !== "") streamed = resume + result.text;
      throw new IpcError("stream-truncated", "engines.errors.stream-truncated");
    }
  } catch (err) {
    requireTutorAvailable(db);
    const aborted =
      isAbort(err) || (err instanceof Error && err.name === "AbortError");
    // What arrived is kept when the student stops, and when the engine fails mid-answer (a dropped connection, a usage
    // limit), as a reply marked with the failure that offers Continue. A regenerated reply that fails keeps the earlier
    // one instead, and a Continue that added nothing leaves the reply as it was.
    const kept = streamed.trim() !== "" && streamed !== resume;
    if (kept && (aborted || !replacing || resume)) {
      return {
        ...finishReply(db, chatId, streamed, {
          messageId,
          provider: answering.provider,
          model: answering.model,
          selected,
          attached: thisTurnFile,
          widened: widened || Boolean(input.resumeFrom?.widened),
          within,
          searched,
          template,
          citations,
          stopped: true,
          error: aborted ? null : toIpcError(err).messageKey,
          now,
        }),
        ...skippedImages,
      };
    }
    throw err;
  }
  // The prompts no longer ask for it, but a model or an older prompt can still answer NOT_COVERED: nothing is stored.
  if (!resume && result.text.trim().startsWith("NOT_COVERED")) {
    return { chatId, covered: false, message: null };
  }
  const parsed = splitFollowups(resume + result.text);
  if (profile?.followups === false) parsed.followups = [];
  // A figure that fails is left out. The math check runs after the reply is saved (startChecks), on the final text.
  const drawn = await drawFigures(parsed.body, { python: python ?? noSandbox, signal: input.signal });
  parsed.body = drawn.markdown;
  const figures = Object.keys(drawn.figures).length ? drawn.figures : undefined;

  // The reply is saved once its figures are drawn. Its math check runs afterwards (startChecks), so it does not hold the turn.
  requireTutorAvailable(db);
  const reply = saveReply(db, chatId, parsed, {
    messageId,
    provider: result.provider,
    model: result.model,
    selected,
    attached: thisTurnFile,
    widened: widened || Boolean(input.resumeFrom?.widened),
    within,
    searched,
    template,
    citations,
    stopped: false,
    error: null,
    figures,
    now,
  });
  // The subject Pyxis picked is kept only with a whole reply, and only if nobody set one while it was written: a failed
  // or stopped turn leaves the chat as it was.
  if (picked) {
    const scopeNow = readScope(db, chatId);
    if (!scopeNow.subjectBy && !chatSubject(db, chatId))
      db.prepare(`UPDATE chats SET subject = ?, scope_json = ? WHERE id = ?`).run(
        picked,
        scopeJson({ ...scopeNow, subjectBy: "pyxis" }),
        chatId,
      );
  }
  // The check stays on the chat's own engine: it is a short extraction, not part of a stronger answer.
  const checking = way === "solved" && needsSolverChecks(parsed.body);
  if (checking)
    startChecks(
      db,
      { chatId, messageId, body: parsed.body },
      { selection: selectionFor(db, "chat"), run: input.run },
    );
  return { ...reply, message: { ...reply.message!, checking }, ...skippedImages };
}

/** A reply that stopped early: what arrived is kept, marked stopped or with the failure, and offers Continue. */
function finishReply(
  db: Database.Database,
  chatId: string,
  text: string,
  meta: Omit<SavedReply, "figures">,
): AskResult {
  const parsed = splitFollowups(text);
  // Nothing draws a stopped reply's figures, so their blocks go.
  parsed.body = mapFigureBlocks(parsed.body, () => "");
  return saveReply(db, chatId, { body: parsed.body, followups: [] }, meta);
}

type SavedReply = {
  messageId: string;
  provider: string;
  model: string;
  selected: boolean;
  attached: boolean;
  /** The passages came from outside the chat's subject (see replyGrounding). */
  widened: boolean;
  /**
   * The files of the chat's subject and its attachments, null for a chat without a subject. A reply that cites a file
   * outside them is wider even when the search itself did not have to widen (a file picked by hand in an older chat).
   */
  within?: ReadonlySet<string> | null;
  /** What the search did, kept with a reply that ends up citing nothing (see `ChatMessageView.searched`). */
  searched?: SearchNote;
  template: string;
  citations: ChatCitation[];
  stopped: boolean;
  error: string | null;
  figures?: Record<string, string>;
  now: number;
};

/**
 * Stores an assistant reply with the passages it cites, and returns its view. A stopped reply also records every passage
 * it was given, cited or not, so Continue can answer from the same ones in the same numbering.
 */
function saveReply(
  db: Database.Database,
  chatId: string,
  parsed: { body: string; followups: string[] },
  meta: SavedReply,
): AskResult {
  requireChat(db, chatId);
  const { messageId } = meta;
  const stored = `${parsed.body}${
    parsed.followups.length > 0
      ? `\n<followups>\n${parsed.followups.join("\n")}\n</followups>`
      : ""
  }`;
  const used = new Set(
    [...splitCitationGroups(parsed.body).matchAll(/\[P(\d+)\]/g)].map((match) =>
      Number(match[1]),
    ),
  );
  const linked = meta.citations.filter((cite) => used.has(cite.index));
  const { within } = meta;
  const grounding = replyGrounding({
    selected: meta.selected,
    cited: linked.length,
    attached: meta.attached,
    question: meta.template === "chat.socratic" && parsed.body.trim().endsWith("?"),
    passages: meta.citations.length,
    widened: meta.widened || (within != null && linked.some((cite) => !within.has(cite.sourceId))),
  });
  // A finished reply from general knowledge records what the search did, in the column a stopped reply keeps its passages in.
  const note = !meta.stopped && grounding === "general" ? meta.searched : undefined;
  db.prepare(
    `INSERT INTO messages
      (id, chat_id, role, body, engine_provider, model_id, model_source, prompt_template, prompt_version, grounding,
       stopped, error, passages_json, figures_json, created_at)
     VALUES (?, ?, 'assistant', ?, ?, ?, 'reported', ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    messageId,
    chatId,
    stored,
    meta.provider,
    meta.model,
    meta.template,
    // Stored with each assistant message: the template ID and its own version.
    promptProvenance(meta.template as ChatTemplateId).version,
    storedGrounding(grounding),
    meta.stopped ? 1 : 0,
    meta.error,
    meta.stopped
      ? JSON.stringify(
          meta.citations.map((cite): KeptPassage => ({ passageId: cite.passageId, index: cite.index })),
        )
      : note
        ? JSON.stringify(note)
        : null,
    meta.figures ? JSON.stringify(meta.figures) : null,
    meta.now + 1,
  );
  const link = db.prepare(
    `INSERT INTO message_passages (message_id, passage_id, label) VALUES (?, ?, ?)`,
  );
  for (const cite of linked)
    link.run(messageId, cite.passageId, `P${cite.index}`);
  return {
    chatId,
    covered: true,
    message: {
      id: messageId,
      role: "assistant",
      body: parsed.body,
      modelId: meta.model || null,
      provider: meta.provider || null,
      grounding,
      way: wayOfTemplate(meta.template),
      followups: parsed.followups,
      citations: describeCitations(db, linked),
      reaction: null,
      stopped: meta.stopped,
      error: meta.error,
      checks: splitChecks(parsed.body).checks,
      checking: false,
      ...(note ? { searched: note } : {}),
      ...(meta.figures ? { figures: meta.figures } : {}),
    },
  };
}

/**
 * Answers the chat's last question again, replacing the reply that ends the chat once the new one is saved. With
 * `resume` it continues a reply that was cut short instead: the new reply is that text plus what the model adds.
 */
export async function regenerateTurn(
  db: Database.Database,
  input: Omit<AskInput, "text" | "resumeFrom"> & { chatId: string; resume?: boolean },
): Promise<AskResult> {
  const { resume, ...rest } = input;
  requireIdle(input.chatId);
  const last = db
    .prepare(
      `SELECT id, role, body, stopped, passages_json, grounding, prompt_template FROM messages
       WHERE chat_id = ? ORDER BY created_at DESC LIMIT 1`,
    )
    .get(input.chatId) as
    | {
        id: string;
        role: string;
        body: string;
        stopped: number;
        passages_json: string | null;
        grounding: string | null;
        prompt_template: string | null;
      }
    | undefined;
  const user = db
    .prepare(
      `SELECT id, body FROM messages WHERE chat_id = ? AND role = 'user' ORDER BY created_at DESC LIMIT 1`,
    )
    .get(input.chatId) as { id: string; body: string } | undefined;
  if (!user) throw new Error("chat-missing");
  if (resume && !(last?.role === "assistant" && last.stopped === 1))
    throw new IpcError("nothing-to-continue", "errors.internal");
  // The reply being replaced drops its math check.
  if (last?.role === "assistant") cancelChecks(input.chatId, last.id);
  const resumeFrom =
    resume && last
      ? {
          text: splitFollowups(splitChecks(last.body).body).body,
          passages: last.passages_json ? (JSON.parse(last.passages_json) as KeptPassage[]) : null,
          widened: last.grounding === "mixed",
        }
      : undefined;
  // Regenerate and Continue answer the same way as the reply they replace, unless the student asked for the other way.
  const way = input.way ?? (last?.role === "assistant" ? wayOfTemplate(last.prompt_template) : undefined);
  const result = await askTurn(
    db,
    { ...rest, way, text: user.body, resumeFrom },
    last?.role === "assistant"
      ? { assistantId: last.id, userId: user.id }
      : undefined,
  );
  // A continued reply stopped again is still longer than before, so it replaces the earlier one like a finished reply.
  if (result.message?.stopped && last?.role === "assistant" && !resumeFrom) {
    db.prepare("DELETE FROM messages WHERE id = ? AND chat_id = ?").run(result.message.id, input.chatId);
    throw new DOMException("Aborted", "AbortError");
  }
  if (result.message && last?.role === "assistant") {
    db.prepare(`DELETE FROM messages WHERE id = ? AND chat_id = ?`).run(
      last.id,
      input.chatId,
    );
  }
  return result;
}

export function rateMessage(
  db: Database.Database,
  messageId: string,
  reaction: "up" | "down",
): "up" | "down" | null {
  const row = db
    .prepare(`SELECT reaction FROM messages WHERE id = ?`)
    .get(messageId) as { reaction: string | null } | undefined;
  if (!row) throw new Error("message-missing");
  const next = row.reaction === reaction ? null : reaction;
  db.prepare(`UPDATE messages SET reaction = ? WHERE id = ?`).run(
    next,
    messageId,
  );
  return next;
}

export function renameChat(
  db: Database.Database,
  chatId: string,
  title: string,
) {
  const trimmed = title.trim();
  if (!trimmed) throw new Error("chat-title");
  // A rename is not activity: the chat keeps its place in the list, which is ordered by the last message.
  const info = db
    .prepare(`UPDATE chats SET title = ? WHERE id = ?`)
    .run(trimmed, chatId);
  if (info.changes === 0) throw new Error("chat-missing");
}

/**
 * Deletes a chat for good: its messages and citations, the hidden documents it attached (unless another chat, a plan or
 * anything built from them still uses one, or the student promoted it to the library), and the photo and document
 * files nothing else names. The rows go in one transaction; the files are removed after it commits.
 */
export function deleteChat(db: Database.Database, workspace: string, chatId: string) {
  cancelChecks(chatId);
  const hashes = db.transaction(() => {
    const mine = readScope(db, chatId).ids;
    const shared = chatListedSources(db, chatId);
    const photos = db
      .prepare(`SELECT a.blob_sha AS sha FROM attachments a JOIN messages m ON m.id = a.message_id WHERE m.chat_id = ?`)
      .all(chatId) as Array<{ sha: string }>;
    // A hidden document this chat cited but no longer lists (a scope an older turn overwrote), read before the delete
    // removes the citations. `deleteHiddenSources` still keeps it if any other chat, plan or study row uses it.
    const cited = (
      db
        .prepare(
          `SELECT DISTINCT p.source_id AS id FROM message_passages mp
           JOIN messages m ON m.id = mp.message_id
           JOIN passages p ON p.id = mp.passage_id
           JOIN sources s ON s.id = p.source_id
           WHERE m.chat_id = ? AND s.library = 0`,
        )
        .all(chatId) as Array<{ id: string }>
    ).map((row) => row.id);
    const info = db.prepare(`DELETE FROM chats WHERE id = ?`).run(chatId);
    if (info.changes === 0) throw new Error("chat-missing");
    return [
      ...photos.map((row) => row.sha),
      ...deleteHiddenSources(
        db,
        [...new Set([...mine, ...cited])].filter((id) => !shared.has(id)),
      ),
    ];
  })();
  removeUnreferencedBlobs(db, workspace, hashes);
}

export function listChats(db: Database.Database) {
  const rows = db
    .prepare(`SELECT id, title, subject, updated_at FROM chats ORDER BY updated_at DESC`)
    .all() as Array<{ id: string; title: string | null; subject: string | null; updated_at: number }>;
  // Chats named before titles were written as plain text still hold the TeX of a selection.
  return rows.map((row) => ({ ...row, title: row.title?.includes("$") ? plainTitle(row.title, 200) : row.title }));
}

export function heldSources(
  db: Database.Database,
  chatId: string,
): Array<{ id: string; title: string }> {
  const ids = chatScope(db, chatId);
  if (ids.length === 0) return [];
  return db
    .prepare(
      `SELECT id, title FROM sources WHERE library = 0 AND id IN (${ids.map(() => "?").join(", ")})`,
    )
    .all(...ids) as Array<{ id: string; title: string }>;
}

export function chatSubject(
  db: Database.Database,
  chatId: string,
): string | null {
  const row = db
    .prepare(`SELECT subject FROM chats WHERE id = ?`)
    .get(chatId) as { subject: string | null } | undefined;
  return liveSubject(db, row?.subject);
}

/** The note of a finished reply from general knowledge, which a stopped reply's list of passages is not. */
function searchNote(stored: string | null): { searched?: SearchNote } {
  if (!stored) return {};
  try {
    const value = JSON.parse(stored) as Partial<SearchNote> | unknown[];
    if (!Array.isArray(value) && typeof value.found === "boolean" && (value.where === "library" || value.where === "files"))
      return { searched: { found: value.found, where: value.where } };
  } catch {
    return {};
  }
  return {};
}

export function readChat(
  db: Database.Database,
  chatId: string,
): ChatMessageView[] {
  const rows = db
    .prepare(
      `SELECT id, role, body, model_id, engine_provider, grounding, prompt_template, reaction, stopped, figures_json, error,
              passages_json
       FROM messages WHERE chat_id = ? ORDER BY created_at`,
    )
    .all(chatId) as Array<{
    id: string;
    role: "user" | "assistant";
    body: string;
    model_id: string | null;
    engine_provider: string | null;
    grounding: string | null;
    prompt_template: string | null;
    reaction: string | null;
    stopped: number;
    figures_json: string | null;
    error: string | null;
    passages_json: string | null;
  }>;
  const chips = readProfile(db)?.followups !== false;
  // Every message's citations in one read, in the primary key's order, which one read per message also had.
  const links = new Map<string, ChatCitation[]>();
  for (const link of db
    .prepare(
      `SELECT mp.message_id, mp.label, mp.passage_id, p.source_id, p.section_path, p.locator_json
       FROM message_passages mp
       JOIN passages p ON p.id = mp.passage_id
       WHERE mp.message_id IN (SELECT id FROM messages WHERE chat_id = ?)
       ORDER BY mp.message_id, mp.passage_id`,
    )
    .all(chatId) as Array<{
    message_id: string;
    label: string;
    passage_id: string;
    source_id: string | null;
    section_path: string | null;
    locator_json: string | null;
  }>) {
    const list = links.get(link.message_id) ?? [];
    list.push({
      label: link.section_path || link.label,
      index: Number(link.label.replace("P", "")) || 0,
      passageId: link.passage_id,
      sourceId: link.source_id ?? "",
      sectionPath: link.section_path,
      locator: link.locator_json
        ? (JSON.parse(link.locator_json) as PassageHit["locator"])
        : {},
    });
    links.set(link.message_id, list);
  }
  // The files behind every citation, read once for the whole chat.
  const all = describeCitations(db, [...links.values()].flat());
  const described = new Map<string, ChatCitation[]>();
  let at = 0;
  for (const [messageId, list] of links) {
    described.set(messageId, all.slice(at, at + list.length));
    at += list.length;
  }
  return rows.map((row) => {
    const metadata =
      row.role === "assistant"
        ? splitChecks(row.body)
        : { body: row.body, checks: [] };
    const parsed =
      row.role === "assistant"
        ? splitFollowups(metadata.body)
        : { body: metadata.body, followups: [] };
    const citations = described.get(row.id) ?? [];
    return {
      id: row.id,
      role: row.role,
      body: parsed.body,
      modelId: row.model_id,
      provider: row.engine_provider,
      grounding: row.role === "assistant" ? readGrounding(row.grounding) : null,
      way: wayOfTemplate(row.prompt_template),
      followups: chips ? parsed.followups : [],
      citations,
      reaction:
        row.reaction === "up" || row.reaction === "down" ? row.reaction : null,
      stopped: row.stopped === 1,
      error: row.error,
      checks: metadata.checks,
      ...searchNote(row.passages_json),
      ...(row.figures_json
        ? { figures: figureImages(JSON.parse(row.figures_json)) }
        : {}),
      checking: runningChecks.has(row.id),
    };
  });
}
