import type Database from "better-sqlite3";
import { uuidv7 } from "../../shared/ids";
import { isAbort } from "../../shared/ipc";
import { generate } from "../engine/generate";
import { selectionFor } from "../engine/selection";
import type { Embedder, PassageHit } from "../sources/retrieve";
import { contentWords, retrieve } from "../sources/retrieve";
import {
  CHAT_PROMPT_VERSION,
  generalPrompt,
  socraticPrompt,
  solverPrompt,
} from "./prompts";

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
  grounding: "sources" | "general" | null;
  followups: string[];
  citations: ChatCitation[];
  reaction: "up" | "down" | null;
};

export type AskResult = {
  chatId: string;
  covered: boolean;
  message: ChatMessageView | null;
};

type AskInput = {
  chatId?: string;
  text: string;
  sourceIds?: string[];
  mode?: "solver" | "socratic";
  allowGeneral?: boolean;
  embed?: Embedder | null;
  signal?: AbortSignal;
  run?: Parameters<typeof generate>[0]["run"];
};

function profileContext(db: Database.Database): string {
  const row = db
    .prepare(
      `SELECT display_name, education_level, course, content_language FROM profile LIMIT 1`,
    )
    .get() as
    | {
        display_name: string | null;
        education_level: string | null;
        course: string | null;
        content_language: string | null;
      }
    | undefined;
  if (!row) return "";
  return `Student: ${row.display_name ?? ""}. Level: ${row.education_level ?? ""}. Course: ${row.course ?? ""}. Write all output in ${row.content_language ?? "the student's language"}.`;
}

function splitFollowups(text: string): { body: string; followups: string[] } {
  const match = text.match(/<followups>([\s\S]*?)<\/followups>/i);
  if (!match?.[1]) return { body: text.trim(), followups: [] };
  const followups = match[1]
    .split("\n")
    .map((line) => line.replace(/^[-*\d.)\s]+/, "").trim())
    .filter(Boolean)
    .slice(0, 3);
  return { body: text.replace(match[0], "").trim(), followups };
}

function historyText(db: Database.Database, chatId: string): string {
  const rows = db
    .prepare(
      `SELECT role, body FROM messages WHERE chat_id = ? ORDER BY created_at DESC LIMIT 8`,
    )
    .all(chatId) as Array<{ role: string; body: string }>;
  return rows
    .reverse()
    .map((row) => `${row.role}: ${row.body}`)
    .join("\n")
    .slice(-6000);
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

export function chatScope(db: Database.Database, chatId: string): string[] {
  const row = db.prepare(`SELECT scope_json FROM chats WHERE id = ?`).get(chatId) as
    | { scope_json: string }
    | undefined;
  if (!row) return [];
  const parsed = JSON.parse(row.scope_json) as unknown;
  return Array.isArray(parsed) ? parsed.filter((id) => typeof id === "string") : [];
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
    if (sourceIds.length > 0 && !sourceIds.includes(row.source_id ?? "")) continue;
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

function ensureChat(db: Database.Database, chatId: string | undefined, title: string, now: number) {
  if (chatId) {
    const existing = db.prepare(`SELECT id FROM chats WHERE id = ?`).get(chatId) as
      | { id: string }
      | undefined;
    if (existing) return existing.id;
  }
  const id = uuidv7(now);
  db.prepare(
    `INSERT INTO chats (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`,
  ).run(id, title.slice(0, 80), now, now);
  return id;
}

function gather(
  db: Database.Database,
  chatId: string,
  text: string,
  sourceIds: string[],
  embed: AskInput["embed"],
) {
  const options = { sourceIds, embed };
  const found = retrieve(db, text, options);
  if (found.covered || !isFollowUp(text)) return found;
  const earlier = db
    .prepare(
      `SELECT body FROM messages WHERE chat_id = ? AND role = 'user' AND body != ?
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(chatId, text) as { body: string } | undefined;
  if (earlier) {
    const wider = retrieve(db, `${earlier.body} ${text}`, options);
    if (wider.covered) return wider;
  }
  const prior = priorPassages(db, chatId, sourceIds);
  if (prior.length > 0) return { hits: prior, covered: true, usedVectors: false };
  return found;
}

export async function askTurn(db: Database.Database, input: AskInput): Promise<AskResult> {
  if (input.signal?.aborted) throw new DOMException("aborted", "AbortError");
  const now = Date.now();
  const chatId = ensureChat(db, input.chatId, input.text, now);
  const sourceIds = input.sourceIds ?? chatScope(db, chatId);
  if (input.sourceIds) {
    db.prepare(`UPDATE chats SET scope_json = ? WHERE id = ?`).run(
      JSON.stringify(input.sourceIds),
      chatId,
    );
  }
  const pending = db
    .prepare(
      `SELECT role, body FROM messages WHERE chat_id = ? ORDER BY created_at DESC LIMIT 1`,
    )
    .get(chatId) as { role: string; body: string } | undefined;
  if (!(pending?.role === "user" && pending.body === input.text)) {
    db.prepare(
      `INSERT INTO messages (id, chat_id, role, body, created_at) VALUES (?, ?, 'user', ?, ?)`,
    ).run(uuidv7(now + 1), chatId, input.text, now);
  }
  db.prepare(`UPDATE chats SET updated_at = ? WHERE id = ?`).run(now, chatId);

  const found = input.allowGeneral
    ? { hits: [] as PassageHit[], covered: true, usedVectors: false }
    : gather(db, chatId, input.text, sourceIds, input.embed);
  if (!input.allowGeneral && !found.covered) {
    return { chatId, covered: false, message: null };
  }

  const citations: ChatCitation[] = found.hits.map((hit, index) => ({
    label: hit.sectionPath || hit.locator.paragraph || `P${index + 1}`,
    index: index + 1,
    passageId: hit.id,
    sourceId: hit.sourceId,
    sectionPath: hit.sectionPath,
    locator: hit.locator,
  }));
  const passageBlock = citations
    .map((cite, index) => `[P${cite.index}] ${cite.label}\n${found.hits[index]?.text ?? ""}`)
    .join("\n\n");
  const system = `${
    input.allowGeneral
      ? generalPrompt
      : input.mode === "socratic"
        ? socraticPrompt
        : solverPrompt
  }\n${profileContext(db)}`;
  const prompt = `${passageBlock}\n\nEarlier turns:\n${historyText(db, chatId)}\n\nQuestion:\n${input.text}`;
  let result;
  try {
    result = await generate({
      prompt,
      system,
      selection: selectionFor(db, "chat"),
      signal: input.signal,
      run: input.run,
    });
  } catch (err) {
    if (isAbort(err) || (err instanceof Error && err.name === "AbortError")) throw err;
    throw err;
  }
  if (result.text.trim().startsWith("NOT_COVERED")) {
    return { chatId, covered: false, message: null };
  }
  const parsed = splitFollowups(result.text);
  const stored = `${parsed.body}${
    parsed.followups.length > 0
      ? `\n<followups>\n${parsed.followups.join("\n")}\n</followups>`
      : ""
  }`;
  const messageId = uuidv7(now + 2);
  const grounding = input.allowGeneral ? "general" : "sources";
  db.prepare(
    `INSERT INTO messages
      (id, chat_id, role, body, engine_provider, model_id, model_source, prompt_template, prompt_version, grounding, created_at)
     VALUES (?, ?, 'assistant', ?, ?, ?, 'reported', ?, ?, ?, ?)`,
  ).run(
    messageId,
    chatId,
    stored,
    result.provider,
    result.model,
    input.allowGeneral ? "chat-general" : input.mode === "socratic" ? "chat-socratic" : "chat-solver",
    CHAT_PROMPT_VERSION,
    grounding,
    now + 1,
  );
  const link = db.prepare(
    `INSERT INTO message_passages (message_id, passage_id, label) VALUES (?, ?, ?)`,
  );
  const used = new Set(
    [...parsed.body.matchAll(/\[P(\d+)\]/g)].map((match) => Number(match[1])),
  );
  const linked = citations.filter((cite) => used.has(cite.index));
  if (!input.allowGeneral && linked.length === 0) {
    db.prepare(`DELETE FROM messages WHERE id = ?`).run(messageId);
    return { chatId, covered: false, message: null };
  }
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
      grounding,
      followups: parsed.followups,
      citations: linked,
      reaction: null,
    },
  };
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
  db.prepare(`UPDATE messages SET reaction = ? WHERE id = ?`).run(next, messageId);
  return next;
}

export function listChats(db: Database.Database) {
  return db
    .prepare(`SELECT id, title, updated_at FROM chats ORDER BY updated_at DESC`)
    .all() as Array<{ id: string; title: string | null; updated_at: number }>;
}

export function readChat(db: Database.Database, chatId: string): ChatMessageView[] {
  const rows = db
    .prepare(
      `SELECT id, role, body, model_id, grounding, reaction FROM messages
       WHERE chat_id = ? ORDER BY created_at`,
    )
    .all(chatId) as Array<{
    id: string;
    role: "user" | "assistant";
    body: string;
    model_id: string | null;
    grounding: "sources" | "general" | null;
    reaction: string | null;
  }>;
  const links = db.prepare(
    `SELECT mp.label, mp.passage_id, p.source_id, p.section_path, p.locator_json
     FROM message_passages mp
     JOIN passages p ON p.id = mp.passage_id
     WHERE mp.message_id = ?`,
  );
  return rows.map((row) => {
    const parsed = row.role === "assistant" ? splitFollowups(row.body) : { body: row.body, followups: [] };
    const citations = (links.all(row.id) as Array<{
      label: string;
      passage_id: string;
      source_id: string | null;
      section_path: string | null;
      locator_json: string | null;
    }>).map((link) => ({
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
      grounding: row.grounding,
      followups: parsed.followups,
      citations,
      reaction: row.reaction === "up" || row.reaction === "down" ? row.reaction : null,
    };
  });
}
