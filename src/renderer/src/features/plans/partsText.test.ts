import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import i18next from "i18next";
import { describe, expect, it } from "vitest";
import { nowPartText, partPath, partsHeading, partsLine, resumeWhen, type NextPart, type Outline } from "./partsText";

async function translator(language: "en" | "it") {
  const instance = i18next.createInstance();
  await instance.init({
    lng: language,
    resources: {
      [language]: {
        translation: JSON.parse(readFileSync(resolve(import.meta.dirname, `../../locales/${language}.json`), "utf8")),
      },
    },
    interpolation: { escapeValue: false },
  });
  return (key: string, options: Record<string, unknown> = {}) => instance.t(key, options);
}

// Friday 13 November 2026, mid-morning.
const NOW = new Date(2026, 10, 13, 10).getTime();
const at = (day: number, hour = 18) => new Date(2026, 10, day, hour).getTime();

const part = (over: Partial<NextPart> = {}): NextPart => ({
  position: 3,
  count: 8,
  kind: "part",
  title: "Insiemi aperti e chiusi",
  minutes: 6,
  written: true,
  resumeFrom: null,
  ...over,
});

const outline = (done: number[], over: Partial<Outline> = {}): Outline => {
  const parts = Array.from({ length: 9 }, (_, index) => ({
    id: `p${index + 1}`,
    position: index + 1,
    kind: index === 8 ? ("recap" as const) : ("part" as const),
    title: `Parte ${index + 1}`,
    about: "",
    minutes: 5,
    state: "written" as const,
    done: done.includes(index + 1),
  }));
  return {
    id: "o",
    parts,
    teaching: 8,
    done: done.filter((position) => position <= 8).length,
    minutesLeft: parts.filter((entry) => !entry.done).reduce((sum, entry) => sum + entry.minutes, 0),
    ...over,
  };
};

describe("the exam page's suggested part", () => {
  it("opens a part at the lesson step's address", () => {
    expect(partPath("p-1", "t-2", 3)).toBe("/plans/p-1/lesson/t-2?part=3");
  });

  it("names the part, its place and its minutes under Consigliato adesso", async () => {
    const it = await translator("it");
    expect(nowPartText(it, { part: part(), topic: "Funzioni di più variabili", now: NOW, language: "it" })).toEqual({
      title: "Insiemi aperti e chiusi",
      line: "Parte 3 di 8 · Funzioni di più variabili · circa 6 minuti",
    });
    const en = await translator("en");
    expect(nowPartText(en, { part: part({ minutes: 1 }), topic: "Functions", now: NOW, language: "en" }).line).toBe(
      "Part 3 of 8 · Functions · about 1 minute",
    );
    expect(nowPartText(it, { part: part({ minutes: 1 }), topic: "Funzioni", now: NOW, language: "it" }).line).toBe(
      "Parte 3 di 8 · Funzioni · circa 1 minuto",
    );
  });

  it("puts the number in the title and the day in the line under Riprendi da", async () => {
    const it = await translator("it");
    const resumed = part({ position: 4, title: "Limitati, compatti, connessi", minutes: 5, resumeFrom: { position: 3, at: at(12) } });
    expect(nowPartText(it, { part: resumed, topic: "Funzioni di più variabili", now: NOW, language: "it" })).toEqual({
      title: "Parte 4 · Limitati, compatti, connessi",
      line: "Funzioni di più variabili · circa 5 minuti · ieri hai finito la parte 3",
    });
    const en = await translator("en");
    expect(nowPartText(en, { part: resumed, topic: "Functions", now: NOW, language: "en" }).line).toBe(
      "Functions · about 5 minutes · you finished part 3 yesterday",
    );
  });

  it("says yesterday, a weekday within the week, or the date", async () => {
    const it = await translator("it");
    const en = await translator("en");
    // Late last night is still yesterday, though less than a day ago.
    expect(resumeWhen(it, at(12, 23), NOW, "it")).toBe("ieri");
    expect(resumeWhen(it, at(9), NOW, "it")).toBe("lunedì");
    expect(resumeWhen(en, at(9), NOW, "en")).toBe("on Monday");
    expect(resumeWhen(it, at(6), NOW, "it")).toBe("il 6 novembre");
    expect(resumeWhen(en, at(6), NOW, "en")).toBe("on November 6");
  });

  it("leaves a topic of one part to the lesson's own title, since its page has no Parte 1 di 1", async () => {
    const it = await translator("it");
    expect(nowPartText(it, { part: part({ position: 1, count: 1 }), topic: "Taylor", now: NOW, language: "it" })).toBeNull();
  });

  it("names the recap without a number", async () => {
    const it = await translator("it");
    const recap = part({ position: 9, kind: "recap", title: "Ripasso", minutes: 4 });
    expect(nowPartText(it, { part: recap, topic: "Funzioni", now: NOW, language: "it" })).toEqual({
      title: "Ripasso del capitolo",
      line: "Funzioni · circa 4 minuti",
    });
    expect(
      nowPartText(it, { part: { ...recap, resumeFrom: { position: 8, at: at(12) } }, topic: "Funzioni", now: NOW, language: "it" }),
    ).toEqual({ title: "Ripasso del capitolo", line: "Funzioni · circa 4 minuti · ieri hai finito la parte 8" });
  });
});

describe("the open topic's parts on the path", () => {
  it("counts the parts read and the minutes left, with plurals in both languages", async () => {
    const it = await translator("it");
    const en = await translator("en");
    expect(partsLine(it, outline([1, 2], { minutesLeft: 43 }))).toBe("2 parti su 8 lette · circa 43 minuti alla fine");
    expect(partsLine(en, outline([1, 2], { minutesLeft: 43 }))).toBe("2 of 8 parts read · about 43 minutes to go");
    expect(partsLine(it, outline([1], { minutesLeft: 1 }))).toBe("1 parte su 8 letta · circa 1 minuto alla fine");
    expect(partsLine(en, outline([1], { minutesLeft: 1 }))).toBe("1 of 8 parts read · about 1 minute to go");
    expect(partsLine(it, outline([]))).toBe("0 parti su 8 lette · circa 45 minuti alla fine");
  });

  it("leaves the line alone once every part is done, and on a one-part topic", async () => {
    const it = await translator("it");
    expect(partsLine(it, outline([1, 2, 3, 4, 5, 6, 7, 8, 9]))).toBeNull();
    const single = outline([]);
    expect(partsLine(it, { ...single, parts: single.parts.slice(0, 1), teaching: 1 })).toBeNull();
  });

  it("says whether the lesson ends with a recap", async () => {
    const it = await translator("it");
    expect(partsHeading(it, outline([]))).toBe("Lezione in 8 parti e un ripasso");
    const two = outline([]);
    expect(partsHeading(it, { ...two, parts: two.parts.slice(0, 2), teaching: 2 })).toBe("Lezione in 2 parti");
    expect(partsHeading(await translator("en"), outline([]))).toBe("Lesson in 8 parts and a recap");
  });
});
