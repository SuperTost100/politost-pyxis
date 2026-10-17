import { activeSimulation } from "../study/simulation";
import { splitChecks, solverChecks } from "./checks";
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
import { isAbort, IpcError } from "../../shared/ipc";
import { generate } from "../engine/generate";
import { engineSeesImages } from "../engine/capabilities";
import { selectionFor } from "../engine/selection";
import type { Embedder, PassageHit } from "../sources/retrieve";
import { contentWords, retrieveWithModel } from "../sources/retrieve";
import { sha256 } from "../sources/quality";
import { commitStaged, savedImages, stageFiles, type PreparedFiles, type SkippedImage, type StagedFiles } from "./attach";
import { deleteHiddenSources, removeUnreferencedBlobs } from "./delete";
import { contentLanguage, planLanguage } from "../engine/prompts";
import { oneLine, profileContext } from "../profile/context";
import { readProfile } from "../profile/profile";
import {
  type ChatTemplateId,
  chatProvenance,
  chatSystemPrompt,
  chatTemplateId,
  dataBlock,
} from "./prompts";

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
};

export type ChatMessageView = {
  id: string;
  role: "user" | "assistant";
  body: string;
  modelId: string | null;
  provider: string | null;
  grounding: "sources" | "general" | null;
  followups: string[];
  citations: ChatCitation[];
  reaction: "up" | "down" | null;
  stopped: boolean;
  checks: AnchoredCheck[];
  /** Images of the answer's figure blocks, by `figureKey`. */
  figures?: Record<string, string>;
};

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
  mode?: "solver" | "socratic";
  allowGeneral?: boolean;
  subject?: string;
  files?: string[];
  workspace?: string;
  recognize?: (bytes: Uint8Array, cachePath: string) => Promise<string>;
  embed?: Embedder | null;
  signal?: AbortSignal;
  onDelta?: (text: string) => void;
  run?: Parameters<typeof generate>[0]["run"];
  /** Runs figure code; null turns figures off. Defaults to the Pyodide sandbox when its runtime is downloaded. */
  python?: FigureRunner | null;
};

/** Passages a chat turn sends to the model. Questions that ask for a full explanation need more than the default eight. */
const CHAT_PASSAGES = 12;
/** Passages of a document attached to this turn that always go with it, whatever the question says. */
const ATTACHED_PASSAGES = 4;
/** At most this many passages are added for this turn's documents, on top of the ones retrieval found. */
const ATTACHED_TOTAL = 12;
/** Characters of earlier turns sent with a question. Whole messages are kept, newest first. */
const HISTORY_CHARS = 6000;

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
}): "sources" | "general" | null {
  if (turn.cited > 0 || turn.attached) return "sources";
  if (!turn.selected) return null;
  return turn.question && turn.passages > 0 ? "sources" : "general";
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
     WHERE p.source_id = ? AND p.document_id = (
       SELECT id FROM source_documents WHERE source_id = p.source_id ORDER BY version DESC LIMIT 1
     )
     ORDER BY p.rowid LIMIT ?`,
  );
  const taken = new Set(found.map((hit) => hit.id));
  const added: PassageHit[] = [];
  for (const sourceId of sourceIds) {
    const within = await retrieveWithModel(db, text, { sourceIds: [sourceId], embed, limit: ATTACHED_PASSAGES });
    const first = (
      opening.all(sourceId, ATTACHED_PASSAGES) as Array<{
        id: string;
        source_id: string;
        text: string;
        section_path: string | null;
        locator_json: string | null;
      }>
    ).map((row) => ({
      id: row.id,
      sourceId: row.source_id,
      text: row.text,
      sectionPath: row.section_path,
      locator: row.locator_json ? (JSON.parse(row.locator_json) as PassageHit["locator"]) : {},
    }));
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

type Scope = { planId: string | null; ids: string[] };

/** scope_json holds a source ID array, or { planId, sourceIds } for a plan-scoped chat. */
function readScope(db: Database.Database, chatId: string): Scope {
  const row = db
    .prepare(`SELECT scope_json FROM chats WHERE id = ?`)
    .get(chatId) as { scope_json: string } | undefined;
  if (!row) return { planId: null, ids: [] };
  const parsed = JSON.parse(row.scope_json) as unknown;
  const strings = (value: unknown) =>
    Array.isArray(value)
      ? value.filter((id): id is string => typeof id === "string")
      : [];
  if (Array.isArray(parsed)) return { planId: null, ids: strings(parsed) };
  const object = (parsed ?? {}) as { planId?: unknown; sourceIds?: unknown };
  const planId =
    typeof object.planId === "string" &&
    db.prepare(`SELECT 1 FROM plans WHERE id = ?`).get(object.planId)
      ? object.planId
      : null;
  return { planId, ids: strings(object.sourceIds) };
}

function planSourceIds(db: Database.Database, planId: string): string[] {
  return (
    db
      .prepare(`SELECT source_id FROM plan_sources WHERE plan_id = ?`)
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
    .all(chatId) as Array<{
    id: string;
    source_id: string | null;
    text: string;
    section_path: string | null;
    locator_json: string | null;
  }>;
  const seen = new Set<string>();
  const hits: PassageHit[] = [];
  for (const row of rows) {
    if (seen.has(row.id)) continue;
    if (sourceIds.length > 0 && !sourceIds.includes(row.source_id ?? ""))
      continue;
    seen.add(row.id);
    hits.push({
      id: row.id,
      sourceId: row.source_id ?? "",
      text: row.text,
      sectionPath: row.section_path,
      locator: row.locator_json
        ? (JSON.parse(row.locator_json) as PassageHit["locator"])
        : {},
    });
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

async function gather(
  db: Database.Database,
  chatId: string,
  text: string,
  sourceIds: string[],
  embed: AskInput["embed"],
) {
  const options = { sourceIds, embed, limit: CHAT_PASSAGES };
  const found = await retrieveWithModel(db, text, options);
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
  const prior = priorPassages(db, chatId, sourceIds);
  if (prior.length > 0)
    return { hits: prior, covered: true, usedVectors: false };
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
  const context: ChatContext = {
    kind: input.kind,
    title: input.title,
    body: input.body,
  };
  db.prepare(
    `INSERT INTO chats (id, title, scope_json, subject, context_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    chatId,
    input.title.slice(0, 80),
    JSON.stringify(input.planId ? { planId: input.planId, sourceIds: input.sourceIds ?? [] } : input.sourceIds ?? []),
    input.subject ?? null,
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

export async function askTurn(
  db: Database.Database,
  input: AskInput,
  replacing?: { assistantId: string; userId: string },
): Promise<AskResult> {
  requireTutorAvailable(db);
  if (input.signal?.aborted) throw new DOMException("aborted", "AbortError");
  const now = Date.now();
  const chat = ensureChat(db, input.chatId, input.text, now);
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
    const storedSubject = (
      db.prepare(`SELECT subject FROM chats WHERE id = ?`).get(chatId) as
        { subject: string | null } | undefined
    )?.subject;
    const subject =
      input.subject === undefined ? (storedSubject ?? "") : input.subject.trim();
    db.prepare(`UPDATE chats SET scope_json = ?, subject = ? WHERE id = ?`).run(
      JSON.stringify(planId ? { planId, sourceIds: picked } : picked),
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
    return { sourceIds, subject, userMessageId, attachedIds };
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
  const { sourceIds, subject, userMessageId, attachedIds } = staged
    ? commitStaged(db, input.workspace!, staged, (ids) => persist([...new Set([...reused, ...ids])])).value
    : db.transaction(() => persist([]))();

  const seesImage =
    Boolean(input.workspace) &&
    engineSeesImages(selectionFor(db, "chat")) &&
    images.some((image) => image.data);
  const thisTurnFile = notes.length > 0 || seesImage;
  // The passages are the main reference, not a gate: a question they do not cover is still answered from the model's own
  // knowledge, and the reply shows it by citing nothing (see replyGrounding).
  const gathered =
    input.allowGeneral ||
    (thisTurnFile && sourceIds.length === 0) ||
    (planId && sourceIds.length === 0)
      ? { hits: [] as PassageHit[], covered: true, usedVectors: false }
      : await gather(db, chatId, input.text, sourceIds, input.embed);
  const found = {
    ...gathered,
    hits: [
      ...gathered.hits,
      ...(await attachedPassages(db, input.text, attachedIds, gathered.hits, input.embed)),
    ],
  };
  const selected = sourceIds.length > 0 || Boolean(planId) || Boolean(subject);

  const citations: ChatCitation[] = found.hits.map((hit, index) => ({
    label: hit.sectionPath || hit.locator.paragraph || `P${index + 1}`,
    index: index + 1,
    passageId: hit.id,
    sourceId: hit.sourceId,
    sectionPath: hit.sectionPath,
    locator: hit.locator,
  }));
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
  const mode = input.mode ?? profile?.tutorMode ?? "solver";
  const template = chatTemplateId({ ...input, mode });
  const where = chatPrompt(db, planId);
  // A Socratic turn asks a question, so only answers offer figures.
  const python = template === "chat.socratic" ? null : await figureRunner(input.python);
  const system = [
    chatSystemPrompt(
      template,
      where.language,
      profile?.followups !== false,
      python != null,
    ),
    profileContext(db, planId),
    where.planLine,
    subjectLine,
  ]
    .filter(Boolean)
    .join("\n");
  const noPassages =
    selected && !input.allowGeneral && !thisTurnFile && citations.length === 0
      ? "No passage matches this question.\n\n"
      : "";
  const prompt = `${pinnedBlock}${attachedBlock}${passageBlock}${noPassages}\n\nEarlier turns:\n${historyText(db, chatId, [userMessageId, replacing?.assistantId ?? ""])}\n\nQuestion:\n${input.text}`;
  const selection = selectionFor(db, "chat");
  let streamed = "";
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
      onDelta: (text) => {
        requireTutorAvailable(db);
        streamed = text;
        input.onDelta?.(text.replace(/<followups>[\s\S]*$/, "").trim());
      },
    });
  } catch (err) {
    requireTutorAvailable(db);
    if (
      (isAbort(err) || (err instanceof Error && err.name === "AbortError")) &&
      streamed.trim()
    ) {
      return {
        ...finishReply(db, chatId, streamed, {
          provider: selection.provider,
          model: selection.model,
          selected,
          attached: thisTurnFile,
          mode,
          template,
          citations,
          stopped: true,
          now,
        }),
        ...skippedImages,
      };
    }
    throw err;
  }
  // The prompts no longer ask for it, but a model or an older prompt can still answer NOT_COVERED: nothing is stored.
  if (result.text.trim().startsWith("NOT_COVERED")) {
    return { chatId, covered: false, message: null };
  }
  const parsed = splitFollowups(result.text);
  if (profile?.followups === false) parsed.followups = [];
  // The checks and the figures use different sandbox lanes, so they run side by side. A figure that fails is left out.
  const [checks, drawn] = await Promise.all([
    mode !== "socratic"
      ? solverChecks(parsed.body, {
          selection,
          signal: input.signal,
          run: input.run,
        })
      : Promise.resolve([]),
    drawFigures(parsed.body, { python: python ?? noSandbox, signal: input.signal }),
  ]);
  parsed.body = drawn.markdown;
  const figures = Object.keys(drawn.figures).length ? drawn.figures : undefined;

  requireTutorAvailable(db);
  requireChat(db, chatId);
  const stored = `${parsed.body}${
    parsed.followups.length > 0
      ? `\n<followups>\n${parsed.followups.join("\n")}\n</followups>`
      : ""
  }${checks.length ? `\n<checks>${JSON.stringify(checks)}</checks>` : ""}`;
  const messageId = uuidv7(now + 2);
  const used = new Set(
    [...splitCitationGroups(parsed.body).matchAll(/\[P(\d+)\]/g)].map((match) =>
      Number(match[1]),
    ),
  );
  const linked = citations.filter((cite) => used.has(cite.index));
  const grounding = replyGrounding({
    selected,
    cited: linked.length,
    attached: thisTurnFile,
    question: mode === "socratic" && parsed.body.trim().endsWith("?"),
    passages: citations.length,
  });
  db.prepare(
    `INSERT INTO messages
      (id, chat_id, role, body, engine_provider, model_id, model_source, prompt_template, prompt_version, grounding, figures_json, created_at)
     VALUES (?, ?, 'assistant', ?, ?, ?, 'reported', ?, ?, ?, ?, ?)`,
  ).run(
    messageId,
    chatId,
    stored,
    result.provider,
    result.model,
    template,
    chatProvenance(template).version,
    grounding,
    figures ? JSON.stringify(figures) : null,
    now + 1,
  );
  const link = db.prepare(
    `INSERT INTO message_passages (message_id, passage_id, label) VALUES (?, ?, ?)`,
  );
  for (const cite of linked) {
    link.run(messageId, cite.passageId, `P${cite.index}`);
  }
  return {
    chatId,
    covered: true,
    message: {
      id: messageId,
      role: "assistant",
      body: parsed.body,
      modelId: result.model,
      provider: result.provider,
      grounding,
      followups: parsed.followups,
      citations: linked,
      reaction: null,
      stopped: false,
      checks,
      ...(figures ? { figures } : {}),
    },
    ...skippedImages,
  };
}

function finishReply(
  db: Database.Database,
  chatId: string,
  text: string,
  meta: {
    provider: string;
    model: string;
    selected: boolean;
    attached: boolean;
    mode: string;
    template: string;
    citations: ChatCitation[];
    stopped: boolean;
    now: number;
  },
): AskResult {
  requireChat(db, chatId);
  const parsed = splitFollowups(text);
  // Nothing draws a stopped reply's figures, so their blocks go.
  parsed.body = mapFigureBlocks(parsed.body, () => "");
  const messageId = uuidv7(meta.now + 2);
  const used = new Set(
    [...splitCitationGroups(parsed.body).matchAll(/\[P(\d+)\]/g)].map((match) =>
      Number(match[1]),
    ),
  );
  const linked = meta.citations.filter((cite) => used.has(cite.index));
  const grounding = replyGrounding({
    selected: meta.selected,
    cited: linked.length,
    attached: meta.attached,
    question: meta.mode === "socratic" && parsed.body.trim().endsWith("?"),
    passages: meta.citations.length,
  });
  db.prepare(
    `INSERT INTO messages
      (id, chat_id, role, body, engine_provider, model_id, model_source, prompt_template, prompt_version, grounding, stopped, created_at)
     VALUES (?, ?, 'assistant', ?, ?, ?, 'reported', ?, ?, ?, ?, ?)`,
  ).run(
    messageId,
    chatId,
    parsed.body,
    meta.provider,
    meta.model,
    meta.template,
    chatProvenance(meta.template as ChatTemplateId).version,
    grounding,
    meta.stopped ? 1 : 0,
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
      followups: [],
      citations: linked,
      reaction: null,
      stopped: meta.stopped,
      checks: splitChecks(parsed.body).checks,
    },
  };
}

export async function regenerateTurn(
  db: Database.Database,
  input: Omit<AskInput, "text"> & { chatId: string },
): Promise<AskResult> {
  const last = db
    .prepare(
      `SELECT id, role FROM messages WHERE chat_id = ? ORDER BY created_at DESC LIMIT 1`,
    )
    .get(input.chatId) as { id: string; role: string } | undefined;
  const user = db
    .prepare(
      `SELECT id, body FROM messages WHERE chat_id = ? AND role = 'user' ORDER BY created_at DESC LIMIT 1`,
    )
    .get(input.chatId) as { id: string; body: string } | undefined;
  if (!user) throw new Error("chat-missing");
  const result = await askTurn(
    db,
    { ...input, text: user.body },
    last?.role === "assistant"
      ? { assistantId: last.id, userId: user.id }
      : undefined,
  );
  if (result.message?.stopped && last?.role === "assistant") {
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
  const hashes = db.transaction(() => {
    const mine = readScope(db, chatId).ids;
    const shared = new Set(
      (db.prepare(`SELECT id FROM chats WHERE id != ?`).all(chatId) as Array<{ id: string }>).flatMap(
        (row) => readScope(db, row.id).ids,
      ),
    );
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
  return db
    .prepare(`SELECT id, title, updated_at FROM chats ORDER BY updated_at DESC`)
    .all() as Array<{ id: string; title: string | null; updated_at: number }>;
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
  return row?.subject ?? null;
}

export function readChat(
  db: Database.Database,
  chatId: string,
): ChatMessageView[] {
  const rows = db
    .prepare(
      `SELECT id, role, body, model_id, engine_provider, grounding, reaction, stopped, figures_json FROM messages
       WHERE chat_id = ? ORDER BY created_at`,
    )
    .all(chatId) as Array<{
    id: string;
    role: "user" | "assistant";
    body: string;
    model_id: string | null;
    engine_provider: string | null;
    grounding: "sources" | "general" | null;
    reaction: string | null;
    stopped: number;
    figures_json: string | null;
  }>;
  const chips = readProfile(db)?.followups !== false;
  const links = db.prepare(
    `SELECT mp.label, mp.passage_id, p.source_id, p.section_path, p.locator_json
     FROM message_passages mp
     JOIN passages p ON p.id = mp.passage_id
     WHERE mp.message_id = ?`,
  );
  return rows.map((row) => {
    const metadata =
      row.role === "assistant"
        ? splitChecks(row.body)
        : { body: row.body, checks: [] };
    const parsed =
      row.role === "assistant"
        ? splitFollowups(metadata.body)
        : { body: metadata.body, followups: [] };
    const citations = (
      links.all(row.id) as Array<{
        label: string;
        passage_id: string;
        source_id: string | null;
        section_path: string | null;
        locator_json: string | null;
      }>
    ).map((link) => ({
      label: link.section_path || link.label,
      index: Number(link.label.replace("P", "")) || 0,
      passageId: link.passage_id,
      sourceId: link.source_id ?? "",
      sectionPath: link.section_path,
      locator: link.locator_json
        ? (JSON.parse(link.locator_json) as PassageHit["locator"])
        : {},
    }));
    return {
      id: row.id,
      role: row.role,
      body: parsed.body,
      modelId: row.model_id,
      provider: row.engine_provider,
      grounding: row.grounding,
      followups: chips ? parsed.followups : [],
      citations,
      reaction:
        row.reaction === "up" || row.reaction === "down" ? row.reaction : null,
      stopped: row.stopped === 1,
      checks: metadata.checks,
      ...(row.figures_json
        ? { figures: figureImages(JSON.parse(row.figures_json)) }
        : {}),
    };
  });
}
