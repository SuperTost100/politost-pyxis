import { z } from "zod";
import { seededRandom, shuffleChoices } from "./choices";
import { figureKind, type FigureKind } from "./figure-kinds";
import { mapOutsideCode } from "./math-delimiters";
import { indentWidth, inListItem } from "./markdown-tree";

/**
 * Smart text: lesson Markdown with interactive blocks written inline by the model as fenced code blocks
 * (```pyxis-check, ```pyxis-try, ```pyxis-reveal, ```pyxis-example, ```pyxis-recap, ```pyxis-figure) whose body is JSON.
 * Core and renderer parse the same way, so a block's id, its correct answer and its place are identical on both sides.
 * A block that cannot be repaired is dropped; raw block JSON never reaches the reader.
 */

const smartBlockKinds = [
  "check",
  "try",
  "reveal",
  "example",
  "recap",
  "figure",
] as const;
export type SmartBlockKind = (typeof smartBlockKinds)[number];

const field = (max: number) => z.string().trim().min(1).max(max);
const optional = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((value) => value || undefined);

const checkSchema = z
  .object({
    question: field(2000),
    options: z.array(field(800)).min(2).max(6),
    answer: z.number().int().min(0),
    explanation: optional(3000),
  })
  .refine((value) => value.answer < value.options.length);
const trySchema = z.object({
  prompt: field(3000),
  hint: optional(1500),
  steps: z.array(field(3000)).min(1).max(12),
  answer: optional(1500),
});
const revealSchema = z.object({
  style: z.enum(["term", "why"]),
  front: field(800),
  back: field(4000),
});
const exampleSchema = z.object({
  title: optional(200),
  body: field(8000),
});

/**
 * A figure is code that core draws once in a sandbox, never anywhere else, and the caption shown under the image. Its
 * kind (`figure-kinds.ts`) says what the code is: matplotlib code for a plot, schemdraw code for a circuit. Images are
 * stored next to the text that asked for them, by `figureKey(code, kind)`; a figure whose code failed is removed from
 * the text before it is saved.
 */
export const FIGURE_CODE_MAX = 4000;
/** Figures drawn for one lesson or answer; later figure blocks are left out. */
export const FIGURE_MAX = 4;
/** Longest stored image, as a PNG data URL. Fits a plan file's 1,000,000-character string limit. */
export const FIGURE_IMAGE_MAX = 700_000;
const figureSchema = z.object({
  caption: field(300),
  code: field(FIGURE_CODE_MAX),
});
/** `figureKind` is the block's `kind`. It has another name here because a smart block's own `kind` is "figure". */
export type FigureData = z.infer<typeof figureSchema> & {
  figureKind: FigureKind;
};
const figureImageSchema = z
  .string()
  .max(FIGURE_IMAGE_MAX)
  .regex(/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/);
const FIGURE_KEY = /^figure-[0-9a-z]{1,16}(?:-dark)?$/;
/** Where the picture drawn for the dark theme is stored: its figure's key with `-dark`. Figures stored before have none. */
export function darkFigureKey(key: string): string {
  return `${key}-dark`;
}
/** The stored images of one lesson or answer, as a plan file must carry them. */
export const figureImagesSchema = z
  .record(z.string().regex(FIGURE_KEY), figureImageSchema)
  .refine((images) => Object.keys(images).length <= FIGURE_MAX * 4, "Too many figures");

export type CheckData = z.infer<typeof checkSchema>;
/**
 * `options` and `answer` are in the order shown, which parsing derives from the model's order and the question's id.
 * `order[i]` is the position shown option `i` had in the model's text.
 */
export type CheckQuestion = CheckData & { id: string; order: number[] };
export type SmartBlock =
  | ({ kind: "check"; id: string } & CheckData & { order: number[] })
  | ({ kind: "try"; id: string } & z.infer<typeof trySchema>)
  | ({ kind: "reveal"; id: string } & z.infer<typeof revealSchema>)
  | ({ kind: "example"; id: string } & z.infer<typeof exampleSchema>)
  | ({ kind: "figure"; id: string } & FigureData)
  | { kind: "recap"; id: string; questions: CheckQuestion[] };

type BlockData = SmartBlock extends infer B
  ? B extends SmartBlock
    ? Omit<B, "id" | "order">
    : never
  : never;

/** The question with its options in a fixed order that only its id decides: the same on every render and reload. */
export function arranged(question: CheckData, id: string): CheckData & { order: number[] } {
  const { options, correct, order } = shuffleChoices(
    question.options,
    question.answer,
    seededRandom(id),
  );
  return { ...question, options, answer: correct, order };
}

export type SmartSegment =
  | { type: "markdown"; text: string }
  | { type: "block"; block: SmartBlock }
  /** A block still being streamed; the reader shows a placeholder. */
  | { type: "pending"; kind: SmartBlockKind | null };

/** A stable short hash, so an answer stays attached to the same block until the block's content changes. */
export function hash(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

// LaTeX commands that start with a valid JSON escape letter. \n is ambiguous with a newline, so only whole names count.
const latexAfterN = new Set([
  "nabla",
  "neq",
  "nu",
  "not",
  "notin",
  "neg",
  "newline",
  "nleq",
  "ngeq",
  "nmid",
  "nexists",
  "nsubseteq",
  "nolimits",
  "nonumber",
]);

/** The name a JSON key stands for, with its escapes decoded; a key that is not valid JSON on its own stays as written. */
function decodedKey(written: string): string {
  try {
    const name: unknown = JSON.parse(`"${written}"`);
    return typeof name === "string" ? name : written;
  } catch {
    return written;
  }
}

/**
 * Makes model JSON parseable without changing what it meant: a single backslash before a LaTeX command is doubled
 * (JSON would read \frac as a form feed and \alpha as an error), and raw line breaks inside strings become \n.
 */
function repairJsonText(text: string, verbatim: readonly string[] = []): string {
  let out = "";
  let inString = false;
  // The key whose value is being read, and where in `out` the string being read starts, to tell a key from a value when it ends.
  let key = "";
  let valueOf: string | null = null;
  let stringAt = 0;
  let valueString = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (!inString) {
      if (char === '"') {
        inString = true;
        valueString = valueOf !== null;
        stringAt = out.length + 1;
      } else if (char === ":") valueOf = key;
      else if (char === "," || char === "{" || char === "}") valueOf = null;
      out += char;
      continue;
    }
    if (char === '"') {
      inString = false;
      // A key is compared as JSON will read the repaired text: "c\u006fde" is `code`, and a `\nabla` the repair writes as a LaTeX
      // command is `\nabla`. The text keeps the spelling it was written with.
      if (!valueString) key = decodedKey(out.slice(stringAt));
      out += char;
      continue;
    }
    // A value under a verbatim key is code: a valid escape in it is the character it says, never a LaTeX command.
    const code = valueString && valueOf !== null && verbatim.includes(valueOf);
    if (code && char === "\\" && "nrtbf".includes(text[i + 1] ?? "\n")) {
      out += char + text[i + 1];
      i++;
      continue;
    }
    if (char === "\n") {
      out += "\\n";
      continue;
    }
    if (char === "\r") continue;
    if (char === "\t") {
      out += "\\t";
      continue;
    }
    if (char !== "\\") {
      out += char;
      continue;
    }
    const next = text[i + 1] ?? "";
    const word = /^[A-Za-z]*/.exec(text.slice(i + 1))![0];
    if (next === "\\" || next === '"' || next === "/") {
      out += char + next;
      i++;
    } else if (next === "u" && /^[0-9a-fA-F]{4}/.test(text.slice(i + 2))) {
      out += char;
    } else if (next === "n") {
      out += latexAfterN.has(word) ? "\\\\" : "\\";
    } else if ("bfrt".includes(next) && next !== "" && word.length > 1) {
      out += "\\\\";
    } else if ("bfrt".includes(next) && next !== "") {
      out += "\\";
    } else {
      out += "\\\\";
    }
  }
  return out;
}

/**
 * The JSON value a model's text holds, or undefined. The strings under the top-level keys named in `verbatim` are read
 * as JSON says, since they are code and not prose: a tab before `plt` stays a tab and is not repaired into a LaTeX `\tplt`.
 */
export function parseLooseJson(body: string, verbatim: readonly string[] = []): unknown {
  const trimmed = body.trim();
  const start = trimmed.search(/[[{]/);
  const end = Math.max(trimmed.lastIndexOf("}"), trimmed.lastIndexOf("]"));
  const candidates = [trimmed];
  if (start >= 0 && end > start) candidates.push(trimmed.slice(start, end + 1));
  for (const candidate of candidates) {
    const repaired = repairJsonText(candidate, verbatim);
    for (const text of [repaired, repaired.replace(/,\s*([}\]])/g, "$1")]) {
      try {
        return JSON.parse(text);
      } catch {
        // Try the next repair.
      }
    }
  }
  return undefined;
}

type Loose = Record<string, unknown>;
const record = (value: unknown): Loose | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Loose)
    : null;
const pick = (value: Loose, ...keys: string[]) =>
  keys.map((key) => value[key]).find((item) => item != null);
const asText = (value: unknown) =>
  typeof value === "string"
    ? value
    : typeof value === "number"
      ? String(value)
      : undefined;
const asSteps = (value: unknown): string[] | undefined =>
  Array.isArray(value)
    ? value.map(asText).filter((item): item is string => Boolean(item?.trim()))
    : typeof value === "string" && value.trim()
      ? [value]
      : undefined;

function repairCheck(raw: unknown): CheckData | null {
  const value = record(raw);
  if (!value) return null;
  let options = asSteps(pick(value, "options", "choices"));
  // "A) text" or "B. text" on every option: the letter is the reader's, not the model's.
  if (options?.every((option) => /^[A-Fa-f][).:]\s+/.test(option)))
    options = options.map((option) => option.replace(/^[A-Fa-f][).:]\s+/, ""));
  let answer = pick(value, "answer", "correct", "correctIndex");
  if (typeof answer === "string" && options) {
    const text = answer.trim();
    const letter = /^[A-Fa-f]$/.test(text)
      ? text.toUpperCase().charCodeAt(0) - 65
      : -1;
    const exact = options.findIndex((option) => option.trim() === text);
    answer = exact >= 0 ? exact : letter >= 0 ? letter : /^\d+$/.test(text) ? Number(text) : answer;
  }
  const parsed = checkSchema.safeParse({
    question: asText(pick(value, "question", "stem", "prompt")),
    options,
    answer,
    explanation: asText(pick(value, "explanation", "why", "feedback")),
  });
  return parsed.success ? parsed.data : null;
}

/** A JSON value with the keys of every object in order, so one spec has one text however its keys were written. */
function sortedKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedKeys);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => [key, sortedKeys(item)]),
  );
}

/** A figure's code as text. Code written as a JSON object is kept as compact JSON with sorted keys. */
function asCode(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return asText(value);
  try {
    return JSON.stringify(sortedKeys(value));
  } catch {
    // An object nested too deep to walk is not a figure.
    return undefined;
  }
}

/** The keys a figure's code can be written under. */
const FIGURE_CODE_KEYS = ["code", "python", "source"];

function repairFigure(raw: unknown): FigureData | null {
  const value = record(raw);
  if (!value) return null;
  const kind = figureKind(value.kind);
  if (!kind) return null;
  const parsed = figureSchema.safeParse({
    caption: asText(pick(value, "caption", "title", "alt")),
    code: asCode(pick(value, "code", "python", "source")),
  });
  return parsed.success ? { ...parsed.data, figureKind: kind } : null;
}

/** The figure in a ```pyxis-figure body, or null when it is not one. */
export function parseFigure(body: string): FigureData | null {
  return repairFigure(parseLooseJson(body, FIGURE_CODE_KEYS));
}

/**
 * Where a figure's image is stored: the same kind and code always map to the same key, whatever the caption. A plot's
 * key is the hash of its code alone, as it was before figures had kinds, so the images stored then are still found.
 */
export function figureKey(code: string, kind: FigureKind = "plot"): string {
  const text = code.trim();
  return `figure-${hash(kind === "plot" ? text : `${kind}\n${text}`)}`;
}

/** Stored images that are well-formed PNG data URLs under known keys; anything else is dropped, not shown. */
export function figureImages(value: unknown): Record<string, string> {
  const images: Record<string, string> = {};
  const entries = record(value) ? Object.entries(value as Loose) : [];
  for (const [key, image] of entries) {
    if (Object.keys(images).length === FIGURE_MAX * 4) break;
    if (FIGURE_KEY.test(key) && figureImageSchema.safeParse(image).success)
      images[key] = image as string;
  }
  return images;
}

/** A fence of any indentation: a list item's blocks are indented by its marker's width, or by a tab. */
const INDENTED_OPEN = /^([ \t]*)(`{3,}|~{3,})\s*([^\s`]*)\s*$/;

/** `line` without up to `columns` columns of its leading spaces and tabs, a tab reaching the next multiple of four. */
function outdent(line: string, columns: number): string {
  let at = 0;
  let column = 0;
  while (at < line.length && column < columns && (line[at] === " " || line[at] === "\t")) {
    column = line[at] === "\t" ? column + 4 - (column % 4) : column + 1;
    at++;
  }
  return " ".repeat(Math.max(0, column - columns)) + line.slice(at);
}

/**
 * Rewrites every closed ```pyxis-figure block outside other code: `replace` gets the parsed figure (null when the block
 * is not valid) and returns the text to put in its place, or null to keep the block. A block in a list item counts as
 * one at the top level, and it, or the text put in its place, is written three columns in: there it stays in the item,
 * where two columns may end the item and four make it indented code. Outside a list, four columns are indented code.
 */
export function mapFigureBlocks(
  markdown: string,
  replace: (figure: FigureData | null) => string | null,
): string {
  return mapFencedBlocks(markdown, ["pyxis-figure"], (_, body) => replace(parseFigure(body)));
}

/**
 * `mapFigureBlocks` for any of the fence languages in `languages` (lower case): `replace` gets the language and the
 * block's body, outdented, and returns the text to put in its place, or null to keep the block.
 */
export function mapFencedBlocks(
  markdown: string,
  languages: readonly string[],
  replace: (language: string, body: string) => string | null,
): string {
  const text = markdown.replace(/\r\n?/g, "\n");
  const lines = text.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const open = INDENTED_OPEN.exec(lines[i]!);
    if (!open) {
      out.push(lines[i]!);
      continue;
    }
    const fence = open[2]!;
    let close = i + 1;
    while (close < lines.length) {
      const line = lines[close]!.trim();
      // Only the opener's own character closes it: `~~~` and a backtick is a line of the block.
      if (line.length >= fence.length && line === fence[0]!.repeat(line.length)) break;
      close++;
    }
    let block = lines.slice(i, Math.min(close, lines.length - 1) + 1);
    const width = indentWidth(open[1]!);
    // Indented by four columns outside a list, a block is indented code: an example, not a figure. An indented block after a
    // list item's text belongs to that item, even when two columns would end the item.
    let above = i - 1;
    while (above >= 0 && !lines[above]!.trim()) above--;
    const listed = width > 0 && above >= 0 && inListItem(text, lines.slice(0, above).join("\n").length + (above > 0 ? 1 : 0));
    const language = open[3]!.toLowerCase();
    const figure = close < lines.length && languages.includes(language) && (width < 4 || listed);
    const next = figure
      ? replace(language, block.slice(1, -1).map((line) => outdent(line, width)).join("\n"))
      : null;
    // A block in a list item is three columns in, where it reads as a figure block in that item.
    if (figure && listed && width > 3) block = block.map((line) => outdent(line, width - 3));
    if (figure && listed && width < 3) block = block.map((line) => (line.trim() ? " ".repeat(3 - width) + line : line));
    const lead = listed ? "   " : "";
    out.push(...(next == null ? block : next ? next.split("\n").map((line) => (line ? lead + line : line)) : []));
    i = close;
    // A removed block between two paragraphs leaves one blank line, not two.
    if (next === "" && out.at(-1)?.trim() === "" && lines[i + 1]?.trim() === "") i++;
  }
  return out.join("\n");
}

function repairBlock(
  kind: SmartBlockKind,
  body: string,
): BlockData | null {
  const raw = parseLooseJson(body, kind === "figure" ? FIGURE_CODE_KEYS : []);
  const value = record(raw);
  if (kind === "check") {
    const data = repairCheck(raw);
    return data ? { kind, ...data } : null;
  }
  if (kind === "recap") {
    const list = Array.isArray(raw)
      ? raw
      : Array.isArray(value?.questions)
        ? value.questions
        : Array.isArray(value?.checks)
          ? value.checks
          : [];
    const questions = (list as unknown[])
      .map(repairCheck)
      .filter((item): item is CheckData => item != null)
      .slice(0, 5);
    return questions.length
      ? { kind, questions: questions as CheckQuestion[] }
      : null;
  }
  if (kind === "try") {
    if (!value) return null;
    const parsed = trySchema.safeParse({
      prompt: asText(pick(value, "prompt", "exercise", "question", "task")),
      hint: asText(pick(value, "hint")),
      steps: asSteps(pick(value, "steps", "solution")),
      answer: asText(pick(value, "answer", "result")),
    });
    return parsed.success ? { kind, ...parsed.data } : null;
  }
  if (kind === "figure") {
    const data = repairFigure(raw);
    return data ? { kind, ...data } : null;
  }
  if (kind === "reveal") {
    if (!value) return null;
    const style = pick(value, "style", "type") === "why" || value.why != null ? "why" : "term";
    const parsed = revealSchema.safeParse({
      style,
      front: asText(pick(value, "front", "term", "question", "why", "title")),
      back: asText(pick(value, "back", "definition", "answer", "body", "explanation")),
    });
    return parsed.success ? { kind, ...parsed.data } : null;
  }
  // A worked example written as plain Markdown is still a worked example.
  if (!value) {
    const parsed = exampleSchema.safeParse({ body: raw === undefined ? body : undefined });
    return parsed.success && !/^\s*[[{]/.test(body) ? { kind, ...parsed.data } : null;
  }
  const steps = asSteps(pick(value, "steps"));
  const problem = asText(pick(value, "problem", "question"));
  const solution = asText(pick(value, "solution", "result"));
  const parsed = exampleSchema.safeParse({
    title: asText(pick(value, "title")),
    body:
      asText(pick(value, "body", "text")) ??
      [problem, ...(steps ?? []).map((step, index) => `${index + 1}. ${step}`), solution]
        .filter(Boolean)
        .join("\n\n"),
  });
  return parsed.success ? { kind, ...parsed.data } : null;
}

const OPEN = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)\s*$/;

/**
 * Splits smart text into prose and blocks. `streaming` turns an unfinished last block into a placeholder.
 * A block's id comes from the model's own text, so a closed block has the same id, order and answer in a streamed
 * prefix as in the saved lesson.
 */
export function parseSmartText(
  markdown: string,
  options: { streaming?: boolean } = {},
): SmartSegment[] {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const segments: SmartSegment[] = [];
  const seen = new Map<string, number>();
  let prose: string[] = [];
  const flush = () => {
    const text = prose.join("\n").trim();
    if (text) segments.push({ type: "markdown", text });
    prose = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const open = OPEN.exec(lines[i]!);
    if (!open) {
      prose.push(lines[i]!);
      continue;
    }
    const fence = open[1]!;
    const info = open[2]!.toLowerCase();
    let close = i + 1;
    while (close < lines.length) {
      const line = lines[close]!.trim();
      if (/^[`~]+$/.test(line) && line[0] === fence[0] && line.length >= fence.length) break;
      close++;
    }
    const closed = close < lines.length;
    const body = lines.slice(i + 1, close).join("\n");
    const from = i;
    i = closed ? close : lines.length;
    if (!info.startsWith("pyxis-")) {
      // Ordinary code stays Markdown, fences included, so a pyxis fence quoted inside it is never a block.
      prose.push(...lines.slice(from, i + 1));
      continue;
    }
    flush();
    const name = info.slice("pyxis-".length);
    const kind = (smartBlockKinds as readonly string[]).includes(name)
      ? (name as SmartBlockKind)
      : null;
    if (!closed && options.streaming) {
      segments.push({ type: "pending", kind });
      continue;
    }
    const repaired = kind ? repairBlock(kind, body) : null;
    if (!repaired) continue;
    const base = `${kind}-${hash(JSON.stringify(repaired))}`;
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    const id = count > 1 ? `${base}-${count}` : base;
    segments.push({
      type: "block",
      block:
        repaired.kind === "recap"
          ? {
              ...repaired,
              id,
              questions: repaired.questions.map((question, index) => ({
                ...arranged(question, `${id}.${index + 1}`),
                id: `${id}.${index + 1}`,
              })),
            }
          : repaired.kind === "check"
            ? { ...repaired, ...arranged(repaired, id), id }
            : ({ ...repaired, id } as SmartBlock),
    });
  }
  flush();
  return segments;
}

/** Every question the student can answer: quick checks and each recap question, by id. */
export function smartQuestions(
  segments: SmartSegment[],
): Map<string, CheckQuestion & { recapId?: string }> {
  const questions = new Map<string, CheckQuestion & { recapId?: string }>();
  for (const segment of segments) {
    if (segment.type !== "block") continue;
    const { block } = segment;
    if (block.kind === "check") questions.set(block.id, block);
    if (block.kind === "recap")
      for (const question of block.questions)
        questions.set(question.id, { ...question, recapId: block.id });
  }
  return questions;
}

/** The closing recap: the last recap block, whose answers finish the lesson. */
export function finalRecap(segments: SmartSegment[]) {
  const recaps = segments.flatMap((segment) =>
    segment.type === "block" && segment.block.kind === "recap"
      ? [segment.block]
      : [],
  );
  return recaps.at(-1) ?? null;
}

/**
 * The questions whose answers finish a part of a lesson in parts: the last quick check of a teaching part, and the
 * closing recap's questions of the recap part. Empty for a part written without one, which "Fatto" finishes instead.
 */
export function partQuestions(segments: SmartSegment[], kind: "part" | "recap"): string[] {
  if (kind === "recap") return finalRecap(segments)?.questions.map((question) => question.id) ?? [];
  const checks = segments.flatMap((segment) =>
    segment.type === "block" && segment.block.kind === "check" ? [segment.block.id] : [],
  );
  return checks.slice(-1);
}

const uuidRef =
  /\s?\[(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\s*[,;]\s*[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})*\]/gi;

/** Removes passage references ([P3], raw passage ids) that an older introduction carried as plain text. */
/** Rewrites a grouped citation such as [P1, P3] or [P1; 3] as [P1][P3], the form the chat links. */
export function splitCitationGroups(markdown: string): string {
  return markdown.replace(/\[P\d+(?:\s*[,;]\s*P?\d+)+\]/g, (group) =>
    [...group.matchAll(/\d+/g)].map((match) => `[P${match[0]}]`).join(""),
  );
}

export function stripPassageRefs(markdown: string): string {
  return markdown
    .replace(uuidRef, "")
    .replace(/\s?\[P\d+(?:\s*[,;]\s*P?\d+)*\]/g, "")
    .replace(/[ \t]+([.,;:!?])/g, "$1");
}

/**
 * The same for a chat reply, where code is code: `list[P1]`, `x : int` and the indent of a chained call stay as written.
 * Lessons and introductions keep stripPassageRefs, since their pyxis-* blocks are JSON that carries markers too.
 */
export function stripPassageRefsOutsideCode(markdown: string): string {
  return mapOutsideCode(markdown, stripPassageRefs);
}

export type SmartSection = { title: string; start: number; end: number };

/** The lesson's ## sections, by line range, outside code. Text before the first ## heading belongs to no section. */
export function smartSections(markdown: string): SmartSection[] {
  const lines = markdown.split("\n");
  const sections: SmartSection[] = [];
  let fence: string | null = null;
  lines.forEach((line, index) => {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (line.trim()[0] === fence[0] && line.trim().length >= fence.length && /^[`~]+$/.test(line.trim()))
        fence = null;
      return;
    }
    if (fence) return;
    const heading = /^##\s+(.+?)\s*#*\s*$/.exec(line);
    if (!heading) return;
    const last = sections.at(-1);
    if (last) last.end = index;
    sections.push({ title: heading[1]!, start: index, end: lines.length });
  });
  return sections;
}

/**
 * A lesson still being written, split for reading: `done` is every section the model has moved past (its next ##
 * heading has appeared), so it reads the same as in the saved lesson. `writing` is the section in progress, with its
 * 1-based number and title, or null before the first heading. Text before the first heading belongs to the first
 * section. Block fences are ignored in headings, as in `smartSections`.
 */
export function writtenSections(markdown: string): {
  done: string;
  writing: { number: number; title: string } | null;
} {
  const sections = smartSections(markdown);
  const last = sections.at(-1);
  if (!last) return { done: "", writing: null };
  const lines = markdown.split("\n");
  return {
    done: sections.length > 1 ? lines.slice(0, last.start).join("\n").trimEnd() : "",
    writing: { number: sections.length, title: last.title },
  };
}

export function replaceSection(
  markdown: string,
  index: number,
  replacement: string,
): string {
  const section = smartSections(markdown)[index];
  if (!section) throw new Error("section-missing");
  const lines = markdown.split("\n");
  const after = lines.slice(section.end).join("\n");
  return [
    ...lines.slice(0, section.start),
    replacement.trim(),
    ...(after.trim() ? ["", after.replace(/^\n+/, "")] : []),
  ].join("\n");
}

export type SmartLabels = {
  check: string;
  try: string;
  hint: string;
  solution: string;
  answer: string;
  example: string;
  recap: string;
  figure: string;
};

export const smartLabels: Record<"it" | "en", SmartLabels> = {
  it: {
    check: "Verifica rapida",
    try: "Prova tu",
    hint: "Suggerimento",
    solution: "Soluzione",
    answer: "Risposta",
    example: "Esempio svolto",
    recap: "Ripasso finale",
    figure: "Figura",
  },
  en: {
    check: "Quick check",
    try: "Try it",
    hint: "Hint",
    solution: "Solution",
    answer: "Answer",
    example: "Worked example",
    recap: "Recap",
    figure: "Figure",
  },
};

function checkMarkdown(question: CheckData, labels: SmartLabels, heading: string) {
  const letter = (index: number) => String.fromCharCode(65 + index);
  return [
    `${heading} ${question.question}`,
    question.options.map((option, index) => `${letter(index)}. ${option}`).join("\n"),
    `> ${labels.answer}: ${letter(question.answer)}. ${question.options[question.answer]}${question.explanation ? `\n>\n> ${question.explanation.replace(/\n/g, "\n> ")}` : ""}`,
  ].join("\n\n");
}

/** Plain Markdown for export and previews: every block written out with its answer. */
export function smartTextToMarkdown(
  markdown: string,
  labels: SmartLabels = smartLabels.en,
): string {
  return parseSmartText(markdown)
    .map((segment) => {
      if (segment.type === "markdown") return segment.text;
      if (segment.type === "pending") return "";
      const block = segment.block;
      switch (block.kind) {
        case "check":
          return checkMarkdown(block, labels, `**${labels.check}.**`);
        case "try":
          return [
            `**${labels.try}.** ${block.prompt}`,
            block.hint ? `*${labels.hint}:* ${block.hint}` : "",
            `*${labels.solution}:*\n\n${block.steps.map((step, index) => `${index + 1}. ${step.replace(/\n/g, "\n   ")}`).join("\n")}`,
            block.answer ? `*${labels.answer}:* ${block.answer}` : "",
          ]
            .filter(Boolean)
            .join("\n\n");
        case "reveal":
          return `**${block.front}**\n\n${block.back}`;
        case "example":
          return `**${block.title ? `${labels.example}: ${block.title}` : labels.example}**\n\n${block.body}`;
        // Exports carry the caption; the image stays in the app.
        case "figure":
          return `*${labels.figure}: ${block.caption}*`;
        case "recap":
          return [
            `### ${labels.recap}`,
            ...block.questions.map((question, index) =>
              checkMarkdown(question, labels, `**${index + 1}.**`),
            ),
          ].join("\n\n");
      }
    })
    .filter(Boolean)
    .join("\n\n");
}
