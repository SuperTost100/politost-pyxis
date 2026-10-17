import { describe, expect, it } from "vitest";
import {
  FIGURE_CODE_MAX,
  FIGURE_IMAGE_MAX,
  figureImages,
  figureKey,
  mapFigureBlocks,
  parseFigure,
  finalRecap,
  parseLooseJson,
  parseSmartText,
  replaceSection,
  smartQuestions,
  smartSections,
  smartTextToMarkdown,
  smartLabels,
  splitCitationGroups,
  stripPassageRefs,
} from "./smart-text";

const check = {
  question: "Quanto vale $F$ se $m=2$ e $a=3$?",
  options: ["$5$ N", "$6$ N", "$1.5$ N"],
  answer: 1,
  explanation: "$F=ma=6$ N.",
};
const lesson = [
  "## Seconda legge",
  "",
  "La forza è $F=ma$.",
  "",
  "```pyxis-check",
  JSON.stringify(check),
  "```",
  "",
  "```pyxis-try",
  '{"prompt": "Calcola $a$ per $F=10$ e $m=5$.", "hint": "Isola $a$.", "steps": ["$a=F/m$", "$a=2$"], "answer": "$2\\\\,m/s^2$"}',
  "```",
  "",
  "## Ripasso",
  "",
  "```pyxis-recap",
  JSON.stringify({ questions: [check, { ...check, question: "Unità della forza?", options: ["N", "J"], answer: 0 }] }),
  "```",
].join("\n");

describe("smart text", () => {
  it("splits prose and blocks with stable ids", () => {
    const segments = parseSmartText(lesson);
    expect(segments.map((s) => (s.type === "block" ? s.block.kind : s.type))).toEqual([
      "markdown",
      "check",
      "try",
      "markdown",
      "recap",
    ]);
    const again = parseSmartText(lesson);
    expect(again).toEqual(segments);
    const questions = smartQuestions(segments);
    expect(questions.size).toBe(3);
    const recap = finalRecap(segments)!;
    expect(recap.questions.map((q) => q.id)).toEqual([`${recap.id}.1`, `${recap.id}.2`]);
    expect(questions.get(`${recap.id}.2`)?.recapId).toBe(recap.id);
    // Changing a block's content changes its id, so a stale answer cannot attach to a rewritten question.
    const edited = parseSmartText(lesson.replace("$m=2$", "$m=4$"));
    expect(smartQuestions(edited).has([...questions.keys()][0]!)).toBe(false);
  });

  it("repairs LaTeX backslashes, raw line breaks, trailing commas and loose answers", () => {
    const body = '{"question": "Cos\'è \\frac{a}{b} con \\alpha e \\nabla?\n Scegli.", "options": ["A) \\theta", "B) \\beta",], "correct": "B", "explanation": "Riga\\nnuova"}';
    const [segment] = parseSmartText(`\`\`\`pyxis-check\n${body}\n\`\`\``);
    expect(segment?.type).toBe("block");
    const block = segment?.type === "block" ? segment.block : null;
    expect(block).toMatchObject({
      kind: "check",
      question: "Cos'è \\frac{a}{b} con \\alpha e \\nabla?\n Scegli.",
      explanation: "Riga\nnuova",
    });
    // The options are shown in a seeded order; the answer follows its option.
    if (block?.kind !== "check") throw new Error("not a check");
    expect([...block.options].sort()).toEqual(["\\beta", "\\theta"]);
    expect(block.options[block.answer]).toBe("\\beta");
    expect(parseLooseJson('{"a": "\\times \\rho \\ne \\nuovo"}')).toEqual({
      // \ne and \nuovo stay line breaks: only whole LaTeX names after \n count as commands.
      a: "\\times \\rho \ne \nuovo",
    });
  });

  it("drops invalid and unknown blocks instead of showing raw JSON", () => {
    const segments = parseSmartText(
      [
        "Testo.",
        "```pyxis-check",
        '{"question": "Senza opzioni"}',
        "```",
        "```pyxis-check",
        JSON.stringify({ ...check, answer: 7 }),
        "```",
        "```pyxis-chart",
        "{}",
        "```",
        "```pyxis-recap",
        "non è json",
        "```",
        "Fine.",
      ].join("\n"),
    );
    expect(segments).toEqual([
      { type: "markdown", text: "Testo." },
      { type: "markdown", text: "Fine." },
    ]);
  });

  it("keeps ordinary code, quoted fences and a Markdown worked example", () => {
    const segments = parseSmartText(
      [
        "````markdown",
        "```pyxis-check",
        "{}",
        "```",
        "````",
        "```pyxis-example",
        "Un carrello di $2$ kg accelera a $3\\,m/s^2$: $F=6$ N.",
        "```",
        "```pyxis-reveal",
        '{"term": "Newton", "definition": "Unità della forza: $1\\\\,N = 1\\\\,kg\\\\,m/s^2$."}',
        "```",
      ].join("\n"),
    );
    expect(segments[0]).toEqual({
      type: "markdown",
      text: "````markdown\n```pyxis-check\n{}\n```\n````",
    });
    expect(segments[1]).toMatchObject({
      type: "block",
      block: { kind: "example", body: "Un carrello di $2$ kg accelera a $3\\,m/s^2$: $F=6$ N." },
    });
    expect(segments[2]).toMatchObject({
      type: "block",
      block: { kind: "reveal", style: "term", front: "Newton" },
    });
  });

  it("shows a placeholder for a block still being streamed", () => {
    expect(
      parseSmartText('Intro.\n\n```pyxis-try\n{"prompt": "Calc', { streaming: true }),
    ).toEqual([
      { type: "markdown", text: "Intro." },
      { type: "pending", kind: "try" },
    ]);
    expect(parseSmartText('Intro.\n\n```pyxis-try\n{"prompt": "Calc')).toEqual([
      { type: "markdown", text: "Intro." },
    ]);
  });

  it("finds and replaces one ## section without touching the others", () => {
    const sections = smartSections(lesson);
    expect(sections.map((s) => s.title)).toEqual(["Seconda legge", "Ripasso"]);
    const next = replaceSection(lesson, 0, "## Seconda legge\n\nNuovo testo.");
    expect(next.startsWith("## Seconda legge\n\nNuovo testo.\n\n## Ripasso")).toBe(true);
    expect(next).toContain("```pyxis-recap");
    expect(() => replaceSection(lesson, 5, "x")).toThrow("section-missing");
  });

  it("writes blocks out with answers for export", () => {
    const text = smartTextToMarkdown(lesson, smartLabels.it);
    expect(text).toContain("**Verifica rapida.** Quanto vale $F$");
    // The options are shown in a seeded order; the stated answer is the letter of the right one.
    const letter = /^([A-C])\. \$6\$ N$/m.exec(text)?.[1];
    expect(letter).toBeTruthy();
    expect(text).toContain(`> Risposta: ${letter}. $6$ N`);
    expect(text).toContain("*Soluzione:*\n\n1. $a=F/m$\n2. $a=2$");
    expect(text).toContain("### Ripasso finale");
    expect(text).not.toContain("pyxis-");
  });

  describe("option order", () => {
    const many = (count: number) =>
      Array.from({ length: count }, (_, n) => ({
        question: `Domanda ${n}?`,
        options: ["giusta", "uno", "due", "tre"],
        answer: 0,
        explanation: "Perché.",
      }));
    const text = (questions: ReturnType<typeof many>) =>
      questions.map((q) => `\`\`\`pyxis-check\n${JSON.stringify(q)}\n\`\`\``).join("\n\n");
    const checks = (markdown: string, streaming = false) =>
      parseSmartText(markdown, { streaming }).flatMap((segment) =>
        segment.type === "block" && segment.block.kind === "check" ? [segment.block] : [],
      );

    it("rearranges each check without losing the right option", () => {
      const blocks = checks(text(many(30)));
      expect(blocks).toHaveLength(30);
      for (const block of blocks) {
        expect(block.options).toHaveLength(4);
        expect([...block.options].sort()).toEqual(["due", "giusta", "tre", "uno"]);
        expect(block.options[block.answer]).toBe("giusta");
        // order[i] is where shown option i sat in the model's text.
        expect(block.order.map((from) => ["giusta", "uno", "due", "tre"][from])).toEqual(block.options);
      }
      // A model that always writes the right option first does not get a right option that is always first.
      expect(new Set(blocks.map((block) => block.answer)).size).toBeGreaterThan(1);
    });

    it("keeps the same order on every parse, and ids that ignore the order", () => {
      const markdown = text(many(5));
      expect(checks(markdown)).toEqual(checks(markdown));
      const ids = checks(markdown).map((block) => block.id);
      expect(new Set(ids).size).toBe(5);
      // The id comes from what the model wrote, so a lesson answered before options were rearranged keeps its ids.
      expect(ids[0]).toBe(
        parseSmartText(text(many(1)))
          .flatMap((segment) => (segment.type === "block" ? [segment.block.id] : []))[0],
      );
    });

    it("gives a streamed prefix the ids, order and answer of the saved lesson", () => {
      const markdown = text(many(6));
      const saved = checks(markdown);
      // Cut inside the fifth block: four closed checks and a placeholder.
      const cut = markdown.indexOf("Domanda 4") + 5;
      const streamed = parseSmartText(markdown.slice(0, cut), { streaming: true });
      expect(streamed.at(-1)).toEqual({ type: "pending", kind: "check" });
      expect(checks(markdown.slice(0, cut), true)).toEqual(saved.slice(0, 4));
    });

    it("gives identical checks their own order and answers", () => {
      const same = text([many(1)[0]!, many(1)[0]!]);
      const [first, second] = checks(same);
      expect(first!.id).not.toBe(second!.id);
      expect(first!.options[first!.answer]).toBe("giusta");
      expect(second!.options[second!.answer]).toBe("giusta");
    });

    it("rearranges recap questions too, each on its own id", () => {
      const recap = parseSmartText(
        `\`\`\`pyxis-recap\n${JSON.stringify({ questions: many(5) })}\n\`\`\``,
      )[0];
      const questions = recap?.type === "block" && recap.block.kind === "recap" ? recap.block.questions : [];
      expect(questions).toHaveLength(5);
      for (const question of questions) expect(question.options[question.answer]).toBe("giusta");
      expect(new Set(questions.map((question) => question.answer)).size).toBeGreaterThan(1);
    });
  });

  it("strips passage references from old introductions", () => {
    expect(
      stripPassageRefs(
        "Partirai dalle misure. [01a110b2-3b89-7089-b52e-0855aadf1b56] Poi i vettori [P2] [01a110b2-3bc6-77ba-ba19-330c056ed84f].",
      ),
    ).toBe("Partirai dalle misure. Poi i vettori.");
  });

  it("splits grouped citations into single ones", () => {
    expect(splitCitationGroups("Vale F = ma [P1, P3] e anche [P2; 4], non [P5].")).toBe(
      "Vale F = ma [P1][P3] e anche [P2][P4], non [P5].",
    );
  });
});

describe("figure blocks", () => {
  const png =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  // As a model writes it: raw line breaks in the code string and a single backslash before a LaTeX command.
  const loose = [
    "```pyxis-figure",
    '{"caption": "Il vettore $\\vec F$", "code": "import numpy as np',
    'plt.quiver(0, 0, 1, 2)"}',
    "```",
  ].join("\n");

  it("parses a figure as a block and keys its image by the code alone", () => {
    const [block] = parseSmartText(loose).flatMap((segment) =>
      segment.type === "block" ? [segment.block] : [],
    );
    expect(block).toMatchObject({
      kind: "figure",
      caption: "Il vettore $\\vec F$",
      code: "import numpy as np\nplt.quiver(0, 0, 1, 2)",
    });
    const figure = parseFigure('{"title": "Altro titolo", "python": "import numpy as np\\nplt.quiver(0, 0, 1, 2)"}');
    expect(figureKey(figure!.code)).toBe(figureKey("import numpy as np\nplt.quiver(0, 0, 1, 2)"));
    expect(parseFigure('{"caption": "Senza codice"}')).toBeNull();
    expect(parseFigure(JSON.stringify({ caption: "Troppo", code: "x".repeat(FIGURE_CODE_MAX + 1) }))).toBeNull();
    expect(parseSmartText("```pyxis-figure\n{\"caption\": \"a\"", { streaming: true })).toEqual([
      { type: "pending", kind: "figure" },
    ]);
  });

  it("rewrites figure blocks outside other code and leaves one blank line where one is removed", () => {
    const quoted = ["````markdown", loose, "````"].join("\n");
    const text = ["Prima.", "", loose, "", "Dopo.", "", quoted].join("\n");
    expect(mapFigureBlocks(text, () => "")).toBe(["Prima.", "", "Dopo.", "", quoted].join("\n"));
    expect(mapFigureBlocks(text, (figure) => `*${figure!.caption}*`)).toBe(
      ["Prima.", "", "*Il vettore $\\vec F$*", "", "Dopo.", "", quoted].join("\n"),
    );
    expect(mapFigureBlocks(text, () => null)).toBe(text);
    expect(mapFigureBlocks("```pyxis-figure\n{broken", () => "")).toBe("```pyxis-figure\n{broken");
  });

  it("keeps only PNG data URLs under figure keys", () => {
    const key = figureKey("plt.plot([1, 2])");
    expect(
      figureImages({
        [key]: png,
        "figure-svg": "data:image/svg+xml;base64,PHN2Zy8+",
        "figure-script": "javascript:alert(1)",
        "not-a-key": png,
        "figure-big": `data:image/png;base64,${"A".repeat(FIGURE_IMAGE_MAX)}`,
      }),
    ).toEqual({ [key]: png });
    expect(figureImages(null)).toEqual({});
    expect(figureImages([png])).toEqual({});
  });

  it("exports a figure as its caption", () => {
    expect(smartTextToMarkdown(`Testo.\n\n${loose}`, smartLabels.it)).toBe(
      "Testo.\n\n*Figura: Il vettore $\\vec F$*",
    );
  });
});
