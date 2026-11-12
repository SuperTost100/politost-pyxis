import { describe, expect, it } from "vitest";
import { subjectInitials, subjectSymbol } from "./subject-symbol";

const symbols: Array<[string, string]> = [
  // The owner's four subjects.
  ["Analisi Matematica 1", "integral"],
  ["Fisica 2", "atom"],
  ["Linguaggio cinematografico e storia del cinema", "clapperboard"],
  ["Tecnologie Digitali", "chip"],
  // Common Italian university subjects.
  ["Geometria e algebra lineare", "matrix"],
  ["Algebra lineare e geometria", "matrix"],
  ["Geometria", "compass"],
  ["Chimica generale", "flask"],
  ["Fondamenti di informatica", "code"],
  ["Programmazione ad oggetti", "code"],
  ["Algoritmi e strutture dati", "code"],
  ["Architettura dei calcolatori", "chip"],
  ["Elettronica applicata", "chip"],
  ["Elettrotecnica", "bolt"],
  ["Campi elettromagnetici", "wave"],
  ["Teoria dei segnali", "wave"],
  ["Economia e organizzazione aziendale", "chart"],
  ["Diritto privato", "scales"],
  ["Statistica", "dice"],
  ["Calcolo delle probabilità", "dice"],
  ["Biologia molecolare", "dna"],
  ["Storia contemporanea", "column"],
  ["Storia dell'arte moderna", "palette"],
  ["Architettura e composizione", "building"],
  ["Disegno tecnico industriale", "pencil"],
  ["Lingua inglese B2", "speech"],
  ["Inglese", "speech"],
  ["Reti di calcolatori", "chip"],
  ["Reti logiche", "network"],
  ["Meccanica razionale", "gear"],
  ["Fondamenti di automatica", "gear"],
  ["Fisica tecnica", "atom"],
  ["Psicologia generale", "brain"],
  ["Anatomia umana", "pulse"],
  ["Letteratura italiana", "quill"],
  ["Sociologia dei media", ""],
];

describe("the symbol on a subject's book", () => {
  for (const [name, symbol] of symbols)
    it(`${name}: ${symbol || "initials"}`, () => {
      const found = subjectSymbol(name);
      if (symbol) expect(found).toEqual({ symbol });
      else expect(found).toHaveProperty("initials");
    });

  it("ignores accents and case", () => {
    expect(subjectSymbol("PROBABILITÀ")).toEqual({ symbol: "dice" });
    expect(subjectSymbol("fisica")).toEqual({ symbol: "atom" });
  });

  it("matches the start of a word only", () => {
    // "arte" is a whole word for the palette, so "Parte generale" and "Artificiale" are not art.
    expect(subjectSymbol("Parte generale")).toEqual({ initials: "PG" });
    expect(subjectSymbol("Intelligenza artificiale")).toEqual({ initials: "IA" });
  });
});

describe("a subject's initials", () => {
  it.each([
    ["Sociologia dei media", "SM"],
    ["Teoria dei giochi", "TG"],
    ["Laboratorio 2", "L2"],
    ["Teoria e tecnica della radio", "TTR"],
    ["Pianificazione dell'offerta", "PO"],
    ["", ""],
  ])("%s is %s", (name, initials) => {
    expect(subjectInitials(name)).toBe(initials);
  });
});
