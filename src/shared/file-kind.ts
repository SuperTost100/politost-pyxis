/**
 * The kind of a file in the Library (a book, slides, an exam paper...), found by fixed rules from what Pyxis stores about
 * it: its file type, the words in its name and in its folders' names, and what an exam or a linked folder says about it.
 * No model is asked. Core and the window both read it from here, so the shelf and the list agree. The table a person can
 * read is in docs/file-kinds.md; a change here changes that page and its tests.
 */
import { foldText } from "./fold-text";
import type { MaterialKind } from "./linked-folders";

/** The seven kinds, in the order the "Tipo" menu lists them. */
export const FILE_KINDS = ["book", "slides", "exam", "notes", "exercises", "photo", "handout"] as const;
export type FileKind = (typeof FILE_KINDS)[number];

export const isFileKind = (value: unknown): value is FileKind =>
  typeof value === "string" && (FILE_KINDS as readonly string[]).includes(value);

/** What the rule reads. Everything but `kind` and `title` may be left out when it is not known. */
export type FileKindInput = {
  /** `sources.kind`: pdf, docx, pptx, text, image, smartbook, excerpt. */
  kind: string;
  /** The file's title, its name without the extension. */
  title: string;
  /** An exam uses the file as a past exam paper. */
  pastPaper?: boolean;
  /** The address a source saved from a link came from. */
  originUrl?: string | null;
  /** The folders between a linked folder and the file, outermost first; empty for a file at the top or not linked. */
  folders?: readonly string[];
  /** The kinds of material setup found in the file's linked subfolder (`linked_subfolders.kinds_json`). */
  folderKinds?: readonly MaterialKind[];
  /** The number of the last page the read found, when it found pages. */
  pages?: number | null;
};

/** Which test decided the kind, for the docs, the tests and the details panel. */
export type FileKindReason = "chosen" | "type" | "past-paper" | "name" | "folder" | "folder-kinds" | "length" | "authors" | "fallback";

/**
 * A document this long with no word that names its kind is a book. Lecture notes, handouts and exercise sheets run
 * from a few pages to about a hundred; a textbook runs from about 250 to 900. 150 sits between the two.
 */
export const BOOK_PAGES = 150;

type WordRule = { kind: FileKind; words: RegExp };

/**
 * Words that name a kind on their own. Text is folded first (lower case, no accents, every run of anything but letters
 * and digits one space, letters and digits apart), so `\b` here is a space. The leftmost match in a name wins, since an
 * Italian name starts with what the file is ("Esercizi d'esame" are exercises, "Temi d'esame con esercizi" exam papers).
 */
const STRONG: WordRule[] = [
  { kind: "exam", words: /\b(tema|temi|esame|esami|appello|appelli|prova|prove|compito|compiti|compitino|compitini|scritto|scritti|itinere|exam|exams|midterm|midterms|past papers?)\b/ },
  { kind: "slides", words: /\b(slide|slides|lucidi|trasparenze|presentazione|presentazioni|presentation|presentations)\b/ },
  { kind: "notes", words: /\b(appunti|appunto|note|notes|riassunto|riassunti|sunto|sunti|sintesi|summary|summaries|schemi|quaderno|notebook)\b/ },
  { kind: "exercises", words: /\b(esercizi|esercizio|esercitazione|esercitazioni|eserciziario|problemi|exercises?|problems?|problem sets?|homework|worksheets?)\b/ },
  { kind: "handout", words: /\b(dispensa|dispense|handouts?|formulario|formulari|cheat sheet|formula sheet)\b/ },
  { kind: "book", words: /\b(libro|libri|manuale|textbook|book|ebook|volume|edizione|edition)\b/ },
];

/**
 * Words that hint at a kind but are weaker than any word above: "Lezione 6" is usually the slides of a lecture, while
 * "Appunti lezione 6" are notes. A lecture counts only with a number after it, since "Lezioni di analisi" is a book title.
 */
const WEAK: WordRule[] = [
  { kind: "slides", words: /\b(lezione|lezioni|lecture|lectures|lez|lect) \d/ },
  { kind: "exercises", words: /\b(soluzione|soluzioni|solution|solutions|tutorato|tutoraggio)\b|\b(serie|foglio) \d/ },
];

/** What setup calls a folder's material, as a file kind. */
const FROM_MATERIAL: Record<MaterialKind, FileKind> = {
  book: "book",
  slides: "slides",
  exams: "exam",
  notes: "notes",
  exercises: "exercises",
  handouts: "handout",
};

/** A name as the word rules read it: folded, letters and digits split apart, every other character one space. */
export function wordsOf(text: string): string {
  return foldText(text)
    .replace(/(\p{L})(\p{N})/gu, "$1 $2")
    .replace(/(\p{N})(\p{L})/gu, "$1 $2")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** The kind the leftmost matching word names, or null. */
function leftmost(text: string, rules: WordRule[]): FileKind | null {
  let best: { at: number; kind: FileKind } | null = null;
  for (const rule of rules) {
    const at = text.search(rule.words);
    if (at >= 0 && (!best || at < best.at)) best = { at, kind: rule.kind };
  }
  return best?.kind ?? null;
}

/** The kind the nearest folder names, from the file's own folder outwards, or null. */
function nearestFolder(folders: readonly string[], rules: WordRule[]): FileKind | null {
  for (let at = folders.length - 1; at >= 0; at -= 1) {
    const kind = leftmost(wordsOf(folders[at]!), rules);
    if (kind) return kind;
  }
  return null;
}

/**
 * Words that name a subject rather than a person, so "Analisi matematica - Limiti" is not read as an author and a title.
 * The stems of the subject symbols, plus the kind words.
 */
const NOT_A_NAME = /^(analisi|matemat|fisic|chimic|algebr|geometr|informat|programm|elettr|econom|diritt|statist|probab|biolog|stori|cinem|architett|disegn|lingu|ingles|tecnolog|digital|meccanic|calcol|fondament|introduz|corso|lezion|capitol|parte|modulo|unita)/;

/**
 * Whether a title reads "Authors - Title", as a downloaded book is often named ("Bramanti Pagani Salsa - Analisi
 * matematica 1"): one to four capitalised words of letters before a dash, none of them a subject or a kind word.
 */
export function looksLikeAuthors(title: string): boolean {
  const match = /^\s*([^-–—]+?)\s+[-–—]\s+\S/u.exec(title);
  if (!match) return false;
  const names = match[1]!.split(/[\s,&]+/u).filter((word) => word && !/^(e|and|et|al\.?)$/iu.test(word));
  if (names.length < 1 || names.length > 4) return false;
  return names.every(
    (word) => /^\p{Lu}[\p{L}'’.]+$/u.test(word) && !NOT_A_NAME.test(foldText(word)) && !leftmost(wordsOf(word), STRONG),
  );
}

/**
 * The kind of a file and the test that decided it, from what the rule reads. The tests run in this order and the first
 * that answers wins; the student's own choice, stored apart, comes before all of them (`fileKindOf`).
 */
export function classifyFile(input: FileKindInput): { kind: FileKind; by: FileKindReason } {
  if (input.kind === "smartbook") return { kind: "book", by: "type" };
  if (input.pastPaper) return { kind: "exam", by: "past-paper" };
  if (input.kind === "image") return { kind: "photo", by: "type" };
  if (input.kind === "pptx") return { kind: "slides", by: "type" };
  const name = wordsOf(input.title);
  const folders = input.folders ?? [];
  const strong = leftmost(name, STRONG);
  if (strong) return { kind: strong, by: "name" };
  const folderStrong = nearestFolder(folders, STRONG);
  if (folderStrong) return { kind: folderStrong, by: "folder" };
  const weak = leftmost(name, WEAK);
  if (weak) return { kind: weak, by: "name" };
  const folderWeak = nearestFolder(folders, WEAK);
  if (folderWeak) return { kind: folderWeak, by: "folder" };
  // A subfolder setup found to hold one kind of material only.
  if (input.folderKinds?.length === 1) return { kind: FROM_MATERIAL[input.folderKinds[0]!], by: "folder-kinds" };
  // Text the student wrote or pasted is their notes; a page saved from a link is not.
  if ((input.kind === "text" || input.kind === "excerpt") && !input.originUrl) return { kind: "notes", by: "type" };
  if ((input.kind === "pdf" || input.kind === "docx") && (input.pages ?? 0) >= BOOK_PAGES) return { kind: "book", by: "length" };
  if ((input.kind === "pdf" || input.kind === "docx") && looksLikeAuthors(input.title)) return { kind: "book", by: "authors" };
  return { kind: "handout", by: "fallback" };
}

/** The kind the Library shows: the student's choice when there is one, else the rule's. */
export function fileKindOf(input: FileKindInput & { chosenKind?: string | null }): FileKind {
  return isFileKind(input.chosenKind) ? input.chosenKind : classifyFile(input).kind;
}
