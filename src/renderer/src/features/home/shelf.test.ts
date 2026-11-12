import { describe, expect, it } from "vitest";
import { bookLabel, coverColour, coverKind, mixedReasons, nextPickerRow, unsortedReasons } from "./shelf";

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
  it("moves focus after a sort to a row that has a picker, never to one Pyxis is still choosing for", () => {
    const rows = [
      { id: "a", sort: null },
      { id: "b", sort: "working" as const },
      { id: "c", sort: "working" as const },
      { id: "d", sort: "unsure" as const },
    ];
    // The next rows are being sorted and have no picker: the previous row has one.
    expect(nextPickerRow(rows, "a")).toBe("d");
    expect(nextPickerRow(rows, "d")).toBe("a");
    // Only rows with no picker left: the caller falls back to the moved cover.
    expect(nextPickerRow([{ id: "a", sort: null }, { id: "b", sort: "working" as const }], "a")).toBeNull();
    expect(nextPickerRow([{ id: "a", sort: null }], "a")).toBeNull();
    // The nearest row below comes first, then the nearest above.
    expect(nextPickerRow([{ id: "a", sort: null }, { id: "b", sort: null }, { id: "c", sort: null }], "b")).toBe("c");
    expect(nextPickerRow([{ id: "a", sort: null }, { id: "b", sort: null }, { id: "c", sort: null }], "c")).toBe("b");
  });

  it("explains a waiting file only by what really happened to it", () => {
    // A file the Library never asked about is not one Pyxis could not place.
    expect([...unsortedReasons([{ sort: null }])]).toEqual(["none"]);
    expect([...unsortedReasons([{ sort: "unsure" }])]).toEqual(["unsure"]);
    expect(unsortedReasons([{ sort: null }, { sort: "unsure" }, { sort: "working" }, { sort: "no-ai" }, { sort: "stopped" }])).toEqual(
      new Set(["none", "unsure", "working", "no-ai", "stopped"]),
    );
  });

  it("calls the reasons mixed whenever a group has two, a file still being sorted included", () => {
    expect(mixedReasons(unsortedReasons([{ sort: "unsure" }, { sort: "unsure" }]))).toBe(false);
    expect(mixedReasons(unsortedReasons([{ sort: "working" }]))).toBe(false);
    // One file Pyxis is still choosing for and one it could not place: "some files", not "these files".
    expect(mixedReasons(unsortedReasons([{ sort: "working" }, { sort: "unsure" }]))).toBe(true);
    expect(mixedReasons(unsortedReasons([{ sort: "unsure" }, { sort: null }]))).toBe(true);
  });
});
