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

const MAX_HITS = 50;
const CONTEXT = 48;

/** Lower case with accents removed, plus where each folded character came from in the original. */
function fold(text: string): { folded: string; origin: number[] } {
  let folded = "";
  const origin: number[] = [];
  let at = 0;
  for (const char of text) {
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

/**
 * Chats whose title or message text contains every word of the query, ignoring case and accents ("perche" finds
 * "perché"). Newest chats first. Only the text a student sees is searched, not the stored followups, checks or
 * citation markers. A title match shows no snippet; otherwise the snippet comes from the first message that matches.
 */
export function searchChats(
  db: Database.Database,
  query: string,
): ChatSearchHit[] {
  const terms = foldText(query).split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];
  const chats = db
    .prepare(`SELECT id, title, updated_at FROM chats ORDER BY updated_at DESC`)
    .all() as Array<{ id: string; title: string | null; updated_at: number }>;
  const messages = db.prepare(
    `SELECT role, body FROM messages WHERE chat_id = ? AND role IN ('user', 'assistant') ORDER BY created_at`,
  );
  const hits: ChatSearchHit[] = [];
  for (const chat of chats) {
    const hit = { id: chat.id, title: chat.title, updatedAt: chat.updated_at };
    if (chat.title && find(chat.title, terms)) {
      hits.push({ ...hit, snippet: null });
    } else {
      for (const row of messages.all(chat.id) as Array<{
        role: string;
        body: string;
      }>) {
        const text = visibleText(row.role, row.body);
        const at = find(text, terms);
        if (!at) continue;
        hits.push({ ...hit, snippet: snippetOf(text, at) });
        break;
      }
    }
    if (hits.length >= MAX_HITS) break;
  }
  return hits;
}
