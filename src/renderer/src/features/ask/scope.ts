/** What a chat reads from: the sources of the chosen subject's plans plus whatever the student added or removed by hand. */

export type ScopeItem = {
  /** `plan` is the saved chat's own plan; `source` is a library source or a document attached to the chat. */
  kind: "plan" | "source";
  id: string;
  title: string;
  /** Documents attached to the chat stay in its scope, so they cannot be taken out of the list. */
  locked?: boolean;
};

/** Swaps the previous subject's sources for the new subject's, leaving sources the student added by hand where they are. */
export function applySubject(
  picked: string[],
  previous: string[],
  next: string[],
): string[] {
  const dropped = new Set(previous);
  return [...new Set([...picked.filter((id) => !dropped.has(id)), ...next])];
}

export function addIds(picked: string[], ids: string[]): string[] {
  return [...new Set([...picked, ...ids])];
}

/** The list the Fonti chip shows, in a stable order: plan first, then sources by title. */
export function scopeItems(input: {
  planId: string | null;
  planTitle?: string;
  picked: string[];
  library: Array<{ id: string; title: string }>;
  held: Array<{ id: string; title: string }>;
}): ScopeItem[] {
  const items: ScopeItem[] = [];
  if (input.planId && input.planTitle)
    items.push({ kind: "plan", id: input.planId, title: input.planTitle });
  const sources: ScopeItem[] = [];
  for (const id of input.picked) {
    const known = input.library.find((source) => source.id === id);
    if (known) {
      sources.push({ kind: "source", id, title: known.title });
      continue;
    }
    const held = input.held.find((source) => source.id === id);
    if (held) sources.push({ kind: "source", id, title: held.title, locked: true });
  }
  sources.sort((a, b) => a.title.localeCompare(b.title));
  return [...items, ...sources];
}

/**
 * Whether a reply may rest on the model's own knowledge. It may when nothing narrows the chat to sources, or when the
 * student chose "Answer generally" for the question, which a retry of that question must keep.
 */
/**
 * Whether the chat's latest question was asked with "Answer generally", which Try again and Regenerate keep. The choice
 * made in this session wins; a chat reopened later has none, so its last reply's grounding says it.
 */
export function choseGeneral(
  session: boolean | undefined,
  messages: ReadonlyArray<{ role: string; grounding?: string | null }>,
): boolean {
  if (session !== undefined) return session;
  return messages.findLast((row) => row.role === "assistant")?.grounding === "general";
}

export function allowsGeneral(input: {
  chosen: boolean;
  planId: string | null | undefined;
  sourceCount: number;
  fileCount?: number;
}): boolean {
  return (
    input.chosen ||
    (!input.planId && input.sourceCount === 0 && (input.fileCount ?? 0) === 0)
  );
}
