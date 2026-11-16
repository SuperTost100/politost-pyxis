import type { RequestOutput } from "../../../../shared/ipc";
import { clozeAnswer, isCloze } from "../../../../core/study/cloze";

export type Browse = RequestOutput<"study.browse">;
export type BrowsedCard = Browse["cards"][number];

/** How many cards of a subject show before "Mostra le altre". */
export const PER_SUBJECT = 8;

/** The key a subject has in the page: its id, or "none" for the cards with no subject. */
export const subjectKey = (subjectId: string | null) => subjectId ?? "none";

/** The subjects to ask for in full, as the request names them: `null` is "No subject". Sorted, so the same set is one query. */
export const expandRequest = (keys: readonly string[]): Array<string | null> =>
  [...keys].sort().map((key) => (key === "none" ? null : key));

export type SubjectSection = {
  key: string;
  subjectId: string | null;
  name: string | null;
  /** Every card the subject has under the filters. */
  count: number;
  /** How many of them have no exam. */
  noExam: number;
  /** The first cards, which show at once. */
  shown: BrowsedCard[];
  /** The rest, once the subject is open. */
  more: BrowsedCard[];
  /** What the subject has that is not on the page: the cards the button offers. */
  hidden: number;
  /** The card being edited when it ranks past the first eight of a subject that is not open: it stays on the page. */
  pinned: BrowsedCard | null;
};

/**
 * The page's subjects in the order they arrive, each with its first eight cards and, when the student has opened it,
 * the rest. A subject that is not open shows eight even when the answer holds more (it was asked for open a moment ago),
 * except for `keepId`, the card being edited, which the answer holds wherever it ranks and which the section pins.
 */
export function sectionsOf(
  data: Pick<Browse, "groups" | "cards">,
  open: ReadonlySet<string>,
  keepId?: string,
): SubjectSection[] {
  const bySubject = new Map<string, BrowsedCard[]>();
  for (const card of data.cards) {
    const key = subjectKey(card.subjectId);
    const list = bySubject.get(key);
    if (list) list.push(card);
    else bySubject.set(key, [card]);
  }
  return data.groups.map((group) => {
    const key = subjectKey(group.subjectId);
    const cards = bySubject.get(key) ?? [];
    const shown = cards.slice(0, PER_SUBJECT);
    const more = open.has(key) ? cards.slice(PER_SUBJECT) : [];
    const pinned =
      keepId && !shown.some((card) => card.id === keepId) && !more.some((card) => card.id === keepId)
        ? (cards.find((card) => card.id === keepId) ?? null)
        : null;
    return {
      key,
      subjectId: group.subjectId,
      name: group.subject,
      count: group.count,
      noExam: group.noExam,
      shown,
      more,
      hidden: Math.max(0, group.count - shown.length - more.length - (pinned ? 1 : 0)),
      pinned,
    };
  });
}

/** The card as written: a cloze shows its sentence with the hidden words filled in. */
export const frontText = (card: Pick<BrowsedCard, "front">) =>
  isCloze(card.front) ? clozeAnswer(card.front) : card.front;

/** A short plain-text name for a card, so each button on the page says which card it acts on. */
export const cardName = (card: Pick<BrowsedCard, "front">) =>
  frontText(card)
    .replace(/[*$_`#]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);

export type CardFlag = "removed" | "suspended" | "leech" | "new" | "due" | "scheduled";

/** The one state a card's foot says: a flag the student set or earned first, then when the card comes up. */
export function cardFlag(card: Pick<BrowsedCard, "removed" | "suspended" | "leech" | "state">): CardFlag {
  if (card.removed) return "removed";
  if (card.suspended) return "suspended";
  if (card.leech) return "leech";
  return card.state;
}
