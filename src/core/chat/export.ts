import type Database from "better-sqlite3";
import {
  mapOutsideCode,
  normalizeMathDelimiters,
} from "../../shared/math-delimiters";
import { chatContext, heldSources, readChat } from "./turn";
import { visibleText } from "./visible";

export type ChatExportLanguage = "en" | "it";

const labels = {
  en: {
    student: "Student",
    pyxis: "Pyxis",
    untitled: "Untitled",
    context: "Context",
    documents: "Documents in this chat",
    attached: "Attached",
    photo: "photo",
    sources: "Sources",
    stopped: "This reply was stopped.",
  },
  it: {
    student: "Studente",
    pyxis: "Pyxis",
    untitled: "Senza titolo",
    context: "Contesto",
    documents: "Documenti in questa chat",
    attached: "Allegato",
    photo: "foto",
    sources: "Fonti",
    stopped: "Questa risposta è stata interrotta.",
  },
} as const;

export type ChatExport = {
  title: string | null;
  /** The passage or answer a chat was started from, which the tutor read with every question. */
  context?: { title: string; body: string } | null;
  /** Titles of the documents the chat holds. */
  documents: string[];
  messages: Array<{
    role: "user" | "assistant";
    text: string;
    stopped: boolean;
    photos: number;
    /** One entry per cited source and section, in citation order. */
    sources: Array<{ title: string; section: string | null }>;
  }>;
};

/** A heading inside a message must not outrank the message labels, so it moves down to level 3 or lower. */
function demoteHeadings(markdown: string): string {
  return mapOutsideCode(markdown, (text) =>
    text.replace(/^(#{1,6})(?=[ \t])/gm, (hashes) =>
      "#".repeat(Math.min(6, hashes.length + 2)),
    ),
  );
}

export function chatMarkdown(
  chat: ChatExport,
  language: ChatExportLanguage = "en",
): string {
  const words = labels[language];
  const blocks = [`# ${chat.title?.trim() || words.untitled}`];
  if (chat.context) {
    blocks.push(`**${words.context}:** ${chat.context.title.trim()}`);
    const body = demoteHeadings(
      normalizeMathDelimiters(chat.context.body),
    ).trim();
    if (body) blocks.push(body.replace(/^/gm, "> ").replace(/^> $/gm, ">"));
  }
  if (chat.documents.length > 0)
    blocks.push(`${words.documents}: ${chat.documents.join(", ")}`);
  for (const message of chat.messages) {
    blocks.push(`## ${message.role === "user" ? words.student : words.pyxis}`);
    const text = demoteHeadings(normalizeMathDelimiters(message.text)).trim();
    if (text) blocks.push(text);
    if (message.photos > 0)
      blocks.push(
        `${words.attached}: ${Array.from({ length: message.photos }, (_, i) => `${words.photo} ${i + 1}`).join(", ")}`,
      );
    if (message.stopped) blocks.push(`*${words.stopped}*`);
    if (message.sources.length > 0)
      blocks.push(
        `**${words.sources}**`,
        message.sources
          .map(
            (source) =>
              `- ${source.section ? `${source.title}, ${source.section}` : source.title}`,
          )
          .join("\n"),
      );
  }
  return `${blocks.join("\n\n")}\n`;
}

/** The photos a message carries. A HEIC original or a full-size copy sits beside the fitted photo and is not another one. */
function photoCounts(
  db: Database.Database,
  chatId: string,
): Map<string, number> {
  const rows = db
    .prepare(
      `SELECT a.message_id AS id, a.mime AS mime FROM attachments a
       JOIN messages m ON m.id = a.message_id WHERE m.chat_id = ?`,
    )
    .all(chatId) as Array<{ id: string; mime: string }>;
  const counts = new Map<string, number>();
  for (const { id, mime } of rows) {
    if (mime.endsWith(";original") || /^image\/hei[cf]$/.test(mime)) continue;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

export function exportChat(
  db: Database.Database,
  chatId: string,
  language: ChatExportLanguage,
): { filename: string; markdown: string } {
  const chat = db
    .prepare(`SELECT title FROM chats WHERE id = ?`)
    .get(chatId) as { title: string | null } | undefined;
  if (!chat) throw new Error("chat-missing");
  const photos = photoCounts(db, chatId);
  const titleOf = db.prepare(`SELECT title FROM sources WHERE id = ?`);
  const data: ChatExport = {
    title: chat.title,
    context: chatContext(db, chatId),
    documents: heldSources(db, chatId).map((source) => source.title),
    messages: readChat(db, chatId).map((message) => {
      const seen = new Set<string>();
      const sources = [...message.citations]
        .sort((a, b) => a.index - b.index)
        .flatMap((cite) => {
          const title = (
            titleOf.get(cite.sourceId) as { title: string } | undefined
          )?.title;
          if (!title) return [];
          const key = `${cite.sourceId}\n${cite.sectionPath ?? ""}`;
          if (seen.has(key)) return [];
          seen.add(key);
          return [{ title, section: cite.sectionPath }];
        });
      return {
        role: message.role,
        text: visibleText(message.role, message.body),
        stopped: message.stopped,
        photos: photos.get(message.id) ?? 0,
        sources,
      };
    }),
  };
  const name =
    (chat.title ?? "")
      .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 100) || labels[language].untitled;
  return { filename: `${name}.md`, markdown: chatMarkdown(data, language) };
}
