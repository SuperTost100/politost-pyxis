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

/**
 * The subject a new chat starts on: the only one when the student has exactly one, so a question typed straight away
 * reads its plans' sources. With none or several, no subject until the student picks.
 */
export function newChatSubject(subjects: ReadonlyArray<{ name: string }>): string {
  return subjects.length === 1 ? subjects[0]!.name : "";
}

/**
 * The changes to a chat's scope still running: the new chat's default subject, a subject the student picks, a starter's
 * plan. A question waits for `settled`, so it goes out with the subject and sources the student sees.
 *
 * Each change belongs to the chat on screen when it started. Ask calls `open` whenever that chat changes: it returns the
 * chat's token, and a question in the new chat no longer waits for the old chat's changes. A change checks `isCurrent`
 * with its token before it touches the scope, so it never lands on another chat.
 *
 * `choose` records that the student picked a subject in this chat, "No subject" included, which leaves the value empty.
 * The default subject is wanted only while the chat is on screen and the student has made no such choice.
 */
export function scopeChanges() {
  let chat = 0;
  let pending = new Set<Promise<unknown>>();
  let chosen = false;
  return {
    open(): number {
      chat += 1;
      pending = new Set();
      chosen = false;
      return chat;
    },
    isCurrent(token: number): boolean {
      return token === chat;
    },
    /** The current chat's token, for a change starting now. */
    token(): number {
      return chat;
    },
    choose(): void {
      chosen = true;
    },
    wantsDefault(token: number): boolean {
      return token === chat && !chosen;
    },
    track<T>(change: Promise<T>): Promise<T> {
      const changes = pending;
      changes.add(change);
      const done = () => {
        changes.delete(change);
      };
      // The finished change leaves its own chat's set; a failure counts as finished.
      change.then(done, done);
      return change;
    },
    /**
     * Resolves once no change of the chat on screen is running: it waits for all of them, then again for any that started
     * meanwhile. A failed change counts as finished; the question goes out with the scope as it stands. It resolves to
     * false when that chat was left while the question waited: the scope on screen is then another chat's, and the
     * question must not go out with it.
     */
    async settled(): Promise<boolean> {
      const mine = chat;
      const changes = pending;
      while (changes.size > 0 && chat === mine) await Promise.allSettled([...changes]);
      return chat === mine;
    },
  };
}

/**
 * The new chat's default: the only subject, chosen once the subject list is read. `load` must return the current list,
 * not a cached one. `wanted` is checked after the list arrives, so the choice is skipped when the student has moved to
 * another chat or picked a subject meanwhile.
 */
export async function onlySubject(
  load: () => Promise<ReadonlyArray<{ name: string }>>,
  wanted: () => boolean,
  choose: (name: string) => Promise<void>,
): Promise<void> {
  const only = newChatSubject(await load());
  if (only && wanted()) await choose(only);
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
