import { describe, expect, it } from "vitest";
import {
  CHART_POINTS_MAX,
  CHAT_BLOCK_TEXT,
  chatBlocksAsText,
  chatQuestion,
  chatQuestions,
  mapChatBlocks,
  parseChart,
  questionFeedback,
} from "./chat-blocks";

const GRADES = {
  title: "I tuoi voti nei quiz di Fisica 1",
  subtitle: "In trentesimi, l'ultimo quiz di ogni argomento",
  kind: "bar",
  x: "Argomento",
  y: "Voto",
  unit: "/30",
  min: 0,
  max: 30,
  series: [
    {
      name: "Voto",
      points: [
        { label: "Cinematica", value: 26, note: "quiz del 9 novembre" },
        { label: "Dinamica", value: 21, note: "quiz del 19 novembre" },
        { label: "Termodinamica", value: null, note: "non ancora fatto" },
      ],
    },
  ],
  reference: { value: 18, label: "sufficienza, 18" },
};
const chart = (value: object) => JSON.stringify(value);
const QUESTION = {
  question: "Quanto vale la forza di attrito statico su un blocco fermo?",
  options: ["$\\mu_s N$, sempre", "$mg\\sin\\theta$", "$mg\\cos\\theta$"],
  answer: 1,
  feedback: ["Solo al limite.", "Giusto.", "È la normale."],
};

describe("chart blocks", () => {
  it("reads a whole chart, missing values included", () => {
    const parsed = parseChart(chart(GRADES))!;
    expect(parsed.kind).toBe("bar");
    expect(parsed.series[0]!.points.map((point) => point.value)).toEqual([26, 21, null]);
    expect(parsed.reference).toEqual({ value: 18, label: "sufficienza, 18" });
  });

  it("repairs the shapes models write: one series as its points, numbers as text, other key names", () => {
    const parsed = parseChart(
      chart({ title: "Andamento", type: "lines", data: [{ x: "1 nov", y: "18,5" }, { x: "9 nov", y: 26 }], threshold: { y: 18, name: "18" } }),
    )!;
    expect(parsed.kind).toBe("line");
    expect(parsed.series[0]!.points).toEqual([
      { label: "1 nov", value: 18.5 },
      { label: "9 nov", value: 26 },
    ]);
    expect(parsed.reference).toEqual({ value: 18, label: "18" });
  });

  it("refuses what is not a chart: incomplete while streaming, no title, an unknown kind, no points", () => {
    expect(parseChart(chart(GRADES).slice(0, 120))).toBeNull();
    expect(parseChart(chart({ ...GRADES, title: "" }))).toBeNull();
    expect(parseChart(chart({ ...GRADES, kind: "pie" }))).toBeNull();
    expect(parseChart(chart({ ...GRADES, series: [{ name: "Voto", points: [] }] }))).toBeNull();
    expect(parseChart(chart({ ...GRADES, min: 30, max: 0 }))).toBeNull();
    expect(parseChart("not json at all")).toBeNull();
  });

  it("refuses hostile bodies: huge numbers, thousands of points, too many series, a giant body", () => {
    expect(parseChart(chart({ ...GRADES, series: [{ name: "x", points: [{ label: "a", value: 1e300 }] }] }))).toBeNull();
    const many = Array.from({ length: 2000 }, (_, i) => ({ label: `p${i}`, value: i }));
    expect(parseChart(chart({ ...GRADES, series: [{ name: "x", points: many }] }))).toBeNull();
    const limit = Array.from({ length: CHART_POINTS_MAX }, (_, i) => ({ label: `p${i}`, value: i }));
    expect(parseChart(chart({ ...GRADES, series: [{ name: "x", points: limit }] }))).not.toBeNull();
    // Forty points in each of two series, but eighty categories along the axis.
    const shifted = limit.map((point) => ({ ...point, label: `q${point.label}` }));
    expect(parseChart(chart({ ...GRADES, series: [{ name: "x", points: limit }, { name: "y", points: shifted }] }))).toBeNull();
    const series = Array.from({ length: 5 }, (_, i) => ({ name: `s${i}`, points: [{ label: "a", value: i }] }));
    expect(parseChart(chart({ ...GRADES, series }))).toBeNull();
    expect(parseChart(chart({ ...GRADES, subtitle: "x".repeat(30_000) }))).toBeNull();
  });

  it("keeps HTML in labels as plain text and cuts long labels", () => {
    const parsed = parseChart(
      chart({
        ...GRADES,
        title: "<img src=x onerror=alert(1)>Voti",
        series: [{ name: "<b>Voto</b>", points: [{ label: `<script>alert(1)</script>${"a".repeat(200)}`, value: 3 }] }],
      }),
    )!;
    expect(parsed.title).toBe("<img src=x onerror=alert(1)>Voti");
    expect(parsed.series[0]!.points[0]!.label).toHaveLength(60);
    // As text, the label is a table cell's text: Markdown would escape a pipe, and HTML stays characters.
    expect(chatBlocksAsText(`\`\`\`pyxis-chart\n${chart(parsed)}\n\`\`\``, CHAT_BLOCK_TEXT.en, "en")).toContain("| <script>alert(1)</script>");
  });

  it("writes a chart as a title and a table, with the unit and the note of a missing value", () => {
    const text = chatBlocksAsText(`Ecco.\n\n\`\`\`pyxis-chart\n${chart(GRADES)}\n\`\`\`\n\nFine.`, CHAT_BLOCK_TEXT.it, "it");
    expect(text).toBe(
      [
        "Ecco.",
        "",
        "**I tuoi voti nei quiz di Fisica 1**",
        "",
        "In trentesimi, l'ultimo quiz di ogni argomento",
        "",
        "| Argomento | Voto |",
        "| --- | --- |",
        "| Cinematica | 26/30 (quiz del 9 novembre) |",
        "| Dinamica | 21/30 (quiz del 19 novembre) |",
        "| Termodinamica | non ancora fatto |",
        "",
        "Linea di riferimento: sufficienza, 18",
        "",
        "Fine.",
      ].join("\n"),
    );
    expect(chatBlocksAsText("```pyxis-chart\n{oops\n```", CHAT_BLOCK_TEXT.it, "it")).toBe(
      "*Non è stato possibile disegnare il grafico.*",
    );
  });
});

describe("question blocks", () => {
  it("gives a question an id from its content and the same option order every time", () => {
    const one = chatQuestion(JSON.stringify(QUESTION))!;
    const again = chatQuestion(JSON.stringify(QUESTION, null, 2))!;
    expect(one.id).toMatch(/^question-/);
    expect(again).toEqual(one);
    expect(one.options[one.answer]).toBe("$mg\\sin\\theta$");
    expect(one.order.map((from) => QUESTION.options[from])).toEqual(one.options);
    expect(chatQuestion(JSON.stringify({ ...QUESTION, question: "Altro?" }))!.id).not.toBe(one.id);
  });

  it("repairs letters in options and an answer given as a letter or as its text", () => {
    const lettered = chatQuestion(JSON.stringify({ ...QUESTION, options: ["A) uno", "B) due", "C) tre"], answer: "B" }))!;
    expect(lettered.options.toSorted()).toEqual(["due", "tre", "uno"]);
    expect(lettered.options[lettered.answer]).toBe("due");
    const byText = chatQuestion(JSON.stringify({ ...QUESTION, answer: "$mg\\cos\\theta$" }))!;
    expect(byText.options[byText.answer]).toBe("$mg\\cos\\theta$");
  });

  it("refuses a question with an answer out of range, one option, feedback of the wrong length or no question", () => {
    expect(chatQuestion(JSON.stringify({ ...QUESTION, answer: 3 }))).toBeNull();
    expect(chatQuestion(JSON.stringify({ ...QUESTION, options: ["solo"], answer: 0 }))).toBeNull();
    expect(chatQuestion(JSON.stringify({ ...QUESTION, feedback: ["uno"] }))).toBeNull();
    expect(chatQuestion(JSON.stringify({ ...QUESTION, question: "" }))).toBeNull();
    expect(chatQuestion(JSON.stringify(QUESTION).slice(0, 40))).toBeNull();
    expect(chatQuestion(JSON.stringify({ ...QUESTION, options: Array.from({ length: 6 }, (_, i) => `${i}`) }))).toBeNull();
  });

  it("says the picked option's own sentence, or the right or wrong one", () => {
    const question = chatQuestion(JSON.stringify(QUESTION))!;
    const shown = (from: number) => question.order.indexOf(from);
    expect(questionFeedback(question, shown(0))).toBe("Solo al limite.");
    expect(questionFeedback(question, shown(2))).toBe("È la normale.");
    const plain = chatQuestion(JSON.stringify({ ...QUESTION, feedback: undefined, right: "Sì.", wrong: "No: equilibra il peso." }))!;
    expect(questionFeedback(plain, plain.answer)).toBe("Sì.");
    expect(questionFeedback(plain, (plain.answer + 1) % 3)).toBe("No: equilibra il peso.");
    const explained = chatQuestion(JSON.stringify({ ...QUESTION, feedback: undefined, explanation: "Perché sì." }))!;
    expect(questionFeedback(explained, 0)).toBe("Perché sì.");
  });

  it("finds a block inside a list item or a quote, and leaves one in ordinary code alone", () => {
    const fenced = `\`\`\`pyxis-question\n${JSON.stringify(QUESTION)}\n\`\`\``;
    const listed = `1. Prima domanda:\n\n   ${fenced.replace(/\n/g, "\n   ")}\n2. Dopo.`;
    expect(chatQuestions(listed).size).toBe(1);
    const quoted = `> ${fenced.replace(/\n/g, "\n> ")}`;
    expect(chatQuestions(quoted).size).toBe(1);
    expect(mapChatBlocks(`Prima\n\n${quoted}\n\nDopo`, () => "riga uno\n\nriga due")).toBe("Prima\n\n> riga uno\n>\n> riga due\n\nDopo");
    const code = `\`\`\`\`markdown\n${fenced}\n\`\`\`\``;
    expect(chatQuestions(code).size).toBe(0);
    const indented = `    ${fenced.replace(/\n/g, "\n    ")}`;
    expect(chatQuestions(indented).size).toBe(0);
  });

  it("writes a question with its options, the right one and the student's answer", () => {
    const question = chatQuestion(JSON.stringify(QUESTION))!;
    const text = chatBlocksAsText(`\`\`\`pyxis-question\n${JSON.stringify(QUESTION)}\n\`\`\``, CHAT_BLOCK_TEXT.en, "en", {
      [question.id]: 2,
    });
    const letter = (from: number) => String.fromCharCode(65 + question.order.indexOf(from));
    expect(text).toContain("**Question.** Quanto vale la forza di attrito statico su un blocco fermo?");
    expect(text).toContain(`${letter(1)}. $mg\\sin\\theta$ (the right one)`);
    expect(text).toContain(`${letter(2)}. $mg\\cos\\theta$ (your answer)`);
    expect(text).not.toContain("feedback");
  });
});
