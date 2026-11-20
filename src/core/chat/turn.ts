import { activeSimulation } from "../study/simulation";
import { checkSelection, needsSolverChecks, NO_SEPARATE_CHECK, splitChecks, solverChecks } from "./checks";
import { stripCheckFences, type AnchoredCheck } from "../../shared/math-check";
import type Database from "better-sqlite3";
import { uuidv7 } from "../../shared/ids";
import {
  figureImages,
  figureKey,
  mapFigureBlocks,
  splitCitationGroups,
} from "../../shared/smart-text";
import {
  drawFigures,
  figureCaptions,
  figureFixer,
  type FigureEvent,
  figureRunner,
  noSandbox,
  type FigureRunner,
} from "../math/figures";
import { isAbort, IpcError, toIpcError, type AttachmentError, type MessageFile } from "../../shared/ipc";
import { generate, startingMove, type GenerateInput } from "../engine/generate";
import { engineSeesImages } from "../engine/capabilities";
import { systemInPrompt } from "../engine/funnel";
import { LOCAL_PROVIDER } from "../engine/local";
import { selectionFor, selectionOn, strongestSelection, type StoredSelection } from "../engine/selection";
import { withUsageScope } from "../engine/usage";
import type { Embedder, PassageHit } from "../sources/retrieve";
import { contentWords, hitOf, queryEmbedder, retrieveWithModel, type PassageRow } from "../sources/retrieve";
import { readingOrder } from "../sources/smartbook";
import { commitStaged, recognisePhoto, savedImages, stagePhoto, type PreparedFiles, type SkippedImage, type StagedBlob } from "./attach";
import type { HeldFiles, TakenFiles } from "./held-files";
import { chatListedSources, deleteHiddenSources, removeUnreferencedBlobs } from "./delete";
import { latestDocument } from "../sources/documents";
import { contentLanguage, planLanguage, promptProvenance } from "../engine/prompts";
import { plainTitle } from "../../shared/spoken-math";
import { oneLine, profileContext } from "../profile/context";
import { readProfile } from "../profile/profile";
import {
  CHAT_TEMPLATE,
  chatSystemPrompt,
  contextBlock,
  dataBlock,
} from "./prompts";
import { liveSubject, pickSubject, sourceSubjects, subjectSourceIds, type SubjectBy } from "./subject";
import {
  addSessionChars,
  contextHash,
  currentSession,
  markOutOfStep,
  recordSession,
  keepSession,
  rewindSession,
  sessionTooLong,
} from "./sessions";

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
  /** The files the question carried, in the order they were attached. */
  files?: MessageFile[];
  modelId: string | null;
  provider: string | null;
  grounding: Grounding | null;
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
  /** Attached files that could not be read and went without, each with its reason. */
  leftOut?: Array<{ name: string; kind: "document" | "photo"; error: AttachmentError }>;
};

type AskInput = {
  chatId?: string;
  text: string;
  sourceIds?: string[];
  /** ASK-07: a plan scopes the chat to the plan's sources; null clears it, undefined keeps it. */
  planId?: string | null;
  allowGeneral?: boolean;
  /** A subject the student chose for the chat, null for the whole Library. Undefined keeps the chat's own. */
  subject?: string | null;
  /** The files attached in the composer, by id. The turn waits until each is read (`held`). */
  attachments?: string[];
  /** The files the composer holds, which `attachments` names. */
  held?: HeldFiles | null;
  workspace?: string;
  recognize?: (bytes: Uint8Array, cachePath: string) => Promise<string>;
  embed?: Embedder | null;
  signal?: AbortSignal;
  onDelta?: (text: string) => void;
  /** Hears each figure of the answer as it is drawn (its picture), or as it is left out (`null`), while the others go on. */
  onFigure?: (event: FigureEvent) => void;
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
  resumeFrom?: {
    text: string;
    passages: KeptPassage[] | null;
    widened?: boolean;
    /** The pictures the stopped reply had saved, by the key of the figure block each is for, which the continuation keeps. */
    figures?: Record<string, string>;
  };
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
/**
 * Characters of the earlier conversation handed to a new tool session, whole messages newest first. The smallest window
 * among the tools' models today is 200,000 tokens (Claude Haiku), and 200,000 characters are about 55,000 tokens: a
 * quarter of it, which leaves room for the system prompt, twelve passages, the question and a long answer, and for the
 * session to grow before the tool compacts it. A local model runs with a 16,384-token window (about 50,000 characters),
 * of which the system prompt, the passages and the answer take most, so it gets 12,000.
 */
const HANDOVER_CHARS = 200_000;
const HANDOVER_CHARS_LOCAL = 12_000;
const handoverChars = (provider: string) => (provider === "ollama" ? HANDOVER_CHARS_LOCAL : HANDOVER_CHARS);

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
 * its source. What counts is whether the reply cites, not what kind of reply it is.
 */
export function replyGrounding(turn: {
  selected: boolean;
  cited: number;
  attached: boolean;
  /** The passages came from outside the chat's subject, which had nothing on the question. */
  widened?: boolean;
}): Grounding | null {
  if (turn.cited > 0) return turn.widened ? "wider" : "sources";
  if (turn.attached) return "sources";
  if (!turn.selected) return null;
  return "general";
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
 * answer loses its check blocks and suggestions. A reply the student stopped is marked as what the student saw. Messages
 * are kept whole, newest first, while they fit in `budget` characters, and no older body is read once it is met; only a
 * newest message longer than the whole budget is cut, at its end. Older messages that do not fit are named in one line,
 * so the model knows the conversation began earlier. With `after`, only the messages after that one (null: all).
 */
/** The text OCR read from the photos of one question, kept beside the files and never shown as the question's own text. */
function storedNotes(db: Database.Database, messageId: string): string[] {
  return db
    .prepare(`SELECT recognised FROM attachments WHERE message_id = ? AND recognised IS NOT NULL AND recognised <> '' ORDER BY created_at, rowid`)
    .pluck()
    .all(messageId) as string[];
}

/** Whether the chat holds a photo that a model reading images could be sent. */
function chatHoldsPhotos(db: Database.Database, chatId: string): boolean {
  return (
    db
      .prepare(
        `SELECT 1 FROM attachments a JOIN messages m ON m.id = a.message_id
         WHERE m.chat_id = ? AND a.mime IN ('image/png', 'image/jpeg', 'image/webp') LIMIT 1`,
      )
      .get(chatId) !== undefined
  );
}

/**
 * The engine for a turn that has a photo. The chat's own when it reads images. A model the student pinned for the chat is
 * a pin: it never moves to another model or tool for a photo, and a photo it cannot read is read by local OCR and sent as
 * text. An automatic choice may move to an image model, of the same tool first, then of another available tool, but never
 * from a local model to a cloud tool: the order of tools only names subscription tools, and a local chat is automatic only
 * when none is signed in, so nothing the student set lets a local chat's photo, question and conversation leave this
 * computer. With no image model to move to, the chat keeps its engine and reads the photo with local OCR.
 */
function selectionForPhotos(db: Database.Database, chat: StoredSelection): StoredSelection {
  if (engineSeesImages(chat)) return chat;
  if (!chat.chosenFor) return chat;
  const sameTool = selectionOn(chat.provider, "vision");
  // Pyxis chose this model for the picture work, so it stays an automatic choice: at a limit, a sign-out or a refused model
  // the call moves on to the next tool's image model (`chosenFor` is what `generate` reads for that).
  if (sameTool && engineSeesImages(sameTool)) return { ...sameTool, chosenFor: "vision" };
  if (chat.provider === LOCAL_PROVIDER) return chat;
  try {
    const vision = selectionFor(db, "vision");
    if (engineSeesImages(vision)) return vision;
  } catch {
    // No engine is chosen for photos: the chat's own engine answers with the text OCR read.
  }
  return chat;
}

function historyText(
  db: Database.Database,
  chatId: string,
  exclude: string[],
  budget: number,
  after?: string | null,
): string {
  const ids = exclude.filter(Boolean);
  const floor = after ? ((db.prepare(`SELECT rowid FROM messages WHERE id = ?`).pluck().get(after) as number | undefined) ?? 0) : 0;
  const filter = `chat_id = ? AND rowid > ?${ids.length ? ` AND id NOT IN (${ids.map(() => "?").join(", ")})` : ""}`;
  const rows = db
    .prepare(`SELECT id, role, body, stopped FROM messages WHERE ${filter} ORDER BY created_at DESC, rowid DESC`)
    .iterate(chatId, floor, ...ids) as Iterable<{ id: string; role: string; body: string; stopped: number }>;
  const lines: string[] = [];
  let used = 0;
  let cut = false;
  for (const row of rows) {
    const body =
      row.role === "assistant"
        ? figureCaptions(
            stripCheckFences(splitFollowups(splitChecks(row.body).body).body),
            "Figure",
          ).trim()
        : [row.body, ...storedNotes(db, row.id)].join("\n\n");
    const line = `${row.role === "assistant" && row.stopped ? "assistant (stopped, the student saw only this)" : row.role}: ${body}`;
    if (used + line.length > budget) {
      if (lines.length === 0) lines.push(`${line.slice(0, budget - 1)}…`);
      cut = true;
      break;
    }
    lines.push(line);
    used += line.length + 1;
  }
  const kept = lines.reverse();
  if (cut) {
    const total = db.prepare(`SELECT COUNT(*) FROM messages WHERE ${filter}`).pluck().get(chatId, floor, ...ids) as number;
    const left = total - kept.length;
    if (left > 0) kept.unshift(`(${left} earlier ${left === 1 ? "message" : "messages"} left out)`);
  }
  return kept.join("\n");
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
       ORDER BY created_at DESC, rowid DESC LIMIT 1`,
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

/** A regenerated reply: the session holds the old answer, which the student no longer sees once the new one is kept. */
const ASKED_AGAIN =
  "The student asked for this question to be answered again. Your earlier answer to it is discarded and the student sees only the new one.\n\n";

/** The message just before `messageId` in its chat, or null: what the first prompt of a session started at it held. */
function messageBefore(db: Database.Database, chatId: string, messageId: string): string | null {
  return (
    (db
      .prepare(
        `SELECT id FROM messages WHERE chat_id = ? AND rowid < (SELECT rowid FROM messages WHERE id = ?)
         ORDER BY rowid DESC LIMIT 1`,
      )
      .pluck()
      .get(chatId, messageId) as string | undefined) ?? null
  );
}

export async function askTurn(
  db: Database.Database,
  input: AskInput,
  replacing?: { assistantId: string; userId: string },
): Promise<AskResult> {
  requireTutorAvailable(db);
  if (input.signal?.aborted) throw new DOMException("aborted", "AbortError");
  requireIdle(input.chatId);
  // A message is stored at the turn's start and its reply one millisecond later. A turn that starts in the same
  // millisecond as the reply before it, or after the clock stepped back, would sort before it, so a turn never starts
  // earlier than the last message of its chat.
  const last = input.chatId
    ? (db.prepare(`SELECT MAX(created_at) FROM messages WHERE chat_id = ?`).pluck().get(input.chatId) as number | null)
    : null;
  const now = Math.max(Date.now(), (last ?? 0) + 1);
  const chat = ensureChat(db, input.chatId, input.text, now);
  // Stop also stops a math check still running for an earlier reply in this chat.
  const stopChecks = () => cancelChecks(chat.id);
  input.signal?.addEventListener("abort", stopChecks, { once: true });
  generating.add(chat.id);
  try {
    const report: { leftOut?: TakenFiles["leftOut"]; question?: string } = {};
    const result = await answer(db, input, replacing, chat.id, now, report);
    // The question is answered, so the files tied to it let go: the chat holds the ones its rows name, and a copy it already
    // had or a file that could not be read goes. Until now a send that failed kept every chip as it was.
    if (report.question) input.held?.finishSend(report.question);
    // A new chat takes the composer the draft was in: the files left in it belong to the chat now.
    if (chat.created) input.held?.rehome(input.chatId ?? "", chat.id);
    return report.leftOut?.length
      ? { ...result, leftOut: report.leftOut.map(({ name, kind, error }) => ({ name, kind, error })) }
      : result;
  } catch (err) {
    // A chat this turn created and could not answer is removed with its question and attachments. The student's
    // message goes back to the composer, so a retry starts one new chat instead of leaving an empty one behind.
    if (
      chat.created &&
      db.prepare(`SELECT 1 FROM chats WHERE id = ?`).get(chat.id) &&
      !db.prepare(`SELECT 1 FROM messages WHERE chat_id = ? AND role = 'assistant'`).get(chat.id)
    )
      // The files still held in the composer stay, with the copies they made, for the retry: their rows name them.
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
  report: { leftOut?: TakenFiles["leftOut"]; question?: string },
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
  // The files were read when they were attached. The turn waits for any still being read and goes on without the ones that
  // failed, which the reply names.
  let taken: TakenFiles | undefined;
  if (input.attachments && input.attachments.length > 0 && input.held) {
    await input.held.settle(input.attachments, input.signal);
    taken = input.held.take(input.attachments);
    report.leftOut = taken.leftOut;
  }
  // A question left unanswered (a failed turn, then Try again) is the chat's last row and is answered, not replaced: its
  // own text is read from the same stored place.
  const lastRow = db
    .prepare(`SELECT id, role, body FROM messages WHERE chat_id = ? ORDER BY created_at DESC LIMIT 1`)
    .get(chatId) as { id: string; role: string; body: string } | undefined;
  const reusedQuestion =
    replacing?.userId || (lastRow?.role === "user" && lastRow.body === input.text ? lastRow.id : "");
  // A turn with a photo runs on a model that reads it when the choice is automatic: the chat's tool has one, or another
  // available tool. So does every later turn of a chat that holds a photo: its session holds the image, and a model without
  // image input may not resume it, and could not answer about the photo anyway.
  const chatSelection: StoredSelection =
    input.engine === "strong" ? strongestSelection(db) : selectionFor(db, "chat");
  const photosHere = (taken?.photos.length ?? 0) > 0 || chatHoldsPhotos(db, chatId);
  const selection = photosHere ? selectionForPhotos(db, chatSelection) : chatSelection;
  const reads = Boolean(input.workspace) && engineSeesImages(selection);
  // The text local OCR read from photos is sent with the question and stored apart from it. A regenerated turn reads the
  // text stored with its question.
  const notes: string[] = reusedQuestion ? storedNotes(db, reusedQuestion) : [];
  const images: PreparedFiles["images"] = [];
  const blobs: StagedBlob[] = [];
  const photoRows: Array<{ id: string; name: string; size: number; image: PreparedFiles["images"][number]; text: string }> = [];
  for (const photo of taken?.photos ?? []) {
    const one = await stagePhoto(photo, reads, input.signal);
    // Local OCR is the last resort: no model of the chat reads images, or the photo has no copy a model can take (a valid
    // photo past the provider's size limit), so the model would get neither pixels nor text.
    let text = "";
    if (!((reads && one.image.data) || !input.workspace)) {
      try {
        text = await recognisePhoto(photo, input.workspace, input.recognize, input.signal);
      } catch (error) {
        // A stop, and the refusals about the OCR data (which the student answers), end the turn as they did. Any other
        // failure of local OCR leaves this photo out, named, so the question goes out and a retry does not fail again.
        if (input.signal?.aborted || isAbort(error) || error instanceof IpcError) throw error;
        report.leftOut = [...(report.leftOut ?? []), { id: photo.id, name: photo.name, kind: "photo", error: "unreadable" }];
        continue;
      }
    }
    input.signal?.throwIfAborted();
    if (text && !notes.includes(text)) notes.push(text);
    blobs.push(...one.blobs);
    images.push(one.image);
    photoRows.push({ id: photo.id, name: photo.name, size: photo.size, image: one.image, text });
  }
  // A document this chat already holds (the same file attached again, or a retry) is used from there, and the copy made
  // for this message is dropped after the commit. Nothing awaits between this lookup and the commit.
  const sameDocument = db.prepare(
    `SELECT id FROM sources WHERE blob_sha = (SELECT blob_sha FROM sources WHERE id = ?) AND id <> ? AND library = 0
     AND status = 'ready' AND id IN (SELECT value FROM json_each(?))`,
  );
  const scopeNow = JSON.stringify(readScope(db, chatId).ids);
  const documents = (taken?.documents ?? []).map((doc) => {
    const held = sameDocument.get(doc.sourceId, doc.sourceId, scopeNow) as { id: string } | undefined;
    return { ...doc, use: held?.id ?? doc.sourceId, duplicate: held != null };
  });
  // A question answered again (Try again) brings the documents it was stored with, as it did when it was sent.
  const questionDocs = reusedQuestion
    ? (db.prepare(`SELECT source_id FROM attachments WHERE message_id = ? AND source_id IS NOT NULL`).pluck().all(reusedQuestion) as string[])
    : [];
  const reused = [...new Set([...documents.map((doc) => doc.use), ...questionDocs])];

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
    // The text of the question is what the student typed. What OCR read from a photo is kept beside the file.
    const userBody = input.text;
    const pending = db
      .prepare(
        `SELECT id, role, body FROM messages WHERE chat_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`,
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
    // Each file is recorded with its name, so the question shows it. A photo's fitted copy carries the name and the text OCR
    // read, and its original (a HEIC, or a photo cut down to fit) is a plain row that a resend skips.
    const named = db.prepare(
      `UPDATE attachments SET name = ?, kind = ?, size = ?, source_id = ?, recognised = ? WHERE message_id = ? AND blob_sha = ? AND mime = ?`,
    );
    const sourceRow = db.prepare(`SELECT blob_sha AS sha, mime FROM sources WHERE id = ?`);
    const hasDocument = db.prepare(`SELECT 1 FROM attachments WHERE message_id = ? AND source_id = ?`);
    const order = taken?.order ?? [];
    const listed = [
      ...photoRows.map((row) => ({ id: row.id, photo: row })),
      ...documents.map((doc) => ({ id: doc.id, doc })),
    ].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
    for (const item of listed) {
      if ("photo" in item) {
        const { image } = item.photo;
        attach.run(uuidv7(now + 3), userMessageId, image.sha, image.mediaType, now);
        named.run(item.photo.name, "photo", item.photo.size, null, item.photo.text || null, userMessageId, image.sha, image.mediaType);
        if (image.original)
          attach.run(uuidv7(now + 4), userMessageId, image.original.sha, image.original.mime, now);
        continue;
      }
      const doc = item.doc;
      const source = sourceRow.get(doc.use) as { sha: string | null; mime: string | null } | undefined;
      if (!source?.sha || !source.mime || hasDocument.get(userMessageId, doc.use)) continue;
      db.prepare(
        `INSERT INTO attachments (id, message_id, blob_sha, mime, created_at, name, kind, size, source_id)
         VALUES (?, ?, ?, ?, ?, ?, 'document', ?, ?)`,
      ).run(uuidv7(now + 5), userMessageId, source.sha, source.mime, now, doc.name, doc.size, doc.use);
    }
    db.prepare(`UPDATE chats SET updated_at = ? WHERE id = ?`).run(now, chatId);
    return { sourceIds, subject, subjectBy, userMessageId, attachedIds };
  };
  const { sourceIds, subject, subjectBy, userMessageId, attachedIds } = commitStaged(db, input.workspace ?? "", blobs, () =>
    persist(reused),
  );
  // The files are tied to the question they went with, whatever the send does next.
  report.question = userMessageId;
  input.held?.tie([...(taken?.order ?? []), ...(taken?.leftOut.map((file) => file.id) ?? [])], userMessageId);
  input.onQuestion?.(userMessageId, chatId);

  const seesImage = reads && images.some((image) => image.data);
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
  // A file attached to this question is its own source: a photo that went with it, or a document whose passages did. A reply
  // that cites none of them is still not "general knowledge", so the line above it does not say nothing was found.
  const ownSource = thisTurnFile || found.hits.some((hit) => attachedIds.includes(hit.sourceId));

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
    ? `Pinned context: ${oneLine(pinned.title)}\n${dataBlock("pinned", pinned.body)}`
    : "Pinned context: none.";
  const attachedBlock =
    notes.length > 0
      ? `Attached text:\n${dataBlock("attached", notes.join("\n"))}\n\n`
      : "";
  const profile = readProfile(db);
  const template = CHAT_TEMPLATE;
  const where = chatPrompt(db, planId);
  const drawer = await figureRunner(input.python);
  // The system prompt is the same for the whole chat. What changes from turn to turn is in the context block that opens
  // the message, which a tool's session gets only when it differs from the one it last received.
  const system = chatSystemPrompt();
  const header = `${contextBlock({
    language: where.language,
    planLine: where.planLine,
    subject: subjectLine,
    profile: profileContext(db, planId, profile),
    followups: profile?.followups !== false,
    figures: drawer?.kinds ?? [],
  })}\n${pinnedBlock}`;
  const told = contextHash(header);
  const noPassages =
    selected && !input.allowGeneral && !thisTurnFile && citations.length === 0
      ? "No passage matches this question.\n\n"
      : "";
  // What is new for this question goes last, after the parts that stay the same from turn to turn. Continue sends the
  // reply that was cut short with the question, so the model writes only what is missing.
  const resume = input.resumeFrom?.text ?? "";
  const resumeBlock = resume
    ? `\n\nYour earlier answer to this question was cut off. It ends here:\n${resume}\n\nContinue from exactly where it stops. Do not repeat any of it.`
    : "";
  const question = `${attachedBlock}${passageBlock}${noPassages}\n\nQuestion:\n${input.text}${resumeBlock}`;
  const exclude = [userMessageId, replacing?.assistantId ?? ""];
  // The tool session the chat stored, when this turn can continue it. A session in step already holds the conversation,
  // so the message is the new question, with the context block when it changed. A session out of step (a turn on it
  // stopped, failed, was not kept, or another engine answered it) gets the full context block and what the student sees
  // since the last turn that was in step, and is in step again once this turn completes. A new session gets the context
  // block and the whole conversation instead.
  const stored = currentSession(db, chatId);
  const long = Boolean(stored && sessionTooLong(stored));
  const session = stored && !long ? stored : undefined;
  // A session keeps the instructions it was opened under. Cursor Agent and Antigravity carry them inside the first prompt,
  // so when the chat's system prompt is not the one the session has (an edit of the template since), it is out of step and
  // this turn delivers the current one. The tools that take a system prompt on every call need nothing more.
  const instructions = contextHash(system);
  const instructionsChanged = Boolean(session && session.instructions !== instructions);
  const outOfStep = Boolean(session && (!session.inStep || instructionsChanged));
  const newQuestion = citations.length
    ? `New question. Its passages are numbered from P1 again; cite only these.\n\n${question.trimStart()}`
    : question.trimStart();
  // The follow-up depends on the tool that resumes the session, which an automatic choice can change inside
  // `generate()`: whether the instructions travel in the prompt, and the size of the replay. So it is built for the
  // provider of each attempt, and only when that attempt resumes.
  const followUpFor = (provider: string) => {
    const newInstructions =
      instructionsChanged && systemInPrompt(provider)
        ? `<instructions>\n${system}\n</instructions>\nThese instructions replace any you were given before.\n\n`
        : "";
    const replay = outOfStep ? historyText(db, chatId, exclude, handoverChars(provider), session!.syncedTo) : "";
    const replayBlock = replay
      ? `The conversation as the student sees it, since the last turn you completed. This, not anything you remember differently, is the conversation. A reply marked stopped was cut off, and the student saw only the text shown.\n${replay}\n\n`
      : "";
    return `${newInstructions}${outOfStep || session?.told !== told ? `${header}\n\n` : ""}${replayBlock}${replacing && !resume ? ASKED_AGAIN : ""}${newQuestion}`;
  };
  // The conversation handed to a new session is sized to the window of the engine that answers, which an automatic choice
  // can change inside `generate()`. It is built only when a prompt is sent: a fresh start or a retry after a lost session.
  const promptFor = (provider: string) => {
    const earlier = historyText(db, chatId, exclude, handoverChars(provider));
    return `${header}\n\n${earlier ? `Earlier turns:\n${earlier}\n\n` : ""}${question}`;
  };
  const beforeQuestion = messageBefore(db, chatId, userMessageId);
  const messageId = uuidv7(now + 2);
  // The engine answering, which differs from the selection when an automatic one was out and another took over.
  let answering: { provider: string; model: string; effort?: string } = selection;
  let streamed = resume;
  let result;
  // Fitting a saved photo can take seconds, so it runs in the extract worker. A photo left out is reported, not dropped silently.
  const saved =
    input.workspace && engineSeesImages(selection)
      ? await savedImages(db, input.workspace, chatId, input.signal)
      : null;
  const skippedImages = saved?.skipped.length ? { skippedImages: saved.skipped } : {};
  /** What arrived, saved as a reply that stopped early: marked stopped, or with the failure, and offering Continue. */
  const stopReply = (
    text: string,
    error: string | null,
    drawn?: { markdown: string; figures: Record<string, string> },
    /** The model finished the reply before it was stopped (while its figures were drawn). */
    completed = false,
  ) => {
    const reply = {
    ...finishReply(
      db,
      chatId,
      text,
      {
        messageId,
        provider: answering.provider,
        model: answering.model,
        selected,
        attached: ownSource,
        widened: widened || Boolean(input.resumeFrom?.widened),
        within,
        searched,
        template,
        citations,
        stopped: true,
        error,
        now,
      },
      drawn,
      input.resumeFrom?.figures,
    ),
    ...skippedImages,
    };
    // A stopped reply that the model completed and that stays on screen (not a regenerated replacement, which is
    // dropped) is what the student sees, and its session holds it whole.
    if (completed && !(replacing && !input.resumeFrom)) keepSession(db, chatId, answering.provider, messageId);
    return reply;
  };
  // From here no open session of the chat can be trusted to hold the conversation until one completes this turn.
  markOutOfStep(db, chatId);
  // A session the tool opened during this turn received the whole prompt, not the follow-up.
  let startedSession = false;
  // A photo read as text for a planned text-only tool still goes as a picture to the tool that answers, if that one reads
  // images (an automatic choice that fell back to it). It is decided for each attempt, as the prompt is. A pinned chat, and a
  // photo turn on a local model, have no fallback.
  const fallbackCopies =
    !reads
      ? images.flatMap((image) => (image.copy ? [{ type: "image" as const, mediaType: image.mediaType, data: image.copy }] : []))
      : [];
  try {
    result = await generate({
      prompt: "",
      promptFor,
      followUpFor,
      system,
      // A turn that holds a photo on a local model stays on this computer: the photo, the text read from it and the
      // conversation would all reach a cloud tool in a fallback. Without `chosenFor` the choice has no fallback, as a
      // pinned one has none, and a failure of the local model ends the turn with its own error.
      selection: photosHere && selection.provider === LOCAL_PROVIDER ? { ...selection, chosenFor: undefined } : selection,
      ...(fallbackCopies.length
        ? { attachmentsFor: (answering) => (engineSeesImages(answering) ? fallbackCopies : undefined) }
        : {}),
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
      conversation: {
        key: chatId,
        followUp: "",
        session: session ? { provider: session.provider, id: session.sessionId, cwd: session.cwd, seen: session.seen } : null,
        // A tool that keeps what it was sent keeps a turn the student stops, so the session is stored when it begins.
        // Cursor Agent loses such a turn, so its session is stored when the turn ends.
        onSession: (sessionId, provider, cwd) => {
          if (provider === "agent") return;
          const open = currentSession(db, chatId);
          if (open?.provider === provider && open.sessionId === sessionId) return;
          startedSession = true;
          recordSession(db, chatId, open, { provider, sessionId, cwd, model: answering.model, effort: answering.effort ?? null, told: "", instructions, chars: 0, now: Date.now(), finished: false, syncedTo: beforeQuestion }, long ? "long" : "gone");
        },
      },
      cache: true,
      usage: { chatId, messageId, kind: "chat" },
      onEngine: (engine) => (answering = engine),
      onDelta: (text) => {
        requireTutorAvailable(db);
        streamed = resume + text;
        input.onDelta?.(streamed.replace(/<followups>[\s\S]*$/, "").trim());
      },
    });
    // The turn's session is stored for the next one. A turn that did not continue it (another tool answered, or the
    // tool started a new session) ends it and opens the new one.
    if (result.sessionId && result.cwd) {
      const open = currentSession(db, chatId);
      recordSession(
        db,
        chatId,
        open,
        {
          provider: result.provider,
          sessionId: result.sessionId,
          cwd: result.cwd,
          model: result.model,
          effort: answering.effort ?? null,
          told,
          instructions,
          chars: (result.continued ? followUpFor(result.provider) : promptFor(result.provider)).length + result.text.length,
          now: Date.now(),
          finished: true,
          syncedTo: beforeQuestion,
          seen: result.seen,
        },
        long ? "long" : "gone",
      );
    }
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
    // The tool kept what it was sent, and with Antigravity the start of the reply too, which counts toward the size at
    // which a session starts over. Cursor Agent loses a turn that did not finish.
    const sent = !startedSession && session && answering.provider === session.provider ? followUpFor(answering.provider) : promptFor(answering.provider);
    addSessionChars(
      db,
      chatId,
      answering.provider,
      answering.provider === "antigravity" ? sent.length + streamed.length : answering.provider === "agent" ? 0 : sent.length,
    );
    const kept = streamed.trim() !== "" && streamed !== resume;
    if (kept && (aborted || !replacing || resume))
      return stopReply(streamed, aborted ? null : toIpcError(err).messageKey);
    throw err;
  }
  // The prompts no longer ask for it, but a model or an older prompt can still answer NOT_COVERED: nothing is stored.
  if (!resume && result.text.trim().startsWith("NOT_COVERED")) {
    return { chatId, covered: false, message: null };
  }
  const parsed = splitFollowups(resume + result.text);
  if (profile?.followups === false) parsed.followups = [];
  // A figure that fails is left out. The math check runs after the reply is saved (startChecks), on the final text.
  // The figures are drawn together and each is told as it is drawn (`onFigure`), so the page shows it in its place without
  // waiting for the others. Stop pressed meanwhile: the whole answer is already read, so it is kept as a stopped reply
  // with the figures that were drawn before the stop, and the ones still in progress are left out. The chat stays.
  let drawn;
  try {
    drawn = await drawFigures(parsed.body, {
      python: drawer?.run ?? noSandbox,
      kinds: drawer?.kinds ?? [],
      // The fix call is counted with this chat's tokens and stops with the turn.
      fix: figureFixer({ selection, run: input.run, signal: input.signal, usage: { chatId, messageId, kind: "chat" } }),
      signal: input.signal,
      // A continued reply keeps the pictures its figures already had, drawn again by nobody.
      known: input.resumeFrom?.figures,
      onFigure: input.onFigure,
    });
  } catch (err) {
    requireTutorAvailable(db);
    if (isAbort(err) || (err instanceof Error && err.name === "AbortError"))
      return stopReply(resume + result.text, null, undefined, true);
    throw err;
  }
  if (drawn.stopped) {
    requireTutorAvailable(db);
    return stopReply(resume + result.text, null, drawn, true);
  }
  parsed.body = drawn.markdown;
  const figures = Object.keys(drawn.figures).length ? drawn.figures : undefined;

  // The reply is saved once its figures are drawn. Its math check runs afterwards (startChecks), so it does not hold the turn.
  requireTutorAvailable(db);
  const reply = saveReply(db, chatId, parsed, {
    messageId,
    provider: result.provider,
    model: result.model,
    selected,
    attached: ownSource,
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
  keepSession(db, chatId, result.provider, messageId);
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
  // The check is a short extraction, not part of a stronger answer, so it runs on the cheapest ready tool (`checkSelection`).
  // It is a model call of its own that the tool does not save, so it runs only for an answer that states maths and has no
  // check blocks of its own (the template asks for them inline), and never on a tool in `NO_SEPARATE_CHECK` (see there),
  // which `solverChecks` also applies to the tool that runs each attempt. The engine is looked up only when a check is
  // needed: with none assigned at this moment the saved reply is returned as it is.
  let checking = false;
  if (needsSolverChecks(parsed.body)) {
    try {
      const checkEngine = checkSelection(db);
      // The tool that would run the check is the one `generate()` starts with, which is not the chat's own when that
      // one is out of requests.
      const runsOn = (startingMove({ selection: checkEngine })?.to ?? checkEngine).provider;
      checking = !NO_SEPARATE_CHECK.has(runsOn);
      if (checking)
        startChecks(db, { chatId, messageId, body: parsed.body }, { selection: checkEngine, run: input.run });
    } catch (err) {
      if (!(err instanceof IpcError && err.code === "engine-missing")) throw err;
    }
  }
  return { ...reply, message: { ...reply.message!, checking }, ...skippedImages };
}

/** A reply that stopped early: what arrived is kept, marked stopped or with the failure, and offers Continue. */
function finishReply(
  db: Database.Database,
  chatId: string,
  text: string,
  meta: Omit<SavedReply, "figures">,
  /** The text with the figures that were drawn before the stop and their pictures, when the stop came while they were. */
  drawn?: { markdown: string; figures: Record<string, string> },
  /** The pictures a continued reply had saved: its figure blocks that have one stay, with their pictures. */
  carried?: Record<string, string>,
): AskResult {
  if (drawn)
    return saveReply(
      db,
      chatId,
      { body: drawn.markdown, followups: [] },
      { ...meta, ...(Object.keys(drawn.figures).length ? { figures: drawn.figures } : {}) },
    );
  const parsed = splitFollowups(text);
  // A reply stopped while it was written has nothing drawn of its own, so its figure blocks go. A continued one keeps the
  // blocks that already had a picture, with it, as the reply it continues did.
  const figures: Record<string, string> = {};
  parsed.body = mapFigureBlocks(parsed.body, (figure) => {
    const key = figure ? figureKey(figure.code, figure.figureKind) : "";
    const image = carried?.[key];
    if (!image) return "";
    figures[key] = image;
    return null;
  });
  return saveReply(db, chatId, { body: parsed.body, followups: [] }, { ...meta, ...(Object.keys(figures).length ? { figures } : {}) });
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
    promptProvenance(CHAT_TEMPLATE).version,
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
      `SELECT id, role, body, stopped, passages_json, figures_json, grounding, prompt_template FROM messages
       WHERE chat_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    )
    .get(input.chatId) as
    | {
        id: string;
        role: string;
        body: string;
        stopped: number;
        passages_json: string | null;
        figures_json: string | null;
        grounding: string | null;
        prompt_template: string | null;
      }
    | undefined;
  const user = db
    .prepare(
      `SELECT id, body FROM messages WHERE chat_id = ? AND role = 'user' ORDER BY created_at DESC, rowid DESC LIMIT 1`,
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
          ...(last.figures_json ? { figures: figureImages(JSON.parse(last.figures_json)) } : {}),
        }
      : undefined;
  // The tool's session was told this question is answered again and the earlier answer discarded. When the new answer
  // fails or is stopped, the earlier one stays on screen: the session holds the conversation only up to the message before
  // that question's earlier replies, so the next message replays the question and the answer the student sees.
  const keepsEarlier = () => {
    if (last?.role === "assistant" && !resumeFrom) rewindSession(db, input.chatId, user.id);
  };
  const result = await askTurn(
    db,
    { ...rest, text: user.body, resumeFrom },
    last?.role === "assistant"
      ? { assistantId: last.id, userId: user.id }
      : undefined,
  ).catch((err: unknown) => {
    keepsEarlier();
    throw err;
  });
  // A continued reply stopped again is still longer than before, so it replaces the earlier one like a finished reply.
  if (result.message?.stopped && last?.role === "assistant" && !resumeFrom) {
    db.prepare("DELETE FROM messages WHERE id = ? AND chat_id = ?").run(result.message.id, input.chatId);
    keepsEarlier();
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
       FROM messages WHERE chat_id = ? ORDER BY created_at, rowid`,
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
  // The files each question carried, in one read. A photo sent before names were kept has a row with the image type and
  // nothing else; the plain image rows and the originals kept beside a fitted copy are not files of their own.
  const files = new Map<string, MessageFile[]>();
  for (const row of db
    .prepare(
      `SELECT a.message_id, a.id, a.name, a.kind, a.size, a.source_id, a.blob_sha, a.mime,
              EXISTS (SELECT 1 FROM sources s WHERE s.id = a.source_id AND s.status <> 'removed') AS open
       FROM attachments a WHERE a.message_id IN (SELECT id FROM messages WHERE chat_id = ?)
       AND (a.kind IS NOT NULL OR a.mime IN ('image/png', 'image/jpeg', 'image/webp'))
       ORDER BY a.created_at, a.rowid`,
    )
    .all(chatId) as Array<{
    message_id: string;
    id: string;
    name: string | null;
    kind: "photo" | "document" | null;
    size: number | null;
    source_id: string | null;
    blob_sha: string;
    mime: string;
    open: number;
  }>) {
    const list = files.get(row.message_id) ?? [];
    list.push({
      id: row.id,
      name: row.name,
      kind: row.kind ?? "photo",
      size: row.size,
      sourceId: row.open ? row.source_id : null,
      sha: row.kind === "document" ? null : row.blob_sha,
      mime: row.mime,
    });
    files.set(row.message_id, list);
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
      ...(files.has(row.id) ? { files: files.get(row.id) } : {}),
      modelId: row.model_id,
      provider: row.engine_provider,
      grounding: row.role === "assistant" ? readGrounding(row.grounding) : null,
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
