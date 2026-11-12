/**
 * The small drawing on a book's cover, chosen by a fixed rule from its subject's name: the first entry below with a word
 * that starts with one of its stems, with accents and case ignored. A name no stem matches gets its initials. The table a
 * person can read is in docs/file-kinds.md.
 */
import { foldText } from "./fold-text";

/**
 * The symbols, most specific first: "Storia del cinema" is cinema, not history, and "Architettura dei calcolatori" a
 * chip, not a building, because those entries come earlier. A stem written `=word` must be the whole word.
 */
export const SUBJECT_SYMBOLS = [
  { symbol: "clapperboard", stems: ["cinem", "film", "audiovisiv", "regia"] },
  { symbol: "music", stems: ["music", "armonia", "solfeggi"] },
  { symbol: "palette", stems: ["=arte", "=art", "pittur", "scultur"] },
  { symbol: "chip", stems: ["elettronic", "electronic", "digital", "calcolator", "microcontroll", "embedded", "hardware", "semicondutt"] },
  { symbol: "code", stems: ["informatic", "programmazion", "programming", "software", "algoritm", "computer", "database", "=basi", "python", "=java", "coding"] },
  { symbol: "network", stems: ["=reti", "=rete", "network", "telecomunicazion", "internet"] },
  { symbol: "bolt", stems: ["elettrotecnic", "elettric", "electric", "circuit", "energ"] },
  { symbol: "wave", stems: ["elettromagnet", "=onde", "ottica", "acustic", "segnal", "signal", "=waves", "fotonic"] },
  { symbol: "atom", stems: ["fisic", "physic", "quantist", "quantum", "nuclear"] },
  { symbol: "flask", stems: ["chimic", "chemi", "biochim"] },
  { symbol: "dna", stems: ["biolog", "genetic", "botanic", "zoolog", "ecolog", "biotecnolog", "microbiolog"] },
  { symbol: "pulse", stems: ["medicin", "anatomi", "fisiolog", "farmacolog", "patolog", "infermierist", "clinic"] },
  { symbol: "brain", stems: ["psicolog", "psycholog", "neuroscien", "cognitiv", "pedagog"] },
  { symbol: "dice", stems: ["statistic", "probabilit", "stocastic", "probability"] },
  { symbol: "integral", stems: ["analisi", "calcolo", "calculus", "matematic", "mathemat"] },
  { symbol: "matrix", stems: ["algebr", "matric", "matrix"] },
  { symbol: "compass", stems: ["geometri", "geometry", "topolog", "trigonometr"] },
  { symbol: "pencil", stems: ["disegn", "design", "grafic", "rappresentazion", "drawing"] },
  { symbol: "gear", stems: ["meccanic", "mechanic", "macchin", "automazion", "automatic", "controll", "robot", "material", "impiant", "industrial", "ingegneri"] },
  { symbol: "building", stems: ["architett", "architect", "urbanistic", "ediliz", "costruzion"] },
  { symbol: "chart", stems: ["econom", "finanz", "financ", "marketing", "management", "gestion", "aziendal", "contabilit", "business", "impresa"] },
  { symbol: "scales", stems: ["diritt", "giurisprud", "giuridic", "=legge", "=law", "legal", "costituzional"] },
  { symbol: "globe", stems: ["geografi", "geograph", "geopolitic", "internazional", "politic"] },
  { symbol: "column", stems: ["stori", "history", "archeolog", "antichit"] },
  { symbol: "quill", stems: ["letteratur", "literatur", "filolog", "filosofi", "philosoph", "poesia", "=italiano"] },
  { symbol: "speech", stems: ["lingu", "ingles", "english", "frances", "tedesc", "spagnol", "cines", "giappones", "russo", "glottolog", "traduzion", "comunicazion"] },
] as const;

export type SubjectSymbol = (typeof SUBJECT_SYMBOLS)[number]["symbol"];

/** Words the initials skip, in Italian and English. */
const SMALL_WORDS = new Set([
  "e", "ed", "di", "del", "della", "dello", "dei", "degli", "delle", "per", "con", "in", "a", "da", "il", "lo", "la", "i",
  "gli", "le", "un", "una", "and", "of", "the", "for", "to", "an",
]);

/** The words of a name as the stems are matched against them: folded, apostrophes split ("dell'arte" gives "arte"). */
function words(name: string): string[] {
  return foldText(name)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/**
 * Up to three letters for a name no symbol fits: the first letter of each word that is not a small word, a number kept
 * whole ("Laboratorio 2" is "L2"). Empty for an empty name.
 */
export function subjectInitials(name: string): string {
  const parts = name
    .split(/[^\p{L}\p{N}'’]+/u)
    .map((word) => word.replace(/^.*['’]/u, ""))
    .filter((word) => word && !SMALL_WORDS.has(foldText(word)));
  return parts
    .map((word) => (/^\p{N}+$/u.test(word) ? word : word[0]!.toLocaleUpperCase()))
    .join("")
    .slice(0, 3);
}

/** The symbol for a subject's name, or its initials when no stem matches. */
export function subjectSymbol(name: string): { symbol: SubjectSymbol } | { initials: string } {
  const found = words(name);
  for (const entry of SUBJECT_SYMBOLS)
    for (const stem of entry.stems as readonly string[]) {
      const whole = stem.startsWith("=");
      const text = whole ? stem.slice(1) : stem;
      if (found.some((word) => (whole ? word === text : word.startsWith(text)))) return { symbol: entry.symbol };
    }
  return { initials: subjectInitials(name) };
}
