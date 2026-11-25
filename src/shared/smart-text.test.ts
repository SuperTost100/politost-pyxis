import { describe, expect, it } from "vitest";
import { parseMarkdown, walk } from "./markdown-tree";
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
  stripPassageRefsOutsideCode,
  writtenSections,
} from "./smart-text";
import { repairLatexInProse } from "./math-delimiters";

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

  it("keeps the id and option order of a block whose formulas open with a line break before e, u or i", () => {
    // Real line breaks inside the JSON strings, as a model writes them. The block is read as before, so an answer saved
    // under its id stays; only the drawing of its formulas changed, which keeps those line breaks.
    const body = '{"question": "Quale vale?", "options": ["$$\ne^{x}\n$$", "$$\nu(t)\n$$", "$$\ni_{k}\n$$"], "answer": 1, "explanation": "Quindi\n$$\nu(t)=e^{t}\n$$"}';
    const [segment] = parseSmartText(`\`\`\`pyxis-check\n${body}\n\`\`\``);
    if (segment?.type !== "block" || segment.block.kind !== "check") throw new Error("not a check");
    // The id, order and answer 0.5.0-dev.13 gave this block.
    expect(segment.block).toMatchObject({ id: "check-o49o0rs94p", order: [1, 0, 2], answer: 0 });
    for (const text of [...segment.block.options, segment.block.explanation!]) expect(repairLatexInProse(text)).toBe(text);
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

  it("reads a lesson still being written one finished section at a time", () => {
    // Nothing is readable before the first heading, and the first section is not done until the second begins.
    expect(writtenSections("")).toEqual({ done: "", writing: null });
    expect(writtenSections("Premessa senza titolo.")).toEqual({ done: "", writing: null });
    expect(writtenSections("Premessa.\n\n## Prima idea\n\nUna for")).toEqual({
      done: "",
      writing: { number: 1, title: "Prima idea" },
    });
    // The next heading finishes the first section; the section after it is the one being written.
    const partial = `${lesson.split("## Ripasso")[0]}## Ripasso\n\n\`\`\`pyxis-recap\n{"questions": [`;
    const read = writtenSections(partial);
    expect(read.writing).toEqual({ number: 2, title: "Ripasso" });
    expect(read.done.startsWith("## Seconda legge")).toBe(true);
    expect(read.done).toContain("```pyxis-check");
    expect(read.done).not.toContain("Ripasso");
    // The finished part parses to the same blocks, with the same ids, as in the whole lesson.
    const ids = (text: string) =>
      parseSmartText(text).flatMap((segment) => (segment.type === "block" ? [segment.block.id] : []));
    expect(ids(lesson).slice(0, ids(read.done).length)).toEqual(ids(read.done));
    // A heading inside a code fence is not a section.
    expect(writtenSections("## Uno\n\n```python\n## commento\n```\n\n## Due\n\nx")).toMatchObject({
      writing: { number: 2, title: "Due" },
    });
    // The whole lesson ends with every section but the last one done: the page shows the saved text then.
    expect(writtenSections(lesson).writing).toEqual({ number: 2, title: "Ripasso" });
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

  it("leaves code alone when it strips markers: indentation, spaces before a colon and a literal [P1]", () => {
    const code = "```python\nrows = (data\n    .map(f)\n    .filter(g))\nx : int = lst[P1]\n```";
    expect(stripPassageRefsOutsideCode(`Vedi [P1] .\n\n${code}\n\nUsa \`a : b[P2]\` ora [P3] .`)).toBe(
      `Vedi.\n\n${code}\n\nUsa \`a : b[P2]\` ora.`,
    );
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

  it("reads a tab, a form feed or a return in a figure's code as the character it is, not as a LaTeX command", () => {
    // Written by the app, as JSON: the tab before `plt` is `\\t`, which a LaTeX repair would read as `\\tplt`.
    const code = "if True:\n\tplt.plot([1])\n\tplt.title('tab')\r\n\fplt.show()";
    const block = JSON.stringify({ caption: "Una linea", code });
    expect(parseFigure(block)?.code).toBe(code);
    expect(figureKey(parseFigure(block)!.code)).toBe(figureKey(code));
    // The caption is prose: a single backslash before a LaTeX command in it is still repaired.
    expect(parseFigure('{"caption": "L\'angolo $\\theta$", "code": "x = 1\\n\\tplt.plot([1])"}')).toMatchObject({
      caption: "L'angolo $\\theta$",
    });
    const [segment] = parseSmartText(["```pyxis-figure", block, "```"].join("\n")).flatMap((part) => (part.type === "block" ? [part.block] : []));
    expect(segment).toMatchObject({ kind: "figure", code });
  });

  it("reads a figure's code as code when its key is written with an escape, as JSON reads the key", () => {
    // JSON decodes "c\u006fde" to `code`, so the value under it is the code, and its tab is a tab.
    const code = "if True:\n\tplt.plot([1])";
    for (const key of ["c\\u006fde", "\\u0063ode", "p\\u0079thon", "so\\u0075rce"])
      expect(parseFigure(`{"caption":"x","${key}":"if True:\\n\\tplt.plot([1])"}`)?.code, key).toBe(code);
    // The key keeps the spelling it was written with in the repaired text, which is still the same JSON.
    expect(parseLooseJson('{"c\\u006fde":"a\\tb"}', ["code"])).toEqual({ code: "a\tb" });
  });

  it("compares a key as the repaired text writes it, which is the key the output has", () => {
    // `\\u0063ode` is the escaped pair `\\` and then `u0063ode`: the key is those literal characters, and is not `code`, so its
    // value is prose and `\nabla` in it stays a LaTeX command.
    expect(parseLooseJson(String.raw`{"\\u0063ode":"\nabla"}`, ["code"])).toEqual({ [String.raw`\u0063ode`]: String.raw`\nabla` });
    // A key that the repair writes as `\nabla` (a LaTeX command, not a newline) is that key, and a verbatim name that spells
    // it matches: its value is read as JSON says, so the tab is a tab.
    expect(parseLooseJson(String.raw`{"\nabla":"a\tb"}`, [String.raw`\nabla`])).toEqual({ [String.raw`\nabla`]: "a\tb" });
    // And the key that is `code` once decoded still matches, as before.
    expect(parseLooseJson(String.raw`{"c\u006fde":"a\tb"}`, ["code"])).toEqual({ code: "a\tb" });
  });

  it("keeps a block without a kind a plot under the key it had before figures had kinds", () => {
    const old = parseFigure('{"caption": "Una parabola", "code": "  x = np.linspace(-2, 2)\\nplt.plot(x, x**2)\\n"}');
    expect(old).toEqual({
      caption: "Una parabola",
      code: "x = np.linspace(-2, 2)\nplt.plot(x, x**2)",
      figureKind: "plot",
    });
    // The keys of images stored by earlier versions, written out so a change to the hash or its input shows here.
    expect(figureKey(old!.code, old!.figureKind)).toBe("figure-26u91xjajpr");
    expect(figureKey("  x = np.linspace(-2, 2)\nplt.plot(x, x**2)\n")).toBe("figure-26u91xjajpr");
    expect(figureKey("plt.plot([1, 2])")).toBe("figure-2dhfyi0ovmd");
    expect(figureKey("plt.plot([1, 2])", "plot")).toBe("figure-2dhfyi0ovmd");
  });

  it("reads the kind of a figure, keys its image by kind and code, and drops a kind it does not know", () => {
    const code = "d += elm.Resistor().right().label('R1')";
    const circuit = parseFigure(JSON.stringify({ kind: " Circuit ", title: "Un resistore", source: code }));
    expect(circuit).toEqual({ caption: "Un resistore", code, figureKind: "circuit" });
    expect(parseFigure(JSON.stringify({ kind: "plot", caption: "a", code }))!.figureKind).toBe("plot");
    expect(figureKey(code, "circuit")).toMatch(/^figure-[0-9a-z]{1,16}$/);
    expect(figureKey(code, "circuit")).not.toBe(figureKey(code));
    expect(figureKey(`  ${code}\n`, "circuit")).toBe(figureKey(code, "circuit"));
    // A kind from a later Pyxis, or one the model made up, is not a figure here: it is not run as a plot.
    expect(parseFigure(JSON.stringify({ kind: "molecule", caption: "Etanolo", code: "CCO" }))).toBeNull();
    const [block] = parseSmartText(
      ["```pyxis-figure", JSON.stringify({ kind: "circuit", caption: "Un resistore", code }), "```"].join("\n"),
    ).flatMap((segment) => (segment.type === "block" ? [segment.block] : []));
    expect(block).toMatchObject({ kind: "figure", figureKind: "circuit", code });
  });

  it("stores code written as a JSON object as compact JSON with sorted keys", () => {
    const spec = { signal: [{ wave: "p...", name: "clk" }], config: { hscale: 2 } };
    const figure = parseFigure(JSON.stringify({ caption: "Un clock", code: spec }));
    expect(figure!.code).toBe('{"config":{"hscale":2},"signal":[{"name":"clk","wave":"p..."}]}');
    // The same spec with its keys in another order is the same figure.
    const reordered = { config: { hscale: 2 }, signal: [{ name: "clk", wave: "p..." }] };
    expect(parseFigure(JSON.stringify({ caption: "Un clock", code: reordered }))!.code).toBe(figure!.code);
    expect(parseFigure(JSON.stringify({ caption: "Vuoto", code: {} }))!.code).toBe("{}");
    expect(parseFigure(JSON.stringify({ caption: "Troppo", code: { x: "y".repeat(FIGURE_CODE_MAX) } }))).toBeNull();
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

  it("leaves a figure example in a tilde fence whose line of tildes and a backtick does not close it", () => {
    const figure = JSON.stringify({ kind: "plot", caption: "Esempio", code: "plt.plot([0, 1])" });
    const text = ["~~~markdown", "~~~`", "```pyxis-figure", figure, "```", "~~~"].join("\n");
    expect(mapFigureBlocks(text, () => "")).toBe(text);
  });

  it("leaves a figure block indented as code outside a list as the code example it is", () => {
    const figure = JSON.stringify({ kind: "plot", caption: "Esempio", code: "plt.plot([0, 1])" });
    const text = ["Un esempio:", "", "    ```pyxis-figure", `    ${figure}`, "    ```", "", "Fine."].join("\n");
    expect(mapFigureBlocks(text, () => "")).toBe(text);
    expect(mapFigureBlocks(text, () => null)).toBe(text);
  });

  it.each(["  ", "   ", "    ", "      ", "\t"])("finds a figure block inside a list item with %j before its fences", (indent) => {
    // Gemini put a chat answer's figure inside the numbered step it illustrates.
    const figure = JSON.stringify({ kind: "plot", caption: "Il piano inclinato", code: "plt.plot([0, 1], [0, 1])" });
    for (const marker of ["1.", "-"]) {
      const text = [`${marker} Primo passo.`, "", `${indent}\`\`\`pyxis-figure`, `${indent}${figure}`, `${indent}\`\`\``, "", `${marker} Dopo.`].join("\n");
      expect(mapFigureBlocks(text, (found) => `*${found!.caption}*`), marker).not.toContain("pyxis-figure");
      // A block that is kept is one the parser reads as a figure block, in the list item.
      const kept = mapFigureBlocks(text, () => null);
      const blocks: Array<{ lang: string | null | undefined; value: string | undefined }> = [];
      walk(parseMarkdown(kept), (node) => {
        if (node.type === "code") blocks.push({ lang: node.lang, value: node.value });
      });
      expect(blocks, `${marker} ${JSON.stringify(indent)}`).toEqual([{ lang: "pyxis-figure", value: figure }]);
    }
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
