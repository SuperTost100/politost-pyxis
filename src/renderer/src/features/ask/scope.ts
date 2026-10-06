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
