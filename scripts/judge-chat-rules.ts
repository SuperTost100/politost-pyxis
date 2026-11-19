// The rules of tests/fixtures/chat-conversations.json, applied to a reply. Pure, so a unit test can run them.

export type Conversation = {
  id: string;
  language: "it" | "en";
  history: Array<{ role: "user" | "assistant"; text: string }>;
  message: string;
  rule: string;
  /** Patterns tested on what the student sees: the reply without its fenced blocks (a `check` block never shows). */
  must?: string[];
  mustNot?: string[];
  /** Patterns tested on the raw reply, for what forbids a fence. */
  rawMustNot?: string[];
  /** Patterns tested on what the student sees, in the two formula forms below. */
  mustFormula?: string[];
  mustNotFormula?: string[];
  minWords?: number;
  maxWords?: number;
  endsWithQuestion?: boolean;
  followups?: "solution" | "similar";
  material?: boolean;
};

/**
 * A reply with its typesetting taken away, in two forms, so a formula matches however it is written. In the first every
 * space is gone and a maths delimiter becomes a `¦`, so `$x = 4$ quindi` reads `x=4¦quindi` and a word boundary after the
 * 4 survives. In the second the delimiters are gone and only the spaces around an operator are, so plain `x = 4 poi` reads
 * `x=4 poi`. A pattern that must be found is found in either form, and one that must be absent is absent from both.
 * The functions below read what the student sees, so working that sits in a hidden `check` block does not count.
 */
export function formulaForms(text: string): string[] {
  return [
    text.replace(/[\\{}*`]/g, "").replace(/\$+/g, "¦").replace(/\s+/g, ""),
    text
      .replace(/[\\{}*`$]/g, "")
      .replace(/\s*([=+\-^()/])\s*/g, "$1")
      .replace(/\s+/g, " "),
  ];
}

/** What the rules say about a reply: the failures, in words. `followups: false` leaves the follow-up rules out, for a reply saved without them. */
export function judge(conv: Conversation, reply: string, options: { followups?: boolean } = {}) {
  const body = reply.replace(/<followups>[\s\S]*$/i, "").trim();
  const followups = (/<followups>([\s\S]*?)(?:<\/followups>|$)/i.exec(reply)?.[1] ?? "")
    .split("\n")
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "").trim())
    .filter(Boolean);
  // What the student sees: a `check` block carries claims for Pyxis, and a figure block is drawn, so neither is text.
  const seen = body.replace(/```[\s\S]*?(?:```|$)/g, "").trim();
  const forms = formulaForms(seen);
  const fails: string[] = [];
  for (const pattern of conv.rawMustNot ?? []) if (new RegExp(pattern).test(body)) fails.push(`has ${pattern}`);
  for (const pattern of conv.must ?? []) if (!new RegExp(pattern).test(seen)) fails.push(`missing ${pattern}`);
  for (const pattern of conv.mustNot ?? []) if (new RegExp(pattern).test(seen)) fails.push(`has ${pattern}`);
  for (const pattern of conv.mustFormula ?? []) if (!forms.some((form) => new RegExp(pattern).test(form))) fails.push(`missing ${pattern}`);
  for (const pattern of conv.mustNotFormula ?? []) if (forms.some((form) => new RegExp(pattern).test(form))) fails.push(`has ${pattern}`);
  const words = seen.split(/\s+/).filter(Boolean).length;
  if (conv.minWords && words < conv.minWords) fails.push(`only ${words} words`);
  if (conv.maxWords && words > conv.maxWords) fails.push(`${words} words, over ${conv.maxWords}`);
  if (conv.endsWithQuestion && !/\?\s*$/.test(seen)) fails.push("does not end with a question");
  if (options.followups !== false) {
    if (followups.length !== 3) fails.push(`${followups.length} follow-ups`);
    if (conv.followups === "solution" && !followups.some((line) => /soluzion|solution|complet|full|answer/i.test(line)))
      fails.push("no follow-up asks for the solution");
    if (conv.followups === "similar" && !followups.some((line) => /simil|altr[oa]|another|analog|esercizi|exercise|practice|prova/i.test(line)))
      fails.push("no follow-up asks for a similar exercise");
  }
  return { fails, words };
}
