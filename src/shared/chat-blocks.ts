import { z } from "zod";
import { arranged, hash, mapFencedBlocks, parseLooseJson } from "./smart-text";

/**
 * Two blocks a chat answer can hold, written by the model as fenced code blocks whose body is JSON:
 * - ```pyxis-chart: a bar or line chart of numbers the answer states or a Pyxis tool returned, which the renderer draws.
 * - ```pyxis-question: a practice question with options, answered in the chat. It counts nowhere: no grade, mistake,
 *   mastery, review or study time.
 * Core and renderer parse them the same way, so a question's id, its option order and its right answer agree on both
 * sides. A block that does not validate is never shown as JSON: the chat draws a quiet line in its place.
 */

export const CHART_FENCE = "pyxis-chart";
export const QUESTION_FENCE = "pyxis-question";
export const CHAT_BLOCK_FENCES = [CHART_FENCE, QUESTION_FENCE] as const;

/** Characters of a block body read at all; a longer one is not a block. */
const BODY_MAX = 20_000;
export const CHART_SERIES_MAX = 4;
export const CHART_POINTS_MAX = 40;
export const CHART_LABEL_MAX = 60;
const TITLE_MAX = 120;
/** Values beyond this are not a student's numbers and would only break the scale. */
const VALUE_MAX = 1e9;

/** Text drawn as plain text: one line, no control characters, at most `max` characters. */
const plain = (max: number) =>
  z
    .string()
    .max(max * 4)
    .transform((text) =>
      text
        .replace(/[\u0000-\u001f\u007f]+/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, max),
    );
const label = plain(CHART_LABEL_MAX).pipe(z.string().min(1));
const value = z.number().finite().min(-VALUE_MAX).max(VALUE_MAX);

const chartSchema = z
  .object({
    title: plain(TITLE_MAX).pipe(z.string().min(1)),
    subtitle: plain(160).optional(),
    kind: z.enum(["bar", "line"]),
    x: plain(CHART_LABEL_MAX).optional(),
    y: plain(CHART_LABEL_MAX).optional(),
    unit: plain(16).optional(),
    min: value.optional(),
    max: value.optional(),
    series: z
      .array(
        z.object({
          name: plain(CHART_LABEL_MAX),
          points: z
            .array(
              z.object({
                label,
                value: value.nullable(),
                note: plain(80).optional(),
              }),
            )
            .min(1)
            .max(CHART_POINTS_MAX),
        }),
      )
      .min(1)
      .max(CHART_SERIES_MAX),
    reference: z.object({ value, label: plain(CHART_LABEL_MAX) }).optional(),
  })
  .refine((chart) => chartLabels(chart).length <= CHART_POINTS_MAX, "Too many points")
  .refine((chart) => chart.min === undefined || chart.max === undefined || chart.min < chart.max, "Empty range");

export type ChartData = z.infer<typeof chartSchema>;

/** The categories of a chart along its axis, in the order they first appear in any series. */
export function chartLabels(chart: { series: ReadonlyArray<{ points: ReadonlyArray<{ label: string }> }> }): string[] {
  const seen = new Set<string>();
  for (const series of chart.series) for (const point of series.points) seen.add(point.label);
  return [...seen];
}

type Loose = Record<string, unknown>;
const record = (raw: unknown): Loose | null =>
  raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Loose) : null;
const first = (value: Loose, ...keys: string[]) => keys.map((key) => value[key]).find((item) => item != null);
const text = (raw: unknown) => (typeof raw === "string" ? raw : typeof raw === "number" ? String(raw) : undefined);
/** A number as JSON gives it, or a numeric string; null for an explicit missing value, undefined for anything else. */
const numeric = (raw: unknown): number | null | undefined => {
  if (raw === null) return null;
  if (typeof raw === "number") return raw;
  if (typeof raw === "string" && /^\s*-?\d+(?:[.,]\d+)?\s*$/.test(raw)) return Number(raw.replace(",", "."));
  return undefined;
};

function loosePoints(raw: unknown): unknown {
  if (!Array.isArray(raw)) return raw;
  return raw.map((item) => {
    const point = record(item);
    if (!point) return item;
    // An explicit null is a value that does not exist yet, which `first` would skip as absent.
    const key = ["value", "y", "v"].find((name) => name in point);
    const number = key === undefined ? undefined : numeric(point[key]);
    return {
      label: text(first(point, "label", "x", "name", "category")),
      value: number === undefined ? undefined : number,
      note: text(first(point, "note", "detail", "tooltip")),
    };
  });
}

/** The chart in a ```pyxis-chart body, or null when it is not one. */
export function parseChart(body: string): ChartData | null {
  if (body.length > BODY_MAX) return null;
  const value = record(parseLooseJson(body));
  if (!value) return null;
  const kind = text(first(value, "kind", "type"))?.toLowerCase();
  const rawSeries = first(value, "series", "data");
  // One series written as its list of points.
  const series = Array.isArray(rawSeries) && rawSeries.every((item) => record(item) && !("points" in (item as Loose)))
    ? [{ name: text(first(value, "y", "name")) ?? "", points: rawSeries }]
    : rawSeries;
  const reference = record(first(value, "reference", "ref", "threshold"));
  const parsed = chartSchema.safeParse({
    title: text(first(value, "title")),
    subtitle: text(first(value, "subtitle", "description")),
    kind: kind === "bars" || kind === "column" ? "bar" : kind === "lines" ? "line" : kind,
    x: text(first(value, "x", "xLabel", "x_label")),
    y: text(first(value, "y", "yLabel", "y_label")),
    unit: text(first(value, "unit", "units")),
    min: numeric(first(value, "min")) ?? undefined,
    max: numeric(first(value, "max")) ?? undefined,
    series: Array.isArray(series)
      ? series.map((item) => {
          const one = record(item);
          return one ? { name: text(first(one, "name", "label")) ?? "", points: loosePoints(first(one, "points", "data", "values")) } : item;
        })
      : series,
    reference: reference
      ? { value: numeric(first(reference, "value", "y")), label: text(first(reference, "label", "name")) ?? "" }
      : undefined,
  });
  return parsed.success ? parsed.data : null;
}

const questionSchema = z
  .object({
    question: z.string().trim().min(1).max(2000),
    options: z.array(z.string().trim().min(1).max(800)).min(2).max(5),
    answer: z.number().int().min(0),
    /** One sentence per option, said after that option is picked. */
    feedback: z.array(z.string().trim().max(1500)).optional(),
    right: z.string().trim().max(1500).optional(),
    wrong: z.string().trim().max(1500).optional(),
  })
  .refine((question) => question.answer < question.options.length)
  .refine((question) => !question.feedback || question.feedback.length === question.options.length);

export type QuestionData = z.infer<typeof questionSchema>;
/**
 * A question as the chat shows it: its id, its options in their shown order with the right one at `answer`, and
 * `order[i]`, the place the shown option `i` had in the block.
 */
export type ChatQuestion = QuestionData & { id: string; order: number[] };

function repairQuestion(raw: unknown): QuestionData | null {
  const value = record(raw);
  if (!value) return null;
  let options = (first(value, "options", "choices") as unknown[] | undefined)?.map?.(text);
  if (!options || options.some((option) => option === undefined)) return null;
  // "A) text" on every option: the letter is the chat's, not the model's.
  if (options.every((option) => /^[A-Ea-e][).:]\s+/.test(option!)))
    options = options.map((option) => option!.replace(/^[A-Ea-e][).:]\s+/, ""));
  let answer = first(value, "answer", "correct", "correctIndex");
  if (typeof answer === "string") {
    const said = answer.trim();
    const exact = options.findIndex((option) => option!.trim() === said);
    const letter = /^[A-Ea-e]$/.test(said) ? said.toUpperCase().charCodeAt(0) - 65 : -1;
    answer = exact >= 0 ? exact : letter >= 0 ? letter : /^\d+$/.test(said) ? Number(said) : answer;
  }
  const feedback = first(value, "feedback", "feedbacks");
  const explanation = text(first(value, "explanation", "why"));
  const parsed = questionSchema.safeParse({
    question: text(first(value, "question", "stem", "prompt")),
    options,
    answer,
    feedback: Array.isArray(feedback) ? feedback.map((item) => text(item) ?? "") : undefined,
    right: text(first(value, "right", "correctFeedback")) ?? (typeof feedback === "string" ? feedback : explanation),
    wrong: text(first(value, "wrong", "wrongFeedback")) ?? (typeof feedback === "string" ? feedback : explanation),
  });
  return parsed.success ? parsed.data : null;
}

/** The question in a ```pyxis-question body without its id, or null when it is not one. */
export function parseQuestion(body: string): QuestionData | null {
  return body.length > BODY_MAX ? null : repairQuestion(parseLooseJson(body));
}

/** What the student reads after picking `shown`, an index in the shown order: the option's own sentence, or right/wrong. */
export function questionFeedback(question: ChatQuestion, shown: number): string {
  const own = question.feedback?.[question.order[shown] ?? -1]?.trim();
  if (own) return own;
  return (shown === question.answer ? question.right : question.wrong)?.trim() ?? "";
}

export type ChatBlock =
  | { kind: "chart"; chart: ChartData | null }
  | { kind: "question"; question: ChatQuestion | null };

/**
 * The question in a ```pyxis-question body as the chat shows it, or null. Its id comes from its content, so the same
 * block has the same id, option order and stored answer while it streams, once saved and after a restart. Two identical
 * questions in one reply share their answer.
 */
export function chatQuestion(body: string): ChatQuestion | null {
  const data = parseQuestion(body);
  if (!data) return null;
  const id = `question-${hash(JSON.stringify(data))}`;
  const shown = arranged({ question: data.question, options: data.options, answer: data.answer, explanation: undefined }, id);
  return { ...data, options: shown.options, answer: shown.answer, order: shown.order, id };
}

/**
 * Rewrites every closed chart and question block of a reply, as `mapFigureBlocks` does figures: `replace` gets the
 * parsed block (null data when it does not validate) and returns the text to put in its place, or null to keep it.
 */
export function mapChatBlocks(body: string, replace: (block: ChatBlock) => string | null): string {
  if (!body.includes(CHART_FENCE) && !body.includes(QUESTION_FENCE)) return body;
  const one = (language: string, inner: string) =>
    language === CHART_FENCE
      ? replace({ kind: "chart", chart: parseChart(inner) })
      : replace({ kind: "question", question: chatQuestion(inner) });
  return mapQuotedBlocks(mapFencedBlocks(body, CHAT_BLOCK_FENCES, one), one);
}

const QUOTED_OPEN = /^((?:[ \t]*>[ \t]?)+)(`{3,}|~{3,})[ \t]*(pyxis-chart|pyxis-question)[ \t]*$/i;

/** The blocks written inside a block quote (`> ```pyxis-chart`), with their replacement quoted as they were. */
function mapQuotedBlocks(body: string, replace: (language: string, inner: string) => string | null): string {
  if (!/^[ \t]*>/m.test(body)) return body;
  const lines = body.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const open = QUOTED_OPEN.exec(lines[i]!);
    if (!open) {
      out.push(lines[i]!);
      continue;
    }
    const lead = open[1]!;
    const fence = open[2]!;
    const bare = lead.replace(/[ \t]+$/, "");
    let close = i + 1;
    const inside = (line: string) => line.startsWith(bare);
    const strip = (line: string) => line.slice(line.startsWith(lead) ? lead.length : bare.length);
    // Only the opener's own character, at least as many times, closes it.
    const closes = (line: string) => {
      const text = strip(line).trim();
      return text.length >= fence.length && text === fence[0]!.repeat(text.length);
    };
    while (close < lines.length && inside(lines[close]!) && !closes(lines[close]!)) close++;
    if (close >= lines.length || !inside(lines[close]!)) {
      out.push(lines[i]!);
      continue;
    }
    const next = replace(open[3]!.toLowerCase(), lines.slice(i + 1, close).map(strip).join("\n"));
    if (next === null) out.push(...lines.slice(i, close + 1));
    else out.push(...next.split("\n").map((line) => (line ? `${lead}${line}` : bare)));
    i = close;
  }
  return out.join("\n");
}

/** The questions a reply holds, by id. */
export function chatQuestions(body: string): Map<string, ChatQuestion> {
  const found = new Map<string, ChatQuestion>();
  mapChatBlocks(body, (block) => {
    if (block.kind === "question" && block.question) found.set(block.question.id, block.question);
    return null;
  });
  return found;
}

export type ChatBlockLabels = {
  question: string;
  right: string;
  yours: string;
  missing: string;
  reference: string;
  /** In place of a block that does not validate. */
  chartFailed: string;
  questionFailed: string;
};

const cell = (value: string) => value.replace(/\|/g, "\\|");

export function formatChartValue(value: number, unit: string | undefined, locale: string): string {
  const number = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(value);
  if (!unit) return number;
  return /^[/%]/.test(unit) ? `${number}${unit}` : `${number} ${unit}`;
}

/** A chart as Markdown: its title and the same data as a table, which export and «Copia» write in its place. */
export function chartText(chart: ChartData, labels: ChatBlockLabels, locale: string): string {
  const categories = chartLabels(chart);
  const head = [chart.x || "", ...chart.series.map((series) => series.name || chart.y || "")];
  const rows = categories.map((category) => [
    category,
    ...chart.series.map((series) => {
      const point = series.points.find((item) => item.label === category);
      if (!point) return "";
      if (point.value === null) return point.note || labels.missing;
      const shown = formatChartValue(point.value, chart.unit, locale);
      return point.note ? `${shown} (${point.note})` : shown;
    }),
  ]);
  return [
    `**${chart.title}**`,
    ...(chart.subtitle ? ["", chart.subtitle] : []),
    "",
    `| ${head.map(cell).join(" | ")} |`,
    `| ${head.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(cell).join(" | ")} |`),
    ...(chart.reference
      ? ["", `${labels.reference}: ${chart.reference.label || formatChartValue(chart.reference.value, chart.unit, locale)}`]
      : []),
  ].join("\n");
}

/** A question as Markdown: the text, the options with letters, the right one and the student's pick when there is one. */
export function questionText(question: ChatQuestion, pick: number | undefined, labels: ChatBlockLabels): string {
  // The pick is kept as the block's own index; the options are listed in the order the chat shows them.
  const shownPick = pick === undefined ? -1 : question.order.indexOf(pick);
  return [
    `**${labels.question}.** ${question.question}`,
    "",
    ...question.options.map((option, index) => {
      const marks = [index === question.answer && labels.right, index === shownPick && labels.yours].filter(Boolean);
      return `${String.fromCharCode(65 + index)}. ${option}${marks.length ? ` (${marks.join(", ")})` : ""}`;
    }),
  ].join("\n");
}

/**
 * A reply with its chart and question blocks as readable text: a chart as its table, a question with its options and,
 * from `picks` (by question id), the student's answer. A block that does not validate becomes its quiet line.
 */
export function chatBlocksAsText(
  body: string,
  labels: ChatBlockLabels,
  locale: string,
  picks: Record<string, number> = {},
  /** A valid chart stays a block, for a printed page that draws it. */
  keepCharts = false,
): string {
  return mapChatBlocks(body, (block) => {
    if (block.kind === "chart")
      return block.chart ? (keepCharts ? null : chartText(block.chart, labels, locale)) : `*${labels.chartFailed}*`;
    return block.question ? questionText(block.question, picks[block.question.id], labels) : `*${labels.questionFailed}*`;
  });
}

/** The words export, search and «Copia» write around the blocks, in the two languages Pyxis speaks. */
export const CHAT_BLOCK_TEXT: Record<"en" | "it", ChatBlockLabels> = {
  en: {
    question: "Question",
    right: "the right one",
    yours: "your answer",
    missing: "not done yet",
    reference: "Reference line",
    chartFailed: "The chart could not be drawn.",
    questionFailed: "The question could not be shown.",
  },
  it: {
    question: "Domanda",
    right: "quella giusta",
    yours: "la tua risposta",
    missing: "non ancora fatto",
    reference: "Linea di riferimento",
    chartFailed: "Non è stato possibile disegnare il grafico.",
    questionFailed: "Non è stato possibile mostrare la domanda.",
  },
};
