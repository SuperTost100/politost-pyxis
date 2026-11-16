import { describe, expect, it } from "vitest";
import {
  cardFlag,
  cardName,
  expandRequest,
  PER_SUBJECT,
  sectionsOf,
  type BrowsedCard,
} from "./cardBrowserLogic";

function card(id: string, subjectId: string | null, extra: Partial<BrowsedCard> = {}): BrowsedCard {
  return {
    id,
    front: `Fronte ${id}`,
    back: `Retro ${id}`,
    planId: null,
    planTitle: null,
    topicId: null,
    topicTitle: null,
    subjectId,
    subjectName: subjectId,
    suspended: false,
    removed: false,
    handMade: false,
    state: "new",
    dueAt: null,
    lapses: 0,
    leech: false,
    passageId: null,
    sourceId: null,
    ...extra,
  };
}

const many = (subjectId: string | null, n: number) => Array.from({ length: n }, (_, i) => card(`${subjectId}-${i}`, subjectId));

describe("the subjects of the card browser", () => {
  it("shows eight cards of a subject and counts what is left for the button", () => {
    const sections = sectionsOf(
      {
        groups: [
          { subjectId: "a", subject: "Analisi", count: 20, noExam: 0 },
          { subjectId: "f", subject: "Fisica", count: 3, noExam: 0 },
        ],
        cards: [...many("a", 8), ...many("f", 3)],
      },
      new Set(),
    );
    expect(sections.map((section) => [section.key, section.shown.length, section.more.length, section.hidden])).toEqual([
      ["a", PER_SUBJECT, 0, 12],
      ["f", 3, 0, 0],
    ]);
  });

  it("puts the rest of an open subject after its first eight, in the order they arrive", () => {
    const [section] = sectionsOf(
      { groups: [{ subjectId: "a", subject: "Analisi", count: 11, noExam: 0 }], cards: many("a", 11) },
      new Set(["a"]),
    );
    expect(section!.shown.map((item) => item.id)).toEqual(Array.from({ length: 8 }, (_, i) => `a-${i}`));
    expect(section!.more.map((item) => item.id)).toEqual(["a-8", "a-9", "a-10"]);
    expect(section!.hidden).toBe(0);
  });

  it("goes back to eight at once when a subject is closed, though the last answer holds all of it", () => {
    const data = { groups: [{ subjectId: "a", subject: "Analisi", count: 11, noExam: 0 }], cards: many("a", 11) };
    const [section] = sectionsOf(data, new Set());
    expect(section!.shown).toHaveLength(8);
    expect(section!.more).toHaveLength(0);
    expect(section!.hidden).toBe(3);
  });

  it("keeps the cards with no subject in a section of their own, and opens it by its key", () => {
    const sections = sectionsOf(
      {
        groups: [
          { subjectId: "a", subject: "Analisi", count: 1, noExam: 0 },
          { subjectId: null, subject: null, count: 10, noExam: 0 },
        ],
        cards: [card("a-0", "a"), ...many(null, 10)],
      },
      new Set(["none"]),
    );
    expect(sections.map((section) => [section.key, section.shown.length, section.more.length])).toEqual([
      ["a", 1, 0],
      ["none", 8, 2],
    ]);
  });

  it("pins the card being edited when it ranks past the eight of a subject that is not open", () => {
    const data = { groups: [{ subjectId: "a", subject: "Analisi", count: 11, noExam: 0 }], cards: many("a", 11) };
    const [pinned] = sectionsOf(data, new Set(), "a-9");
    expect(pinned!.shown.map((item) => item.id)).not.toContain("a-9");
    expect(pinned!.pinned?.id).toBe("a-9");
    expect(pinned!.hidden).toBe(2);
    // Within the eight, or in the open part, it is already on the page.
    expect(sectionsOf(data, new Set(), "a-3")[0]!.pinned).toBeNull();
    expect(sectionsOf(data, new Set(["a"]), "a-9")[0]!.pinned).toBeNull();
    expect(sectionsOf(data, new Set(), "elsewhere")[0]!.pinned).toBeNull();
  });

  it("asks for the open subjects in a fixed order, with null for the cards with no subject", () => {
    expect(expandRequest(["b", "none", "a"])).toEqual(["a", "b", null]);
    expect(expandRequest(["b", "a"])).toEqual(["a", "b"]);
    expect(expandRequest([])).toEqual([]);
  });
});

describe("a card on the browser", () => {
  it("says the flag the student set or earned before when the card comes up", () => {
    const base = { removed: false, suspended: false, leech: false, state: "scheduled" as const };
    expect(cardFlag(base)).toBe("scheduled");
    expect(cardFlag({ ...base, state: "due" })).toBe("due");
    expect(cardFlag({ ...base, state: "new" })).toBe("new");
    expect(cardFlag({ ...base, leech: true })).toBe("leech");
    expect(cardFlag({ ...base, leech: true, suspended: true })).toBe("suspended");
    expect(cardFlag({ ...base, suspended: true, removed: true })).toBe("removed");
  });

  it("names a card by its front, with a cloze filled in and no markup", () => {
    expect(cardName({ front: "Che cos’è **l’entropia** in $S=k\\ln W$?" })).toBe("Che cos’è l’entropia in S=k\\ln W?");
    expect(cardName({ front: "{{c1::Elettroni}} orbitano il nucleo." })).toBe("Elettroni orbitano il nucleo.");
    expect(cardName({ front: "x".repeat(100) })).toHaveLength(60);
  });
});
