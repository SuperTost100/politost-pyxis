import { z } from "zod";
import { end, parseMarkdown, start, walk } from "./markdown-tree";
import { arranged, hash, mapFencedBlocks, parseLooseJson, stripPassageRefs } from "./smart-text";

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
  .refine((chart) => chartCategories(chart).length <= CHART_POINTS_MAX, "Too many points")
  .refine((chart) => chart.min === undefined || chart.max === undefined || chart.min < chart.max, "Empty range");

export type ChartData = z.infer<typeof chartSchema>;

type Point = { label: string; value: number | null; note?: string };

/**
 * The categories of a chart along its axis, each with the point of every series there (null where a series has none).
 * Series line up by label, in the order the labels first appear, and a label a series repeats is matched by its turn:
 * the second "9 nov" of one series sits with the second "9 nov" of another, so two results on one day both stay. One
 * series is the same rule with nothing to match.
 */
export function chartCategories<P extends Point>(chart: { series: ReadonlyArray<{ points: ReadonlyArray<P> }> }): Array<{
  label: string;
  points: Array<P | null>;
}> {
  const categories = new Map<string, { label: string; points: Array<P | null> }>();
  chart.series.forEach((series, column) => {
    const seen = new Map<string, number>();
    for (const point of series.points) {
      const turn = seen.get(point.label) ?? 0;
      seen.set(point.label, turn + 1);
      const key = `${turn}\u0000${point.label}`;
      let category = categories.get(key);
      if (!category) {
        category = { label: point.label, points: chart.series.map(() => null) };
        categories.set(key, category);
      }
      category.points[column] = point;
    }
  });
  return [...categories.values()];
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
  const listed = first(value, "options", "choices");
  // Only a list is a list of options: an object with a `map` key of its own must not reach a call.
  if (!Array.isArray(listed)) return null;
  let options = listed.map(text);
  if (options.some((option) => option === undefined)) return null;
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
  // A passage marker cannot link inside the block, so it goes, as from the rest of a reply's text.
  const clean = (said: string | undefined) => (said === undefined ? undefined : stripPassageRefs(said));
  const parsed = questionSchema.safeParse({
    question: clean(text(first(value, "question", "stem", "prompt"))),
    options: options.map((option) => clean(option)),
    answer,
    feedback: Array.isArray(feedback) ? feedback.map((item) => clean(text(item)) ?? "") : undefined,
    right: clean(text(first(value, "right", "correctFeedback")) ?? (typeof feedback === "string" ? feedback : explanation)),
    wrong: clean(text(first(value, "wrong", "wrongFeedback")) ?? (typeof feedback === "string" ? feedback : explanation)),
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
 * A reply's text as the Markdown view reads it: a figure, chart or question block indented as far as indented code in a
 * list item is lifted to where it reads as that block (`mapFencedBlocks`). The view and every reader of the blocks below
 * start from this text, so they find the same blocks.
 */
export function liftBlocks(body: string): string {
  return mapFencedBlocks(body, ["pyxis-figure", ...CHAT_BLOCK_FENCES], () => null);
}

/**
 * Rewrites every chart and question block of a reply: `replace` gets the parsed block (null data when it does not
 * validate) and returns the text to put in its place, or null to keep it. A block is what the Markdown view draws as
 * one: a code block of that language in the parser's tree (`parseMarkdown`, the view's own parser), at the top level,
 * in a list item (even right after the marker) or in a quote, closed or left open at the end of the reply. Text put in
 * a block's place stays where the block was: each of its lines after the first gets the block's own indent and quote
 * marks.
 */
export function mapChatBlocks(body: string, replace: (block: ChatBlock) => string | null): string {
  if (!body.includes(CHART_FENCE) && !body.includes(QUESTION_FENCE)) return body;
  const text = liftBlocks(body);
  const found: Array<{ from: number; to: number; next: string }> = [];
  walk(parseMarkdown(text), (node) => {
    if (node.type !== "code" || (node.lang !== CHART_FENCE && node.lang !== QUESTION_FENCE) || !node.position) return;
    const block: ChatBlock =
      node.lang === CHART_FENCE
        ? { kind: "chart", chart: parseChart(node.value ?? "") }
        : { kind: "question", question: chatQuestion(node.value ?? "") };
    const next = replace(block);
    if (next !== null) found.push({ from: start(node), to: end(node), next });
  });
  if (found.length === 0) return body;
  let out = text;
  for (const { from, to, next } of found.reverse()) {
    // What stands before the block on its line: a list marker becomes as many spaces, quote marks stay.
    const lead = text.slice(text.lastIndexOf("\n", from - 1) + 1, from);
    const going = lead.replace(/[-*+]|\d+[.)]/g, (marker) => " ".repeat(marker.length));
    const lines = next.split("\n").map((line, index) => (index === 0 || !line ? line : going + line));
    out = `${out.slice(0, from)}${lines.map((line, index) => (index > 0 && !line ? going.trimEnd() : line)).join("\n")}${out.slice(to)}`;
  }
  return out;
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

/**
 * A number with the decimals it needs: two at most from 1 up, and below 1 enough to keep three significant digits, so
 * 0.0001 and 0.00034 stay apart instead of both reading 0.
 */
export function formatChartNumber(value: number, locale: string): string {
  const size = Math.abs(value);
  const decimals = size === 0 || size >= 1 ? 2 : Math.min(12, Math.ceil(-Math.log10(size)) + 2);
  return new Intl.NumberFormat(locale, { maximumFractionDigits: decimals }).format(value);
}

export function formatChartValue(value: number, unit: string | undefined, locale: string): string {
  const number = formatChartNumber(value, locale);
  if (!unit) return number;
  return /^[/%]/.test(unit) ? `${number}${unit}` : `${number} ${unit}`;
}

/** A chart as Markdown: its title and the same data as a table, which export and «Copia» write in its place. */
export function chartText(chart: ChartData, labels: ChatBlockLabels, locale: string): string {
  const head = [chart.x || "", ...chart.series.map((series) => series.name || chart.y || "")];
  const rows = chartCategories(chart).map((category) => [
    category.label,
    ...category.points.map((point) => {
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
