import { describe, expect, it } from "vitest";
import { booksNamed, sameName } from "./book-match";

const books = [
  { id: "fisica-1", title: "Fisica 1", subject: "Fisica 1" },
  { id: "analisi-1", title: "Analisi Matematica 1", subject: "Analisi 1" },
  { id: "analisi-2", title: "Analisi Matematica 2", subject: "Analisi Matematica" },
  { id: "chimica", title: "Chimica di base", subject: "Chimica" },
  { id: "senza", title: "Libro", subject: "" },
];
const ids = (names: string[]) => booksNamed(names, books).map((book) => book.id);

describe("booksNamed", () => {
  it("matches a name that is a book's subject or title, whatever the case, accents or punctuation", () => {
    expect(ids(["fisica 1"])).toEqual(["fisica-1"]);
    expect(ids(["ANALISI  matematica 1"])).toEqual(["analisi-1"]);
    expect(ids(["Chimica"])).toEqual(["chimica"]);
    expect(ids(["Chîmica!"])).toEqual(["chimica"]);
  });

  it("reads a Roman number as its digit, on either side", () => {
    expect(ids(["Fisica I"])).toEqual(["fisica-1"]);
    expect(ids(["Analisi Matematica II"])).toEqual(["analisi-2"]);
    expect(ids(["Analisi I"])).toEqual(["analisi-1"]);
  });

  it("matches nothing that is only close, so a wrong guess is rare", () => {
    expect(ids(["Fisica"])).toEqual([]);
    expect(ids(["Fisica 2"])).toEqual([]);
    expect(ids(["Chimica generale"])).toEqual([]);
  });

  it("matches nothing for an empty name, and never a book without a subject by it", () => {
    expect(ids([""])).toEqual([]);
    expect(ids(["  ", ""])).toEqual([]);
    expect(ids([])).toEqual([]);
  });

  it("takes the names of an exam, its subject and its title, together", () => {
    expect(ids(["Esame di fisica", "Fisica 1"])).toEqual(["fisica-1"]);
  });
});

describe("sameName", () => {
  it("compares names by the same rule, and never calls two empty names the same", () => {
    expect(sameName("Fisica I", "fisica 1")).toBe(true);
    expect(sameName("Fisica 1", "Fisica 2")).toBe(false);
    expect(sameName("", "")).toBe(false);
    expect(sameName("!", " ")).toBe(false);
  });
});
