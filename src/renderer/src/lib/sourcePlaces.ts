import type { TFunction } from "i18next";
import { splitCitationGroups } from "../../../shared/smart-text";

/** A passage a text cites as [Pn], with what is known of its source and where the passage sits in it. */
export type CitedPlace = {
  /** The number of its [Pn] marks. */
  n: number;
  passageId: string;
  sourceId?: string;
  /** The source's title; a place without one is listed under `fallbackTitle`. */
  title?: string;
  page?: number;
  slide?: number;
  chapter?: number;
  /** A section's name, for a source without pages, slides or chapters. */
  section?: string | null;
  /** Shown as the source's name when the title is not known. */
  fallbackTitle?: string;
};

/** How a place is named in the list: a page, a slide, a chapter, a section, or the passage's place in its source. */
export type PlaceLabel =
  | { kind: "page" | "slide" | "chapter" | "passage"; n: number }
  | { kind: "section"; text: string };

/** A place as the list shows it. Passages on the same page are one place, which stands for all their numbers. */
export type ListedPlace = CitedPlace & { label: PlaceLabel | null; numbers: number[] };
export type SourceGroup = { key: string; sourceId?: string; title: string; places: ListedPlace[] };

/** The passage numbers a text cites, each once, in the order the text first cites them. Code is not read. */
export function citedOrder(markdown: string): number[] {
  const text = markdown.replace(/```[\s\S]*?(?:```|$)/g, "").replace(/`[^`\n]*`/g, "");
  return [...new Set([...splitCitationGroups(text).matchAll(/\[P(\d+)\]/g)].map((match) => Number(match[1])))];
}

const KIND_ORDER = { chapter: 0, page: 1, slide: 2 } as const;

function placeLabel(place: CitedPlace): PlaceLabel | null {
  if (place.page != null) return { kind: "page", n: place.page };
  if (place.slide != null) return { kind: "slide", n: place.slide };
  if (place.chapter != null) return { kind: "chapter", n: place.chapter };
  const section = place.section?.trim();
  // "P3" is a passage number, not a name a reader knows.
  return section && !/^P\d+$/.test(section) ? { kind: "section", text: section } : null;
}

/**
 * The sources of the passages a text cites, in the order the text first uses them. Each source lists its places once:
 * chapters, pages and slides in their order, then the rest in the order they are cited. Passages with the same page (or
 * slide, chapter, section) are one place. A source with several places that have no name numbers them ("brano 1",
 * "brano 2"); a single one has no label, and its source's name is the link.
 */
export function sourceGroups(places: readonly CitedPlace[], order: readonly number[]): SourceGroup[] {
  const byNumber = new Map(places.map((place) => [place.n, place]));
  const groups = new Map<string, SourceGroup>();
  const seen = new Set<string>();
  for (const n of order) {
    const place = byNumber.get(n);
    if (!place || seen.has(place.passageId)) continue;
    seen.add(place.passageId);
    const key = place.sourceId || `passage:${place.passageId}`;
    const group = groups.get(key) ?? {
      key,
      sourceId: place.sourceId,
      title: place.title?.trim() || place.fallbackTitle?.trim() || "",
      places: [],
    };
    const label = placeLabel(place);
    const same = label && group.places.find((listed) => JSON.stringify(listed.label) === JSON.stringify(label));
    if (same) same.numbers.push(place.n);
    else group.places.push({ ...place, label, numbers: [place.n] });
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    const numbered = group.places.filter((place) => place.label && place.label.kind !== "section");
    const rest = group.places.filter((place) => !numbered.includes(place));
    numbered.sort((a, b) => {
      const x = a.label as { kind: keyof typeof KIND_ORDER; n: number };
      const y = b.label as { kind: keyof typeof KIND_ORDER; n: number };
      return KIND_ORDER[x.kind] - KIND_ORDER[y.kind] || x.n - y.n;
    });
    group.places = [...numbered, ...rest];
    const unnamed = group.places.filter((place) => !place.label);
    if (group.places.length > 1) unnamed.forEach((place, index) => (place.label = { kind: "passage", n: index + 1 }));
  }
  return [...groups.values()];
}

/** What the math checks of a text came to: each claim verified, failed, still running, or with nothing to say. */
export type CheckTally = { verified: number; failed: number; pending: number };

type Translate = TFunction;

export function placeText(t: Translate, label: PlaceLabel): string {
  if (label.kind === "section") return label.text;
  return t(`sourcesRow.place.${label.kind}`, { n: label.n });
}

/** The row's words for the checked results, or null when no result was checked. */
export function checksText(t: Translate, tally: CheckTally): string | null {
  if (tally.pending > 0) return t("sourcesRow.checking");
  const count = tally.verified + tally.failed;
  if (count === 0) return null;
  if (tally.failed === 0) return t("sourcesRow.verified", { count });
  if (tally.verified === 0) return t("sourcesRow.notVerified", { count });
  return t("sourcesRow.someVerified", { ok: tally.verified, count });
}

/**
 * What the row says when it is closed. `single` is the one passage of one source, which the row names and opens itself.
 * Null: there is nothing to say, no source and no checked result.
 */
export function rowText(
  t: Translate,
  groups: readonly SourceGroup[],
  tally: CheckTally,
): { sources: string | null; single: ListedPlace | null; checks: string | null } | null {
  const checks = checksText(t, tally);
  const single = groups.length === 1 && groups[0]!.places.length === 1 ? groups[0]!.places[0]! : null;
  const sources = groups.length > 0 && !single ? t("sourcesRow.sources", { count: groups.length }) : null;
  if (!sources && !single && !checks) return null;
  return { sources, single, checks };
}

type LessonSource = {
  sourceId: string;
  title: string;
  places: ReadonlyArray<{ passageId: string; page?: number; slide?: number; chapter?: number; section?: string }>;
};

/**
 * A lesson's passages as the row lists them: [Pn] is the lesson's n-th passage, and its source and place come from the
 * sources the lesson was given. The order is the text's; a text with no marks, such as the book's own text shown when the
 * lesson could not be written, lists every passage it was given.
 */
export function lessonPlaces(
  markdown: string,
  passageIds: readonly string[],
  sources: readonly LessonSource[],
): { places: CitedPlace[]; order: number[] } {
  const where = new Map(
    sources.flatMap((source) => source.places.map((place) => [place.passageId, { source, place }] as const)),
  );
  const places = passageIds.flatMap((passageId, index): CitedPlace[] => {
    const found = where.get(passageId);
    if (!found) return [];
    const { source, place } = found;
    return [
      {
        n: index + 1,
        passageId,
        sourceId: source.sourceId,
        title: source.title,
        page: place.page,
        slide: place.slide,
        chapter: place.chapter,
        section: place.section,
      },
    ];
  });
  const cited = citedOrder(markdown);
  return { places, order: cited.length > 0 ? cited : places.map((place) => place.n) };
}
