import { splitChecks, solverChecks } from "./checks";
import type { AnchoredCheck } from "../../shared/math-check";
import type Database from "better-sqlite3";
import { uuidv7 } from "../../shared/ids";
import { isAbort, IpcError } from "../../shared/ipc";
import { generate } from "../engine/generate";
import { capabilityWarning } from "../engine/capabilities";
import { selectionFor } from "../engine/selection";
import type { Embedder, PassageHit } from "../sources/retrieve";
import { contentWords, retrieveWithModel } from "../sources/retrieve";
import { prepareFiles, savedImages, type PreparedFiles } from "./attach";
import { contentLanguage } from "../engine/prompts";
import {
  type ChatTemplateId,
  chatProvenance,
  chatSystemPrompt,
  chatTemplateId,
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
  subject?: string;
  files?: string[];
  workspace?: string;
  recognize?: (bytes: Uint8Array, cachePath: string) => Promise<string>;
  embed?: Embedder | null;
  signal?: AbortSignal;
  onDelta?: (text: string) => void;
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
  return `Student: ${row.display_name ?? ""}. Level: ${row.education_level ?? ""}. Course: ${row.course ?? ""}.`;
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

function historyText(
  db: Database.Database,
  chatId: string,
  excludeId = "",
): string {
  const rows = db
    .prepare(
      `SELECT role, body FROM messages WHERE chat_id = ? AND id != ? ORDER BY created_at DESC LIMIT 8`,
    )
    .all(chatId, excludeId) as Array<{ role: string; body: string }>;
  return rows
    .reverse()
    .map((row) => `${row.role}: ${splitChecks(row.body).body}`)
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
  const row = db
    .prepare(`SELECT scope_json FROM chats WHERE id = ?`)
    .get(chatId) as { scope_json: string } | undefined;
  if (!row) return [];
  const parsed = JSON.parse(row.scope_json) as unknown;
  return Array.isArray(parsed)
    ? parsed.filter((id) => typeof id === "string")
    : [];
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

function ensureChat(
  db: Database.Database,
  chatId: string | undefined,
  title: string,
  now: number,
) {
  if (chatId) {
    const existing = db
      .prepare(`SELECT id FROM chats WHERE id = ?`)
      .get(chatId) as { id: string } | undefined;
    if (existing) return existing.id;
  }
  const id = uuidv7(now);
  db.prepare(
    `INSERT INTO chats (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`,
  ).run(id, title.slice(0, 80), now, now);
  return id;
}

async function gather(
  db: Database.Database,
  chatId: string,
  text: string,
  sourceIds: string[],
  embed: AskInput["embed"],
) {
  const options = { sourceIds, embed };
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

export function seedChat(
  db: Database.Database,
  input: ChatContext & { sourceIds?: string[]; subject?: string },
): { chatId: string } {
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
    JSON.stringify(input.sourceIds ?? []),
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
  if (input.signal?.aborted) throw new DOMException("aborted", "AbortError");
  const now = Date.now();
  const chatId = ensureChat(db, input.chatId, input.text, now);
  let sourceIds = input.sourceIds ?? chatScope(db, chatId);
  let notes: string[] = [];
  let images: PreparedFiles["images"] = [];
  if (input.files && input.files.length > 0 && input.workspace) {
    try {
      const prepared = await prepareFiles(
        db,
        input.workspace,
        input.files,
        selectionFor(db, "chat").model,
        input.recognize,
        input.signal,
      );
      sourceIds = [...new Set([...sourceIds, ...prepared.sourceIds])];
      notes = prepared.notes;
      images = prepared.images;
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
  const storedSubject = (
    db.prepare(`SELECT subject FROM chats WHERE id = ?`).get(chatId) as
      { subject: string | null } | undefined
  )?.subject;
  const subject =
    input.subject === undefined ? (storedSubject ?? "") : input.subject.trim();
  if (input.sourceIds || sourceIds.length > 0) {
    db.prepare(`UPDATE chats SET scope_json = ?, subject = ? WHERE id = ?`).run(
      JSON.stringify(sourceIds),
      subject || null,
      chatId,
    );
  } else if (input.subject !== undefined) {
    db.prepare(`UPDATE chats SET subject = ? WHERE id = ?`).run(
      subject || null,
      chatId,
    );
  }
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
  const attach = db.prepare(
    `INSERT INTO attachments (id, message_id, blob_sha, mime, created_at) VALUES (?, ?, ?, ?, ?)`,
  );
  for (const image of images) {
    attach.run(uuidv7(now + 3), userMessageId, image.sha, image.mediaType, now);
    if (image.original)
      attach.run(uuidv7(now + 4), userMessageId, image.original.sha, image.original.mime, now);
  }
  db.prepare(`UPDATE chats SET updated_at = ? WHERE id = ?`).run(now, chatId);

  const seesImage =
    Boolean(input.workspace) &&
    capabilityWarning(selectionFor(db, "chat").model, "vision") == null &&
    images.some((image) => image.data);
  const thisTurnFile = notes.length > 0 || seesImage;
  const found =
    input.allowGeneral || (thisTurnFile && sourceIds.length === 0)
      ? { hits: [] as PassageHit[], covered: true, usedVectors: false }
      : await gather(db, chatId, input.text, sourceIds, input.embed);
  if (!input.allowGeneral && !found.covered && !thisTurnFile) {
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
    .map(
      (cite, index) =>
        `[P${cite.index}] ${cite.label}\n${found.hits[index]?.text ?? ""}`,
    )
    .join("\n\n");
  const subjectLine = subject ? `Subject: ${subject}.` : "";
  const pinned = chatContext(db, chatId);
  const pinnedBlock = pinned
    ? `Pinned context: ${pinned.title}\n${pinned.body}\n\n`
    : "";
  const attachedBlock =
    notes.length > 0 ? `Attached text:\n${notes.join("\n")}\n\n` : "";
  const template = chatTemplateId(input);
  const system = `${chatSystemPrompt(template, contentLanguage(db))}\n${profileContext(db)}\n${subjectLine}`;
  const prompt = `${pinnedBlock}${attachedBlock}${passageBlock}\n\nEarlier turns:\n${historyText(db, chatId, replacing?.assistantId)}\n\nQuestion:\n${input.text}`;
  const selection = selectionFor(db, "chat");
  let streamed = "";
  let result;
  try {
    result = await generate({
      prompt,
      system,
      selection,
      attachments:
        input.workspace &&
        capabilityWarning(selectionFor(db, "chat").model, "vision") == null
          ? savedImages(db, input.workspace, chatId)
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
        streamed = text;
        input.onDelta?.(text.replace(/<followups>[\s\S]*$/, "").trim());
      },
    });
  } catch (err) {
    if (
      (isAbort(err) || (err instanceof Error && err.name === "AbortError")) &&
      streamed.trim()
    ) {
      return finishReply(db, chatId, streamed, {
        provider: selection.provider,
        model: selection.model,
        grounding: input.allowGeneral ? "general" : "sources",
        template,
        citations,
        allowGeneral: input.allowGeneral === true,
        stopped: true,
        now,
      });
    }
    throw err;
  }
  if (result.text.trim().startsWith("NOT_COVERED")) {
    return { chatId, covered: false, message: null };
  }
  const parsed = splitFollowups(result.text);
  const checks =
    input.mode !== "socratic"
      ? await solverChecks(parsed.body, {
          selection,
          signal: input.signal,
          run: input.run,
        })
      : [];

  const stored = `${parsed.body}${
    parsed.followups.length > 0
      ? `\n<followups>\n${parsed.followups.join("\n")}\n</followups>`
      : ""
  }${checks.length ? `\n<checks>${JSON.stringify(checks)}</checks>` : ""}`;
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
    template,
    chatProvenance(template).version,
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
  if (
    !input.allowGeneral &&
    linked.length === 0 &&
    !thisTurnFile &&
    !(input.mode === "socratic" && parsed.body.trim().endsWith("?"))
  ) {
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
      provider: result.provider,
      grounding,
      followups: parsed.followups,
      citations: linked,
      reaction: null,
      stopped: false,
      checks,
    },
  };
}

function finishReply(
  db: Database.Database,
  chatId: string,
  text: string,
  meta: {
    provider: string;
    model: string;
    grounding: "sources" | "general";
    template: string;
    citations: ChatCitation[];
    allowGeneral: boolean;
    stopped: boolean;
    now: number;
  },
): AskResult {
  const parsed = splitFollowups(text);
  const messageId = uuidv7(meta.now + 2);
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
    meta.grounding,
    meta.stopped ? 1 : 0,
    meta.now + 1,
  );
  const used = new Set(
    [...parsed.body.matchAll(/\[P(\d+)\]/g)].map((match) => Number(match[1])),
  );
  const linked = meta.citations.filter((cite) => used.has(cite.index));
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
      grounding: meta.grounding,
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
  now = Date.now(),
) {
  const trimmed = title.trim();
  if (!trimmed) throw new Error("chat-title");
  const info = db
    .prepare(`UPDATE chats SET title = ?, updated_at = ? WHERE id = ?`)
    .run(trimmed, now, chatId);
  if (info.changes === 0) throw new Error("chat-missing");
}

export function deleteChat(db: Database.Database, chatId: string) {
  const info = db.prepare(`DELETE FROM chats WHERE id = ?`).run(chatId);
  if (info.changes === 0) throw new Error("chat-missing");
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
      `SELECT id, role, body, model_id, engine_provider, grounding, reaction, stopped FROM messages
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
  }>;
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
      followups: parsed.followups,
      citations,
      reaction:
        row.reaction === "up" || row.reaction === "down" ? row.reaction : null,
      stopped: row.stopped === 1,
      checks: metadata.checks,
    };
  });
}
