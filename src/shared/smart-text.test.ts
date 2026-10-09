import { describe, expect, it } from "vitest";
import {
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
      options: ["\\theta", "\\beta"],
      answer: 1,
      explanation: "Riga\nnuova",
    });
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
    expect(text).toContain("B. $6$ N");
    expect(text).toContain("> Risposta: B. $6$ N");
    expect(text).toContain("*Soluzione:*\n\n1. $a=F/m$\n2. $a=2$");
    expect(text).toContain("### Ripasso finale");
    expect(text).not.toContain("pyxis-");
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
