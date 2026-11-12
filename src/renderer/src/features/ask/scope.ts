/** What the chat's subject chip shows, and what a new chat's first question goes out with. */

/**
 * A new chat's choice before its first question: Pyxis picks, a subject, or the whole Library. A subject carries its id
 * as well as its name, because the choice waits in the session while the student visits the whiteboard or the Library,
 * where the subject may be renamed.
 */
export type NewChatSubject = { kind: "auto" } | { kind: "subject"; name: string; id?: string } | { kind: "library" };

export type ChipState =
  /** No subject yet: Pyxis picks one from where the first good passages come from. */
  | { kind: "auto" }
  | { kind: "subject"; name: string; by: "pyxis" | "student" }
  /** The student chose the whole Library. */
  | { kind: "library" }
  /** An older chat whose sources were picked by hand (or an exam with no subject): it keeps answering from them. */
  | { kind: "picked"; count: number };

/** The chip of a saved chat, from what `chats.read` returns. */
export function chipState(chat: {
  subject: string | null;
  subjectBy: "pyxis" | "student" | null;
  planId: string | null;
  sourceIds: readonly string[];
  held: ReadonlyArray<{ id: string }>;
}): ChipState {
  if (chat.subject) return { kind: "subject", name: chat.subject, by: chat.subjectBy ?? "student" };
  const attached = new Set(chat.held.map((source) => source.id));
  const picked = chat.sourceIds.filter((id) => !attached.has(id)).length + (chat.planId ? 1 : 0);
  if (picked > 0) return { kind: "picked", count: picked };
  return chat.subjectBy === "student" ? { kind: "library" } : { kind: "auto" };
}

/** The chip of a new chat, before anything is sent. */
export function newChipState(choice: NewChatSubject): ChipState {
  return choice.kind === "subject" ? { kind: "subject", name: choice.name, by: "student" } : choice;
}

/** What `chats.ask` sends for a new chat's choice: a name, null for the whole Library, nothing when Pyxis picks. */
export function subjectToSend(choice: NewChatSubject): string | null | undefined {
  return choice.kind === "subject" ? choice.name : choice.kind === "library" ? null : undefined;
}

/**
 * A kept choice against the Library's subjects now: a renamed subject has its new name, and one that was deleted goes
 * back to Pyxis's choice. A choice saved without an id is found by its name.
 */
export function settleNewSubject(
  choice: NewChatSubject,
  subjects: ReadonlyArray<{ id: string; name: string }>,
): NewChatSubject {
  if (choice.kind !== "subject") return choice;
  const name = choice.name.toLocaleLowerCase();
  const row = subjects.find((subject) => (choice.id ? subject.id === choice.id : subject.name.toLocaleLowerCase() === name));
  return row ? { kind: "subject", id: row.id, name: row.name } : { kind: "auto" };
}
