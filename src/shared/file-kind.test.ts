import { describe, expect, it } from "vitest";
import { classifyFile, fileKindOf, looksLikeAuthors, type FileKind, type FileKindInput } from "./file-kind";

/** A file as a student's course folder names it: the name with its extension, as `sources` stores it (title and kind). */
function file(name: string, extra: Partial<FileKindInput> = {}): FileKindInput {
  const dot = name.lastIndexOf(".");
  const ext = name.slice(dot + 1).toLowerCase();
  const kind = ["jpg", "jpeg", "png", "heic", "webp"].includes(ext) ? "image" : ext === "txt" || ext === "md" ? "text" : ext;
  return { kind, title: name.slice(0, dot), ...extra };
}

// Each row: the file's name, what else Pyxis knows about it, and the kind a student would give it.
const names: Array<[string, Partial<FileKindInput>, FileKind]> = [
  ["Temi d'esame 2022-2025 con soluzioni.pdf", {}, "exam"],
  ["Lezione 06 - slide.pdf", {}, "slides"],
  ["appunti_fisica2_def(1).pdf", {}, "notes"],
  ["Bramanti Pagani Salsa - Analisi matematica 1.pdf", {}, "book"],
  ["IMG_2041.jpg", {}, "photo"],
  ["Esercitazione 3 soluzioni.docx", {}, "exercises"],
  ["Tema d'esame 12 luglio 2025.pdf", {}, "exam"],
  ["Appello 2024-02-14.pdf", {}, "exam"],
  ["Prova in itinere 2023.pdf", {}, "exam"],
  ["Compito A 2021.pdf", {}, "exam"],
  ["Scritto 18 giugno.pdf", {}, "exam"],
  ["Fisica2_esame_gennaio.pdf", {}, "exam"],
  ["Midterm 2023 solutions.pdf", {}, "exam"],
  ["Lucidi capitolo 3.pdf", {}, "slides"],
  ["Lez07_integrali.pdf", {}, "slides"],
  ["Lecture 12.pdf", {}, "slides"],
  ["Presentazione progetto.pdf", {}, "slides"],
  ["Lezione 6.pptx", {}, "slides"],
  ["Temi d'esame.pptx", {}, "slides"],
  ["Appunti lezioni 1-12.pdf", {}, "notes"],
  ["Appunti della lezione 5.docx", {}, "notes"],
  ["Riassunto termodinamica.pdf", {}, "notes"],
  ["Lecture notes week 3.pdf", {}, "notes"],
  ["Note sul campo elettrico.md", {}, "notes"],
  ["Esercizi serie 3.pdf", {}, "exercises"],
  ["Esercizi d'esame svolti.pdf", {}, "exercises"],
  ["Eserciziario di Fisica 1.pdf", {}, "exercises"],
  ["Problemi di elettrostatica.pdf", {}, "exercises"],
  ["Problem set 4.pdf", {}, "exercises"],
  ["Soluzioni serie 2.pdf", {}, "exercises"],
  ["Tutorato 3.pdf", {}, "exercises"],
  ["Dispense sui limiti.pdf", {}, "handout"],
  ["Formulario di Analisi.pdf", {}, "handout"],
  ["Handout 2 - Fourier.pdf", {}, "handout"],
  ["Manuale di diritto privato.pdf", {}, "book"],
  ["Analisi Matematica 1 - 3a edizione.pdf", {}, "book"],
  ["Fisica 2 (Mazzoldi).pdf", { pages: 712 }, "book"],
  ["Capitolo 4.pdf", { pages: 38 }, "handout"],
  ["Serie di Fourier.pdf", { pages: 12 }, "handout"],
  ["Lezioni di analisi matematica.pdf", { pages: 412 }, "book"],
  ["Lavagna 6 novembre.jpg", {}, "photo"],
  ["Esame luglio, foto.jpg", {}, "photo"],
  ["Programma del corso.pdf", {}, "handout"],
  ["Mario Rossi - Limiti.pdf", {}, "book"],
  ["Analisi Matematica - Limiti e continuità.pdf", {}, "handout"],
  ["01.pdf", { folders: ["Fisica 2", "Esercitazioni"] }, "exercises"],
  ["2023-07-10.pdf", { folders: ["Analisi 1", "Temi d'esame"] }, "exam"],
  ["L03.pdf", { folders: ["Slide del corso"] }, "slides"],
  ["Appunti lezione 4.pdf", { folders: ["Slide"] }, "notes"],
  ["intro.pdf", { folderKinds: ["slides"] }, "slides"],
  ["intro.pdf", { folderKinds: ["slides", "exams"] }, "handout"],
  ["Esercizi misti.pdf", {}, "exercises"],
  ["Raccolta.pdf", { pastPaper: true }, "exam"],
  ["Analisi matematica 1", { kind: "smartbook" }, "book"],
  ["Mie note.txt", {}, "notes"],
  ["Ripasso.txt", {}, "notes"],
  ["it.wikipedia.org.md", { originUrl: "https://it.wikipedia.org/wiki/Limite" }, "handout"],
];

describe("the kind of a file", () => {
  for (const [name, extra, kind] of names)
    it(`${name}${extra.folders ? ` in ${extra.folders.join("/")}` : ""} is ${kind}`, () => {
      expect(classifyFile(file(name, extra)).kind).toBe(kind);
    });

  it("reads at least forty real file names", () => {
    expect(names.length).toBeGreaterThanOrEqual(40);
  });

  it("names the test that decided", () => {
    expect(classifyFile(file("Raccolta.pdf", { pastPaper: true })).by).toBe("past-paper");
    expect(classifyFile(file("01.pdf", { folders: ["Esercitazioni"] })).by).toBe("folder");
    expect(classifyFile(file("Capitolo 4.pdf", { pages: 400 })).by).toBe("length");
    expect(classifyFile(file("Capitolo 4.pdf", { pages: 149 })).by).toBe("fallback");
  });

  it("puts a word in the name before a word in a folder", () => {
    expect(classifyFile(file("Temi 2023.pdf", { folders: ["Esercitazioni"] })).kind).toBe("exam");
  });

  it("takes the nearest folder first", () => {
    expect(classifyFile(file("2023.pdf", { folders: ["Esercitazioni", "Temi d'esame"] })).kind).toBe("exam");
  });

  it("keeps the student's choice over every rule", () => {
    expect(fileKindOf({ ...file("Temi d'esame.pdf"), chosenKind: "notes" })).toBe("notes");
    expect(fileKindOf({ ...file("IMG_2041.jpg"), chosenKind: "exam" })).toBe("exam");
    expect(fileKindOf({ ...file("Temi d'esame.pdf"), chosenKind: null })).toBe("exam");
    // A value the app does not know, from a newer build, falls back to the rule.
    expect(fileKindOf({ ...file("Temi d'esame.pdf"), chosenKind: "poster" })).toBe("exam");
  });
});

describe("a title that names its authors", () => {
  it.each([
    ["Bramanti Pagani Salsa - Analisi matematica 1", true],
    ["Mazzoldi, Nigro, Voci - Fisica 2", true],
    ["Rondolino & Tomasi - Manuale del film", true],
    ["Analisi Matematica - Limiti", false],
    ["Lezione 06 - slide", false],
    ["Fisica 2 - Esercitazione", false],
    ["Esercizi - parte 1", false],
    ["Senza trattino", false],
  ])("%s: %s", (title, expected) => {
    expect(looksLikeAuthors(title)).toBe(expected);
  });
});
