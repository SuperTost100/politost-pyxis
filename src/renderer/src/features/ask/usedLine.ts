/**
 * The line above an answer that says what it used, as a translation key and its values. The keys live under
 * `ask.used` in the locale files; `wider` picks the variant that says the chat's subject had nothing on the question.
 */
export type UsedLine = { key: string; values: Record<string, string | number> } | null;

/**
 * What a reply from general knowledge says. Nothing relevant found: where Pyxis looked, the whole Library or the files
 * the chat is limited to. Passages found but not cited: that the answer cites no source. Without the note, which a stopped
 * or older reply lacks, only that it cites none.
 */
function generalKey(searched: { found: boolean; where: "library" | "files" } | undefined): string {
  if (!searched) return "generalNoSource";
  if (searched.found) return "generalUnused";
  return searched.where === "files" ? "generalFiles" : "general";
}

type Cited = { sourceId: string; subject?: string | null; attached?: boolean };

export function usedLine(reply: {
  grounding: "sources" | "wider" | "general" | null;
  citations: readonly Cited[];
  /** For a reply from general knowledge: whether the search found passages the answer did not cite, and where it looked. */
  searched?: { found: boolean; where: "library" | "files" };
}): UsedLine {
  if (reply.grounding === "general") return { key: `ask.used.${generalKey(reply.searched)}`, values: {} };
  if (reply.grounding === null || reply.citations.length === 0) return null;
  // The line counts files: two files cited three times are two sources. The list under it keeps every passage.
  const passages = reply.citations.length;
  const count = new Set(reply.citations.map((cite) => cite.sourceId)).size;
  const context: Record<string, string> = reply.grounding === "wider" ? { context: "wider" } : {};
  const fromLibrary = reply.citations.filter((cite) => !cite.attached);
  if (fromLibrary.length === 0) return { key: "ask.used.attached", values: { count } };
  const subjects = [...new Set(fromLibrary.map((cite) => cite.subject ?? ""))];
  const named = subjects.filter(Boolean);
  // Every cited file belongs to one or two subjects: the line names them. Anything else is "your Library".
  if (fromLibrary.length === passages && named.length === subjects.length) {
    if (named.length === 1) return { key: "ask.used.subject", values: { count, subject: named[0]!, ...context } };
    if (named.length === 2)
      return { key: "ask.used.two", values: { count, first: named[0]!, second: named[1]!, ...context } };
  }
  return { key: "ask.used.library", values: { count, ...context } };
}

/** Characters of plain prose up to which a reply with no math, list or block is taken as a short reply, not an explanation. */
const SHORT_REPLY = 600;

/**
 * Whether a reply explains something, which is what the general-knowledge note speaks about. A reply whose substance is
 * a tool's result (a ```pyxis-tool block: cards, a map, a quiz, a proposal) or the student's own results is not one,
 * and neither is a short plain reply with no math, list, heading, table or block: a refusal, or a question back.
 * shortcut: the length and the marks stand in for "explains", so a short answer without math from general knowledge
 * loses the note too; a mark the model writes for such replies would be exact, if that ever matters.
 */
function explains(reply: { body?: string; results?: boolean }): boolean {
  if (reply.body === undefined) return true;
  if (reply.results || /^```pyxis-tool\s*$/m.test(reply.body)) return false;
  const text = reply.body.trim();
  if (/\$|\\\(|\\\[|^```|^\s*(?:[-*+]|\d+[.)])\s|^#{1,6}\s|^\s*\|/m.test(text)) return true;
  return text.length > SHORT_REPLY;
}

/**
 * The line kept above an answer, now that the row under it names the sources: one that says the answer comes from
 * general knowledge, or that the chat's subject had nothing on the question, both warnings to read before the answer.
 * The general-knowledge note is left off a reply that explains nothing (`explains`).
 */
export function noteLine(reply: Parameters<typeof usedLine>[0] & { body?: string; results?: boolean }): UsedLine {
  const line = usedLine(reply);
  if (!line) return null;
  if (reply.grounding === "general") return explains(reply) ? line : null;
  return line.values.context === "wider" ? line : null;
}
