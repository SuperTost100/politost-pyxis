import type Database from "better-sqlite3";
import {
  mapOutsideCode,
  normalizeMathDelimiters,
} from "../../shared/math-delimiters";
import { chatContext, chatTitle, heldSources, readChat } from "./turn";
import { visibleText } from "./visible";
import { safeFileName } from "../../shared/file-name";
import { mapToolBlocks } from "../../shared/tool-blocks";
import type { ProposalView, ToolResultView } from "../../shared/ipc";

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

/** What a chat tool made, in the export's language, where the reply showed its card. */
function toolLine(view: Exclude<ToolResultView, { tool: "ask_stronger_model" }>, language: ChatExportLanguage): string {
  const it = language === "it";
  if (view.tool === "propose_path_change" || view.tool === "propose_exam" || view.tool === "propose_delete")
    return proposalLine(view, it);
  if (view.tool === "create_map") {
    const map = it
      ? `la mappa «${view.topic}» in Mappe, sotto ${view.subject}`
      : `the concept map "${view.topic}" in Maps, under ${view.subject}`;
    if (view.undone) return it ? `Pyxis ha creato ${map}, poi annullata: non è più in Mappe.` : `Pyxis created ${map}, then undone: it is no longer in Maps.`;
    if (view.gone) return it ? `Pyxis ha creato ${map}, poi eliminata.` : `Pyxis created ${map}, later deleted.`;
    if (view.job === "done") return it ? `Pyxis ha creato ${map}.` : `Pyxis created ${map}.`;
    if (view.job === "working") return it ? `Pyxis sta creando ${map}.` : `Pyxis is building ${map}.`;
    return it ? `Pyxis non è riuscito a creare ${map}.` : `Pyxis could not build ${map}.`;
  }
  if (view.tool === "create_quiz") {
    const quiz = it
      ? `un quiz di ${view.count} domand${view.count === 1 ? "a" : "e"} su ${view.topic} nell'esame ${view.exam}`
      : `a ${view.count}-question quiz on ${view.topic} in the exam ${view.exam}`;
    if (view.undone) return it ? `Pyxis ha creato ${quiz}, poi annullato: non è più nell'esame.` : `Pyxis created ${quiz}, then undone: it is no longer in the exam.`;
    if (view.gone) return it ? `Pyxis ha creato ${quiz}, poi eliminato.` : `Pyxis created ${quiz}, later deleted.`;
    if (view.job === "done") return it ? `Pyxis ha creato ${quiz}.` : `Pyxis created ${quiz}.`;
    if (view.job === "working") return it ? `Pyxis sta scrivendo ${quiz}.` : `Pyxis is writing ${quiz}.`;
    return it ? `Pyxis non è riuscito a scrivere ${quiz}.` : `Pyxis could not write ${quiz}.`;
  }
  const one = view.count === 1;
  const what = view.title ? ` ${view.title}` : "";
  if (it) {
    const made = `Pyxis ha creato ${view.count} flashcard${what} nel mazzo di ${view.deck}`;
    return view.undone === null
      ? `${made}.`
      : `${made}, poi ${one ? "annullata: non è più nel mazzo" : "annullate: non sono più nel mazzo"}.`;
  }
  const made = `Pyxis created ${view.count} flashcard${one ? "" : "s"}${what} in the ${view.deck} deck`;
  return view.undone === null
    ? `${made}.`
    : `${made}, then undone: ${one ? "it is" : "they are"} no longer in the deck.`;
}

/** A proposal of an "ask first" tool: what it proposed, and what the student chose. */
function proposalLine(view: ProposalView, it: boolean): string {
  const day = (at: number) =>
    new Intl.DateTimeFormat(it ? "it-IT" : "en-GB", { day: "numeric", month: "long", year: "numeric" }).format(at);
  let what: string;
  let done: string;
  if (view.tool === "propose_path_change") {
    what = it ? `di cambiare il percorso di ${view.exam}` : `a change to the path of ${view.exam}`;
    const parts = [
      view.date ? (it ? `esame il ${day(view.date.to)}` : `exam on ${day(view.date.to)}`) : "",
      view.hours ? (it ? `${view.hours.to} ore a settimana` : `${view.hours.to} hours a week`) : "",
      view.changed ? (it ? `${view.changed} argoment${view.changed === 1 ? "o cambiato" : "i cambiati"}` : `${view.changed} topic${view.changed === 1 ? "" : "s"} changed`) : "",
    ].filter(Boolean);
    done = it ? `hai applicato la modifica (${parts.join(", ")})` : `you applied it (${parts.join(", ")})`;
  } else if (view.tool === "propose_exam") {
    what = it ? `un nuovo esame, «${view.title}»` : `a new exam, "${view.title}"`;
    done = it ? "l'hai creato" : "you created it";
  } else {
    const thing =
      view.kind === "flashcards"
        ? it
          ? `${view.count} flashcard${view.name ? ` di ${view.name}` : " create in questa chat"}`
          : `${view.count} flashcard${view.count === 1 ? "" : "s"}${view.name ? ` of ${view.name}` : " made in this chat"}`
        : view.kind === "map"
          ? it
            ? `la mappa «${view.name}»`
            : `the concept map "${view.name}"`
          : it
            ? `il quiz${view.name ? ` su ${view.name}` : ""} non consegnato`
            : `the unfinished quiz${view.name ? ` on ${view.name}` : ""}`;
    what = it ? `di eliminare ${thing}` : `deleting ${thing}`;
    done = it ? "hai confermato" : "you confirmed";
  }
  const after: Record<ProposalView["state"], string> = it
    ? {
        pending: "non hai ancora deciso",
        applied: done,
        restored: `${done}, poi hai annullato`,
        declined: "hai scelto di no",
        stale: "i dati sono cambiati prima che decidessi, quindi non è cambiato niente",
        expired: "la proposta è stata sostituita da una successiva",
      }
    : {
        pending: "you have not decided yet",
        applied: done,
        restored: `${done}, then undid it`,
        declined: "you chose not to",
        stale: "the data changed before you decided, so nothing changed",
        expired: "a later proposal replaced it",
      };
  return it ? `Pyxis ha proposto ${what}: ${after[view.state]}.` : `Pyxis proposed ${what}: ${after[view.state]}.`;
}

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

/**
 * A fence left open, by a reply cut short or a stray ``` in a message, would turn every later block of the export into
 * code. The closing line is added at the end of the text, with the fence's own character and length.
 */
function closeFences(markdown: string): string {
  let open: { char: string; width: number } | null = null;
  for (const line of markdown.split("\n")) {
    const run = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (!run) continue;
    const char = run[1]![0]!;
    if (!open) {
      // A backtick fence's info string cannot hold a backtick: "```x```" is inline code.
      if (char !== "`" || !run[2]!.includes("`")) open = { char, width: run[1]!.length };
    } else if (char === open.char && run[1]!.length >= open.width && run[2]!.trim() === "") {
      open = null;
    }
  }
  return open ? `${markdown}\n${open.char.repeat(open.width)}` : markdown;
}

export function chatMarkdown(
  chat: ChatExport,
  language: ChatExportLanguage = "en",
): string {
  const words = labels[language];
  const blocks = [`# ${chat.title?.trim() || words.untitled}`];
  if (chat.context) {
    blocks.push(`**${words.context}:** ${chat.context.title.trim()}`);
    const body = closeFences(
      demoteHeadings(normalizeMathDelimiters(chat.context.body)).trim(),
    );
    if (body) blocks.push(body.replace(/^/gm, "> ").replace(/^> $/gm, ">"));
  }
  if (chat.documents.length > 0)
    blocks.push(`${words.documents}: ${chat.documents.join(", ")}`);
  for (const message of chat.messages) {
    blocks.push(`## ${message.role === "user" ? words.student : words.pyxis}`);
    const text = closeFences(
      demoteHeadings(normalizeMathDelimiters(message.text)).trim(),
    );
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
       JOIN messages m ON m.id = a.message_id WHERE m.chat_id = ? AND a.kind IS NOT 'document'`,
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
  /** `drawn` keeps each valid chart as its block, for the PDF, whose page draws it; a Markdown file gets its table. */
  charts: "table" | "drawn" = "table",
): { filename: string; markdown: string } {
  const title = chatTitle(db, chatId);
  if (title === undefined) throw new Error("chat-missing");
  const photos = photoCounts(db, chatId);
  const titleOf = db.prepare(`SELECT title FROM sources WHERE id = ?`);
  const data: ChatExport = {
    title,
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
        // In a reply, a tool's card becomes one line on what it made. A student's own message stays as typed.
        text: visibleText(
          message.role,
          message.role === "assistant"
            ? mapToolBlocks(message.body, (id) => {
                const view = message.tools?.[id];
                // A sub-call to the stronger model made nothing: the reply holds what came of it.
                return view && view.tool !== "ask_stronger_model" ? `*${toolLine(view, language)}*` : "";
              })
            : message.body,
          language,
          message.answers,
          charts === "drawn",
        ),
        stopped: message.stopped,
        photos: photos.get(message.id) ?? 0,
        sources,
      };
    }),
  };
  const name = safeFileName(title ?? "", labels[language].untitled);
  return { filename: `${name}.md`, markdown: chatMarkdown(data, language) };
}
