import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createInstance, type TFunction } from "i18next";
import { beforeAll, describe, expect, it } from "vitest";
import { citedOrder, lessonPlaces, placeText, rowText, sourceGroups, sourceName, type CitedPlace } from "./sourcePlaces";

const book = { sourceId: "b", title: "Analisi matematica 2" };
const notes = { sourceId: "n", title: "Appunti · Lezione 14" };
const places: CitedPlace[] = [
  { n: 1, passageId: "p1", ...book, chapter: 5 },
  { n: 2, passageId: "p2", ...notes, page: 6 },
  { n: 3, passageId: "p3", ...book, page: 181 },
  { n: 4, passageId: "p4", ...notes, page: 7 },
  { n: 5, passageId: "p5", ...book, page: 172 },
  { n: 6, passageId: "p6", sourceId: "s", title: "Slide 3", slide: 12 },
  { n: 7, passageId: "p7", sourceId: "f", title: "Foto della lavagna" },
  { n: 8, passageId: "p8", sourceId: "t", title: "Testo incollato", section: "P8" },
  { n: 9, passageId: "p9", sourceId: "t", title: "Testo incollato" },
];

let it_: TFunction;
let en: TFunction;
beforeAll(async () => {
  const dir = resolve(import.meta.dirname, "../locales");
  const read = (file: string) => JSON.parse(readFileSync(resolve(dir, file), "utf8")) as Record<string, unknown>;
  const make = async (lng: string) => {
    const i18n = createInstance();
    await i18n.init({ lng, resources: { [lng]: { translation: read(`${lng}.json`) } }, interpolation: { escapeValue: false } });
    return i18n.t;
  };
  it_ = await make("it");
  en = await make("en");
});

describe("citedOrder", () => {
  it("lists each cited passage once, in the order the text first cites it, groups included", () => {
    expect(citedOrder("Uno [P3]. Due [P1, P3; 2]. Tre [P1].")).toEqual([3, 1, 2]);
  });

  it("reads a mark after a four-backtick fence that holds a three-backtick line, as the view does", () => {
    expect(citedOrder("Prima [P1].\n\n````md\n```\ncodice [P3]\n```\n````\n\nDopo il codice [P2].")).toEqual([1, 2]);
  });

  it("does not read code", () => {
    expect(citedOrder("Vedi `list[P4]` e\n\n```\nx[P5]\n```\n\nfine [P2].")).toEqual([2]);
  });
});

describe("sourceGroups", () => {
  it("orders sources by first use and their places by chapter, then page", () => {
    const groups = sourceGroups(places, [3, 2, 1, 5, 4]);
    expect(groups.map((group) => group.title)).toEqual(["Analisi matematica 2", "Appunti · Lezione 14"]);
    expect(groups[0]!.places.map((place) => placeText(it_, place.label!))).toEqual(["cap. 5", "p. 172", "p. 181"]);
    expect(groups[1]!.places.map((place) => placeText(en, place.label!))).toEqual(["p. 6", "p. 7"]);
  });

  it("lists two passages on the same page as one place that stands for both", () => {
    const twice = [...places, { n: 10, passageId: "p10", ...book, page: 172 }];
    const [first] = sourceGroups(twice, [5, 10, 3]);
    expect(first!.places.map((place) => [placeText(it_, place.label!), place.numbers])).toEqual([
      ["p. 172", [5, 10]],
      ["p. 181", [3]],
    ]);
  });

  it("leaves out places the text does not cite and lists a place cited twice once", () => {
    const groups = sourceGroups(places, [2, 2, 4]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.places.map((place) => place.passageId)).toEqual(["p2", "p4"]);
  });

  it("gives a slide its number, a lone photo no label, and numbers a source's unnamed passages", () => {
    const [slides, photo, text] = sourceGroups(places, [6, 7, 8, 9]);
    expect(placeText(it_, slides!.places[0]!.label!)).toBe("slide 12");
    expect(photo!.places[0]!.label).toBeNull();
    expect(text!.places.map((place) => placeText(it_, place.label!))).toEqual(["brano 1", "brano 2"]);
  });

  it("names a source whose title is not known by its fallback, apart from the others", () => {
    const groups = sourceGroups([{ n: 1, passageId: "x", fallbackTitle: "1. Dinamica" }, { n: 2, passageId: "y" }], [1, 2]);
    expect(groups.map((group) => [group.key, group.title])).toEqual([
      ["passage:x", "1. Dinamica"],
      ["passage:y", ""],
    ]);
  });
});

describe("sourceName", () => {
  it("never leaves a source unnamed: its title, else a word that says it has none", () => {
    const [named, blank] = sourceGroups([{ n: 1, passageId: "x", sourceId: "a", title: "Appunti" }, { n: 2, passageId: "y", sourceId: "b" }], [1, 2]);
    expect(sourceName(it_, named!)).toBe("Appunti");
    expect(sourceName(it_, blank!)).toBe("Fonte senza titolo");
    expect(sourceName(en, blank!)).toBe("Untitled source");
  });
});

describe("rowText", () => {
  const none = { verified: 0, failed: 0, pending: 0 };
  const say = (t: TFunction, order: number[], tally = none) => {
    const row = rowText(t, sourceGroups(places, order), tally);
    return row && [row.sources ?? (row.single ? `[${row.single.title ?? ""}]` : null), row.checks];
  };

  it("counts sources with their plural, in Italian and English", () => {
    expect(say(it_, [1, 3])).toEqual(["1 fonte", null]);
    expect(say(it_, [1, 2, 6])).toEqual(["3 fonti", null]);
    expect(say(en, [1, 3])).toEqual(["1 source", null]);
    expect(say(en, [1, 2])).toEqual(["2 sources", null]);
  });

  it("names the one passage of one source instead of counting it", () => {
    expect(say(it_, [3])).toEqual(["[Analisi matematica 2]", null]);
  });

  it("counts the checked results in every plural, with or without sources", () => {
    expect(say(it_, [1, 2], { verified: 1, failed: 0, pending: 0 })).toEqual(["2 fonti", "1 risultato verificato"]);
    expect(say(it_, [], { verified: 2, failed: 0, pending: 0 })).toEqual([null, "2 risultati verificati"]);
    expect(say(it_, [1, 2], { verified: 1, failed: 1, pending: 0 })).toEqual(["2 fonti", "1 su 2 risultati verificati"]);
    expect(say(it_, [], { verified: 0, failed: 1, pending: 0 })).toEqual([null, "1 risultato non verificato"]);
    expect(say(it_, [], { verified: 0, failed: 2, pending: 0 })).toEqual([null, "2 risultati non verificati"]);
    expect(say(en, [], { verified: 1, failed: 0, pending: 0 })).toEqual([null, "1 verified result"]);
    expect(say(en, [], { verified: 3, failed: 0, pending: 0 })).toEqual([null, "3 verified results"]);
    expect(say(en, [1, 2], { verified: 1, failed: 1, pending: 0 })).toEqual(["2 sources", "1 of 2 results verified"]);
    expect(say(en, [], { verified: 0, failed: 1, pending: 0 })).toEqual([null, "1 result not verified"]);
  });

  it("says the checks are running until every one has an answer", () => {
    expect(say(it_, [1, 2], { verified: 1, failed: 0, pending: 1 })).toEqual(["2 fonti", "Verifico i calcoli…"]);
  });

  it("says nothing with no source and no checked result", () => {
    expect(say(it_, [])).toBeNull();
  });
});

describe("lessonPlaces", () => {
  const sources = [
    { sourceId: "b", title: "Analisi matematica 2", places: [{ passageId: "x", page: 178 }, { passageId: "y", chapter: 5 }] },
    { sourceId: "n", title: "Appunti", places: [{ passageId: "z", section: "Polari" }] },
  ];

  it("numbers the lesson's passages in its own order and keeps the text's order of use", () => {
    const { places, order } = lessonPlaces("Prima [P3], poi [P1].", ["x", "y", "z"], sources);
    expect(places.map((place) => [place.n, place.title, place.page ?? place.chapter ?? place.section])).toEqual([
      [1, "Analisi matematica 2", 178],
      [2, "Analisi matematica 2", 5],
      [3, "Appunti", "Polari"],
    ]);
    expect(order).toEqual([3, 1]);
  });

  it("lists every passage given when no mark of the text names one of them", () => {
    expect(lessonPlaces("Vale [P9].", ["x"], sources).order).toEqual([1]);
    expect(lessonPlaces("Vale [P9] e [P3].", ["x", "y", "z"], sources).order).toEqual([3]);
  });

  it("lists every passage given when the text cites none, as the book's own text", () => {
    expect(lessonPlaces("Testo del libro.", ["x", "gone", "z"], sources).order).toEqual([1, 3]);
  });
});
