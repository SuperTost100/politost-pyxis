import type Database from "better-sqlite3";
import { visibleText } from "./visible";

export type ChatSnippet = { text: string; start: number; end: number };
export type ChatSearchHit = {
  id: string;
  title: string | null;
  updatedAt: number;
  /** The matching text when the match is in a message and not in the title. `start`..`end` marks the first term found. */
  snippet: ChatSnippet | null;
};

export type ChatSearchResult = { hits: ChatSearchHit[]; capped: boolean };

export const MAX_HITS = 50;
const CONTEXT = 48;
/** Characters of folded message text kept per database. Past this the cache starts over, so it cannot grow without bound. */
const CACHE_CHARS = 8_000_000;

/** Lower case with accents removed, plus where each folded character came from in the original. */
function fold(text: string): { folded: string; origin: number[] } {
  let folded = "";
  const origin: number[] = [];
  let at = 0;
  for (const char of text) {
    // Plain ASCII is most of what is searched, and it needs no normalising.
    if (char.charCodeAt(0) < 0x80) {
      folded += char.toLowerCase();
      origin.push(at);
      at += 1;
      continue;
    }
    const plain = char
      .normalize("NFD")
      .toLowerCase()
      .normalize("NFD")
      .replace(/\p{M}/gu, "");
    for (let i = 0; i < plain.length; i += 1) origin.push(at);
    folded += plain;
    at += char.length;
  }
  return { folded, origin };
}

export function foldText(text: string): string {
  return fold(text).folded;
}

/** The first place every term occurs in the text, or null. Terms may sit in any order. */
function find(
  text: string,
  terms: string[],
): { start: number; end: number } | null {
  const { folded, origin } = fold(text);
  let first: { start: number; end: number } | null = null;
  for (const term of terms) {
    const index = folded.indexOf(term);
    if (index === -1) return null;
    const start = origin[index]!;
    const last = origin[index + term.length - 1]!;
    const end = last + (text.codePointAt(last)! > 0xffff ? 2 : 1);
    if (!first || start < first.start) first = { start, end };
  }
  return first;
}

function snippetOf(
  text: string,
  at: { start: number; end: number },
): ChatSnippet {
  const from = Math.max(0, at.start - CONTEXT);
  const to = Math.min(text.length, at.end + CONTEXT);
  const collapse = (part: string) => part.replace(/\s+/g, " ");
  const before = `${from > 0 ? "…" : ""}${collapse(text.slice(from, at.start)).trimStart()}`;
  const match = collapse(text.slice(at.start, at.end));
  const after = `${collapse(text.slice(at.end, to)).trimEnd()}${to < text.length ? "…" : ""}`;
  return {
    text: `${before}${match}${after}`,
    start: before.length,
    end: before.length + match.length,
  };
}

/** The folded text of each message already searched, so a keystroke does not read and fold every chat again. Messages never change once stored. */
const foldedCache = new WeakMap<Database.Database, { chars: number; text: Map<string, { length: number; folded: string }> }>();

function foldedMessage(
  db: Database.Database,
  id: string,
  role: string,
  body: string,
): string {
  let cache = foldedCache.get(db);
  if (!cache || cache.chars > CACHE_CHARS) {
    cache = { chars: 0, text: new Map() };
    foldedCache.set(db, cache);
  }
  const known = cache.text.get(id);
  if (known && known.length === body.length) return known.folded;
  const text = foldText(visibleText(role, body));
  cache.text.set(id, { length: body.length, folded: text });
  cache.chars += text.length;
  return text;
}

/**
 * Chats whose title or message text contains every word of the query, ignoring case and accents ("perche" finds
 * "perché"). Newest chats first, at most MAX_HITS; `capped` says there were more. With a subject, only its chats are
 * searched, so the cap does not hide them behind newer chats of other subjects. Only the text a student sees is
 * searched, not the stored followups, checks or citation markers. A title match shows no snippet; otherwise the
 * snippet comes from the first message that matches. Each message is folded once and kept, so only the first search
 * after start pays for reading every chat; a later keystroke only looks for the words in text already folded.
 */
export function searchChats(
  db: Database.Database,
  query: string,
  subject?: string,
): ChatSearchResult {
  const terms = foldText(query).split(/\s+/).filter(Boolean);
  if (terms.length === 0) return { hits: [], capped: false };
  const chats = db
    .prepare(
      `SELECT id, title, updated_at FROM chats WHERE ? IS NULL OR subject = ? ORDER BY updated_at DESC`,
    )
    .all(subject ?? null, subject ?? null) as Array<{ id: string; title: string | null; updated_at: number }>;
  const messages = db.prepare(
    `SELECT id, role, body FROM messages WHERE chat_id = ? AND role IN ('user', 'assistant') ORDER BY created_at`,
  );
  const hits: ChatSearchHit[] = [];
  for (const chat of chats) {
    // One more than the cap tells the student the list was cut.
    if (hits.length > MAX_HITS) break;
    const hit = { id: chat.id, title: chat.title, updatedAt: chat.updated_at };
    if (chat.title && find(chat.title, terms)) {
      hits.push({ ...hit, snippet: null });
      continue;
    }
    for (const row of messages.iterate(chat.id) as Iterable<{
      id: string;
      role: string;
      body: string;
    }>) {
      const text = foldedMessage(db, row.id, row.role, row.body);
      if (!terms.every((term) => text.includes(term))) continue;
      const shown = visibleText(row.role, row.body);
      const at = find(shown, terms);
      if (!at) continue;
      hits.push({ ...hit, snippet: snippetOf(shown, at) });
      break;
    }
  }
  return { hits: hits.slice(0, MAX_HITS), capped: hits.length > MAX_HITS };
}
