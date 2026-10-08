import { z } from "zod";

/**
 * Smart text: lesson Markdown with interactive blocks written inline by the model as fenced code blocks
 * (```pyxis-check, ```pyxis-try, ```pyxis-reveal, ```pyxis-example, ```pyxis-recap) whose body is JSON.
 * Core and renderer parse the same way, so a block's id, its correct answer and its place are identical on both sides.
 * A block that cannot be repaired is dropped; raw block JSON never reaches the reader.
 */

export const smartBlockKinds = [
  "check",
  "try",
  "reveal",
  "example",
  "recap",
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

export type CheckData = z.infer<typeof checkSchema>;
export type CheckQuestion = CheckData & { id: string };
export type SmartBlock =
  | ({ kind: "check"; id: string } & CheckData)
  | ({ kind: "try"; id: string } & z.infer<typeof trySchema>)
  | ({ kind: "reveal"; id: string } & z.infer<typeof revealSchema>)
  | ({ kind: "example"; id: string } & z.infer<typeof exampleSchema>)
  | { kind: "recap"; id: string; questions: CheckQuestion[] };

type BlockData = SmartBlock extends infer B
  ? B extends SmartBlock
    ? Omit<B, "id">
    : never
  : never;

export type SmartSegment =
  | { type: "markdown"; text: string }
  | { type: "block"; block: SmartBlock }
  /** A block still being streamed; the reader shows a placeholder. */
  | { type: "pending"; kind: SmartBlockKind | null };

/** A stable short hash, so an answer stays attached to the same block until the block's content changes. */
function hash(text: string): string {
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

/**
 * Makes model JSON parseable without changing what it meant: a single backslash before a LaTeX command is doubled
 * (JSON would read \frac as a form feed and \alpha as an error), and raw line breaks inside strings become \n.
 */
export function repairJsonText(text: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (!inString) {
      if (char === '"') inString = true;
      out += char;
      continue;
    }
    if (char === '"') {
      inString = false;
      out += char;
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

export function parseLooseJson(body: string): unknown {
  const trimmed = body.trim();
  const start = trimmed.search(/[[{]/);
  const end = Math.max(trimmed.lastIndexOf("}"), trimmed.lastIndexOf("]"));
  const candidates = [trimmed];
  if (start >= 0 && end > start) candidates.push(trimmed.slice(start, end + 1));
  for (const candidate of candidates) {
    const repaired = repairJsonText(candidate);
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

function repairBlock(
  kind: SmartBlockKind,
  body: string,
): BlockData | null {
  const raw = parseLooseJson(body);
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

/** Splits smart text into prose and blocks. `streaming` turns an unfinished last block into a placeholder. */
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
                ...question,
                id: `${id}.${index + 1}`,
              })),
            }
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

const uuidRef =
  /\s?\[(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\s*[,;]\s*[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})*\]/gi;

/** Removes passage references ([P3], raw passage ids) that an older introduction carried as plain text. */
export function stripPassageRefs(markdown: string): string {
  return markdown
    .replace(uuidRef, "")
    .replace(/\s?\[P\d+(?:\s*[,;]\s*P?\d+)*\]/g, "")
    .replace(/[ \t]+([.,;:!?])/g, "$1");
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
  },
  en: {
    check: "Quick check",
    try: "Try it",
    hint: "Hint",
    solution: "Solution",
    answer: "Answer",
    example: "Worked example",
    recap: "Recap",
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
