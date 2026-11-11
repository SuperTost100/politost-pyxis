import { describe, expect, it } from "vitest";
import { bookLabel, coverColour, coverKind } from "./shelf";

describe("the Library's shelf", () => {
  it("gives a subject the same cover colour every time, from its id alone", () => {
    const id = "0193f1c2-7a4e-7cc1-9a1b-2f3d4e5f6a7b";
    expect(coverColour(id)).toBe(coverColour(id));
    const colours = new Set(Array.from({ length: 60 }, (_, n) => coverColour(`subject-${n}`)));
    expect([...colours].every((colour) => colour >= 1 && colour <= 6)).toBe(true);
    expect(colours.size).toBe(6);
  });

  it("draws only what core records: a free book, a past paper, a photo, slides, or pages", () => {
    expect(coverKind({ kind: "smartbook", pastPaper: false })).toBe("book");
    expect(coverKind({ kind: "pdf", pastPaper: true })).toBe("exam");
    expect(coverKind({ kind: "image", pastPaper: true })).toBe("exam");
    expect(coverKind({ kind: "image", pastPaper: false })).toBe("photo");
    expect(coverKind({ kind: "pptx", pastPaper: false })).toBe("slides");
    expect(coverKind({ kind: "pdf", pastPaper: false })).toBe("pages");
    expect(coverKind({ kind: "link", pastPaper: false })).toBe("pages");
  });

  it("prints a short subject name whole and a long one as its initials", () => {
    expect(bookLabel("Analisi 1")).toBe("Analisi 1");
    expect(bookLabel("Geometria e algebra lineare")).toBe("GAL");
    expect(bookLabel("Probabilità e statistica")).toBe("PS");
    expect(bookLabel("Analisi matematica 2")).toBe("AM2");
    expect(bookLabel("Metodi matematici per l'ingegneria dell'informazione")).toBe("MMII");
    expect(bookLabel("Termodinamica")).toBe("Termodinamica".slice(0, 12));
  });
});
