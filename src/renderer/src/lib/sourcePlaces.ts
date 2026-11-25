import type { TFunction } from "i18next";
import { parseMarkdown, start, walk } from "../../../shared/markdown-tree";
import { PASSAGE_MARK, parseLooseJson, replaceMarkRuns, splitCitationGroups } from "../../../shared/smart-text";
import { TOOL_FENCE } from "../../../shared/tool-blocks";

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
  /** The version of the file the passage was read from: a linked file read again has a new one. */
  version?: number;
  /** Shown as the source's name when the title is not known. */
  fallbackTitle?: string;
};

/** How a place is named in the list: a page, a slide, a chapter, a section, or the passage's place in its source. */
export type PlaceLabel =
  | { kind: "page" | "slide" | "chapter" | "passage"; n: number }
  | { kind: "section"; text: string };

/**
 * A place as the list shows it. Passages on the same page are one place, which stands for all of them: `passages` keeps
 * each, so the card can quote the one each sentence rests on, and `numbers` are their [Pn] numbers.
 */
export type ListedPlace = CitedPlace & {
  label: PlaceLabel | null;
  /** The same page of another version of the file is listed too, so the version is named. */
  versionShown?: boolean;
  numbers: number[];
  passages: Array<{ n: number; passageId: string }>;
};
export type SourceGroup = { key: string; sourceId?: string; title: string; places: ListedPlace[] };

/** Fields of the app's own blocks that hold code to run, not words to read. */
const CODE_FIELDS = new Set(["code"]);

/** Every string of a block's JSON that the app draws as text, in order. */
function blockTexts(value: unknown, key = ""): string[] {
  if (typeof value === "string") return CODE_FIELDS.has(key) ? [] : [value];
  if (Array.isArray(value)) return value.flatMap((item) => blockTexts(item, key));
  if (value && typeof value === "object") return Object.entries(value).flatMap(([name, item]) => blockTexts(item, name));
  return [];
}

/**
 * The passage numbers a text cites, each once, in the order the text first cites them. Code is found by the Markdown
 * parser, as `linkCitations` finds it (not in code, a formula or a link), so a mark the view draws is a mark the row
 * lists. The app's own blocks (```pyxis-*,
 * such as a worked example or a figure's caption) are read for the text they draw; real code and a tool's block are not.
 */
export function citedOrder(markdown: string): number[] {
  const found: Array<{ at: number; numbers: number[] }> = [];
  const numbers = (text: string) => [...splitCitationGroups(text).matchAll(/\[P(\d+)\]/g)].map((match) => Number(match[1]));
  // A block's text is Markdown too: its marks are read as the prose's are, so one in its formula is not a citation.
  const proseNumbers = (text: string) => {
    const inText: number[] = [];
    replaceMarkRuns(text, PASSAGE_MARK, (run) => {
      inText.push(...numbers(run));
      return run;
    });
    return inText;
  };
  // Prose, by the rule the view links its marks with: not in code, a formula or a link.
  replaceMarkRuns(markdown, PASSAGE_MARK, (run, at) => {
    found.push({ at, numbers: numbers(run) });
    return run;
  });
  walk(parseMarkdown(markdown), (node) => {
    if (node.type !== "code") return;
    const lang = (node as { lang?: string | null }).lang ?? "";
    if (lang.startsWith("pyxis-") && lang !== TOOL_FENCE)
      found.push({ at: start(node), numbers: blockTexts(parseLooseJson(node.value ?? "")).flatMap(proseNumbers) });
    return false;
  });
  return [...new Set(found.sort((a, b) => a.at - b.at).flatMap((entry) => entry.numbers))];
}

/** The ids of the passages a text's marks name (`order`), where [Pn] is `cited[n - 1]`: what its row lists. */
export function citedPassageIds(cited: ReadonlyArray<{ passageId: string }>, order: readonly number[]): string[] {
  return [...new Set(order.flatMap((n) => (cited[n - 1] ? [cited[n - 1]!.passageId] : [])))];
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
    // One place per page (or slide, chapter, section) of one version of the file: two versions each open their own.
    const same =
      label &&
      group.places.find((listed) => JSON.stringify(listed.label) === JSON.stringify(label) && listed.version === place.version);
    if (same) {
      same.numbers.push(place.n);
      same.passages.push({ n: place.n, passageId: place.passageId });
    } else group.places.push({ ...place, label, numbers: [place.n], passages: [{ n: place.n, passageId: place.passageId }] });
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
    for (const place of group.places)
      place.versionShown = group.places.some(
        (other) => other !== place && other.label && JSON.stringify(other.label) === JSON.stringify(place.label),
      );
    const unnamed = group.places.filter((place) => !place.label);
    if (group.places.length > 1) unnamed.forEach((place, index) => (place.label = { kind: "passage", n: index + 1 }));
  }
  return [...groups.values()];
}

/**
 * The one place of a source that has no page, slide, chapter or section, such as a photo, which has no button of its
 * own in the list: the source's name stands for it, opens it and shows its passage. Null for any other source.
 */
export function nameOpensPlace(group: SourceGroup): ListedPlace | null {
  return group.places.length === 1 && !group.places[0]!.label ? group.places[0]! : null;
}

/** What the math checks of a text came to: each claim verified, failed, still running, or with nothing to say. */
export type CheckTally = { verified: number; failed: number; pending: number };

type Translate = TFunction;

/**
 * A place's words in the list: its page (or slide, chapter, section), and its file's version when the same page of
 * another version is listed too.
 */
export function listedPlaceText(t: Translate, place: ListedPlace): string {
  if (!place.label) return "";
  const text = placeText(t, place.label);
  return place.versionShown && place.version !== undefined ? `${text} · ${t("sourcesRow.version", { n: place.version })}` : text;
}

export function placeText(t: Translate, label: PlaceLabel): string {
  if (label.kind === "section") return label.text;
  return t(`sourcesRow.place.${label.kind}`, { n: label.n });
}

/** A source's name in the row: its title, or a word that says it has none, so no link is ever blank. */
export function sourceName(t: Translate, group: SourceGroup): string {
  return group.title || t("sourcesRow.untitled");
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
  places: ReadonlyArray<{ passageId: string; page?: number; slide?: number; chapter?: number; section?: string; version?: number }>;
};

/**
 * A lesson's passages as the row lists them: [Pn] is the lesson's n-th passage, and its source and place come from the
 * sources the lesson was given. The order is the text's. A text none of whose marks names one of its passages, such as
 * the book's own text shown when the lesson could not be written, lists every passage it was given.
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
        version: place.version,
      },
    ];
  });
  const known = new Set(places.map((place) => place.n));
  const cited = citedOrder(markdown).filter((n) => known.has(n));
  return { places, order: cited.length > 0 ? cited : places.map((place) => place.n) };
}
