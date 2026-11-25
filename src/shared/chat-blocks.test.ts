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
        "Linea di riferimento: 18/30, sufficienza, 18",
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

describe("question text", () => {
  it("drops passage markers the model wrote inside the block, which cannot link there", () => {
    const question = chatQuestion(
      JSON.stringify({ ...QUESTION, question: "Quanto vale [P1]?", feedback: ["Solo al limite [P1].", "Equilibra la spinta [P1; P2].", "No."] }),
    )!;
    expect(question.question).toBe("Quanto vale?");
    expect(question.feedback).toEqual(["Solo al limite.", "Equilibra la spinta.", "No."]);
  });
});

describe("chart categories", () => {
  it("keeps every point of one series, even two with the same label, and lines several series up by label", () => {
    const line = parseChart(
      chart({
        title: "Andamento",
        kind: "line",
        series: [{ name: "Voto", points: [{ label: "Cinematica", value: 18 }, { label: "Cinematica", value: 26 }, { label: "Dinamica", value: 21 }] }],
      }),
    )!;
    expect(chatBlocksAsText(`\`\`\`pyxis-chart\n${chart(line)}\n\`\`\``, CHAT_BLOCK_TEXT.en, "en")).toContain(
      "| Cinematica | 18 |\n| Cinematica | 26 |\n| Dinamica | 21 |",
    );
  });
});

describe("review fixes", () => {
  const fence = (language: string, value: unknown) => `\`\`\`${language}\n${JSON.stringify(value)}\n\`\`\``;

  it("never throws on odd JSON shapes, and draws its quiet line instead", () => {
    const shapes: unknown[] = [
      { ...QUESTION, options: { map: 1 } },
      { ...QUESTION, options: { map: () => [] } },
      { ...QUESTION, options: "A, B" },
      { ...QUESTION, options: [1, null, {}] },
      { ...QUESTION, answer: { index: 1 } },
      { ...QUESTION, question: ["a"] },
      { ...GRADES, series: { 0: GRADES.series[0] } },
      { ...GRADES, series: [{ name: "x", points: { label: "a" } }] },
      { ...GRADES, series: [null, 1, "x"] },
      { ...GRADES, series: [{ name: "x", points: [null, 3, "x", { label: { x: 1 }, value: [1] }] }] },
      { ...GRADES, reference: [18] },
      { ...GRADES, reference: { value: { v: 1 } } },
      { ...GRADES, title: { it: "x" }, kind: ["bar"] },
      [],
      null,
      42,
      "text",
    ];
    for (const shape of shapes) {
      for (const language of ["pyxis-question", "pyxis-chart"]) {
        const body = fence(language, shape);
        expect(() => chatQuestions(body), JSON.stringify(shape)).not.toThrow();
        expect(() => chatBlocksAsText(body, CHAT_BLOCK_TEXT.it, "it"), JSON.stringify(shape)).not.toThrow();
      }
      expect(chatQuestion(JSON.stringify(shape))).toBeNull();
    }
    // Feedback that is not a list is left out: the question still works, with no sentence after the pick.
    expect(chatQuestion(JSON.stringify({ ...QUESTION, feedback: { 0: "x" } }))?.feedback).toBeUndefined();
    expect(chatBlocksAsText(fence("pyxis-question", { ...QUESTION, options: { map: 1 } }), CHAT_BLOCK_TEXT.it, "it")).toBe(
      "*Non è stato possibile mostrare la domanda.*",
    );
  });

  it("finds a block where the Markdown view draws one: right after a list marker, and unclosed at the end of a reply", () => {
    const json = JSON.stringify(QUESTION);
    expect(chatQuestions(`1. Prova:\n2. \`\`\`pyxis-question\n   ${json}\n   \`\`\``).size).toBe(1);
    expect(chatQuestions(`- \`\`\`pyxis-question\n  ${json}\n  \`\`\``).size).toBe(1);
    expect(chatQuestions(`Ecco una domanda.\n\n\`\`\`pyxis-question\n${json}`).size).toBe(1);
    // As text, a block after a list marker stays in its item.
    expect(chatBlocksAsText(`- \`\`\`pyxis-chart\n  ${chart(GRADES)}\n  \`\`\`\n- Dopo`, CHAT_BLOCK_TEXT.it, "it")).toContain(
      "- **I tuoi voti nei quiz di Fisica 1**\n\n  In trentesimi",
    );
  });

  it("keeps two results with the same label in several series, matched by their order", () => {
    const parsed = parseChart(
      chart({
        title: "Confronto",
        kind: "line",
        series: [
          { name: "Io", points: [{ label: "9 nov", value: 20 }, { label: "9 nov", value: 24 }, { label: "12 nov", value: 26 }] },
          { name: "Media", points: [{ label: "9 nov", value: 18 }, { label: "9 nov", value: 19 }] },
        ],
      }),
    )!;
    expect(chatBlocksAsText(fence("pyxis-chart", parsed), CHAT_BLOCK_TEXT.en, "en")).toContain(
      "| 9 nov | 20 | 18 |\n| 9 nov | 24 | 19 |\n| 12 nov | 26 |  |",
    );
  });

  it("shows small values with the precision they need", () => {
    const parsed = parseChart(
      chart({ title: "Tempi", kind: "bar", unit: "s", series: [{ name: "t", points: [{ label: "a", value: 0.0001 }, { label: "b", value: 0.00034 }, { label: "c", value: 1250.5 }] }] }),
    )!;
    const text = chatBlocksAsText(fence("pyxis-chart", parsed), CHAT_BLOCK_TEXT.en, "en");
    expect(text).toContain("| a | 0.0001 s |");
    expect(text).toContain("| b | 0.00034 s |");
    expect(text).toContain("| c | 1,250.5 s |");
  });
});

describe("CodeRabbit fixes", () => {
  const fence = (value: unknown) => `\`\`\`pyxis-chart\n${JSON.stringify(value)}\n\`\`\``;

  it("reads a series written with data or values in place of points", () => {
    for (const key of ["data", "values"]) {
      const parsed = parseChart(chart({ title: "Voti", kind: "bar", series: [{ name: "Voto", [key]: [{ label: "a", value: 26 }] }] }));
      expect(parsed?.series[0]).toEqual({ name: "Voto", points: [{ label: "a", value: 26 }] });
    }
  });

  it("writes values far below one in scientific notation, and ordinary values as before", () => {
    const parsed = parseChart(
      chart({ title: "Cariche", kind: "bar", unit: "C", series: [{ name: "q", points: [{ label: "e", value: 1.6e-19 }, { label: "2e", value: 3.2e-19 }, { label: "n", value: 26 }] }] }),
    )!;
    const text = chatBlocksAsText(fence(parsed), CHAT_BLOCK_TEXT.en, "en");
    expect(text).toContain("| e | 1.6E-19 C |");
    expect(text).toContain("| 2e | 3.2E-19 C |");
    expect(text).toContain("| n | 26 C |");
  });

  it("writes the reference line's value beside its label", () => {
    const parsed = parseChart(chart({ ...GRADES, reference: { value: 18, label: "Sufficienza" } }))!;
    expect(chatBlocksAsText(fence(parsed), CHAT_BLOCK_TEXT.it, "it")).toContain("Linea di riferimento: 18/30, Sufficienza");
    const bare = parseChart(chart({ ...GRADES, reference: { value: 18, label: "" } }))!;
    expect(chatBlocksAsText(fence(bare), CHAT_BLOCK_TEXT.it, "it")).toMatch(/Linea di riferimento: 18\/30$/);
  });

  it("leaves passage marks out of a chart's texts, as from figure captions", () => {
    const parsed = parseChart(
      chart({ ...GRADES, title: "Voti [P1]", subtitle: "Dal libro [P2; P3]", series: [{ name: "Voto [P1]", points: [{ label: "Cinematica [P4]", value: 26, note: "quiz [P1]" }] }] }),
    )!;
    expect([parsed.title, parsed.subtitle, parsed.series[0]!.name, parsed.series[0]!.points[0]!.label, parsed.series[0]!.points[0]!.note]).toEqual([
      "Voti",
      "Dal libro",
      "Voto",
      "Cinematica",
      "quiz",
    ]);
  });
});
