import { describe, expect, it } from "vitest";
import { repairLatexEscapes, repairLatexOutsideCode, repairModelStrings } from "./latex-repair";

// In these strings "\v", "\t", "\f", "\b", "\r" and "\n" are the control characters a model's single backslash became.
describe("repairLatexEscapes", () => {
  it("restores the commands a single backslash in JSON turned into control characters", () => {
    expect(repairLatexEscapes("$m\vec{g}\\sin\theta + \frac{a}{b} + \beta$")).toBe(
      "$m\\vec{g}\\sin\\theta + \\frac{a}{b} + \\beta$",
    );
  });

  it("restores \\right and \\times", () => {
    expect(repairLatexEscapes("$\\left(x\right) \times 2$")).toBe("$\\left(x\\right) \\times 2$");
  });

  it("restores \\nu and \\neq inside math but keeps a real line break before text", () => {
    expect(repairLatexEscapes("$a\neq b$ e $\nu$")).toBe("$a\\neq b$ e $\\nu$");
    expect(repairLatexEscapes("Prima riga.\nnuova riga, poi $x$.")).toBe("Prima riga.\nnuova riga, poi $x$.");
    expect(repairLatexEscapes("Riga uno\nnot a formula")).toBe("Riga uno\nnot a formula");
  });

  it("repairs a command at the start of a line inside a display formula, and keeps indentation outside one", () => {
    expect(repairLatexEscapes("$$\n\theta = \\text{x}\n$$")).toBe("$$\n\\theta = \\text{x}\n$$");
    expect(repairLatexEscapes("Riga\n\ttext")).toBe("Riga\n\ttext");
  });

  it("keeps a Windows line end inside display math, even when the next word is a command name", () => {
    const text = "$$\r\ne = mc^2\r\nu = v\r\n$$";
    expect(repairLatexEscapes(text)).toBe(text);
  });

  it("does not take the start of a chunk for the start of a line when told it is not one", () => {
    expect(repairLatexEscapes("\theta", false)).toBe("\\theta");
    expect(repairLatexEscapes("\ttext", true)).toBe("\ttext");
  });

  it("keeps real tabs, newlines and Windows line ends", () => {
    const text = "a\tb\nc\r\nd\n\ttext";
    expect(repairLatexEscapes(text)).toBe(text);
  });

  it("leaves a correct string alone", () => {
    const text = "$\\frac{1}{2}\\theta$ e \\(x\\)";
    expect(repairLatexEscapes(text)).toBe(text);
  });
});

describe("a backslash written twice", () => {
  // A structured answer is already decoded, so the "\\\\vec" the prompt asks for in JSON stays as two backslashes.
  it("goes back to one before a command inside a formula, so KaTeX does not break the line there", () => {
    expect(repairLatexEscapes("$\\\\vec{A}\\\\cdot\\\\vec{B} = |\\\\vec{A}||\\\\vec{B}|\\\\cos\\\\theta$")).toBe(
      "$\\vec{A}\\cdot\\vec{B} = |\\vec{A}||\\vec{B}|\\cos\\theta$",
    );
    expect(repairLatexEscapes("$$\\\\sqrt{a_x^2 + a_y^2}\\\\hat{u}$$")).toBe("$$\\sqrt{a_x^2 + a_y^2}\\hat{u}$$");
  });

  it("keeps a real line break in a formula, with or without a command after it", () => {
    for (const text of ["$$a = b \\\\ c = d$$", "$$a = b\\\\\n c = d$$", "$$a\\\\\\vec{b}$$", "$a\\\\x$", "$$a\\\\[2pt] b$$"]) {
      expect(repairLatexEscapes(text)).toBe(text);
    }
  });

  it("leaves two backslashes in prose alone", () => {
    expect(repairLatexEscapes("C:\\\\cdot\\\\file")).toBe("C:\\\\cdot\\\\file");
  });

  it("is repaired in every string of a structured answer, matching pairs included", () => {
    const question = { kind: "matching", left: ["$\\\\vec{a}\\\\times\\\\vec{b}$"], pairs: [["$\\\\hat{u}$", "$\\\\sqrt{a}$"]] };
    expect(repairModelStrings(question)).toEqual({
      kind: "matching",
      left: ["$\\vec{a}\\times\\vec{b}$"],
      pairs: [["$\\hat{u}$", "$\\sqrt{a}$"]],
    });
  });
});

describe("a line break written as \\n", () => {
  it("becomes a real line break, so a question's parts are on their own lines", () => {
    expect(repairLatexEscapes("Dati i vettori (1, 2) e (3, −2).\\na) Calcolare il prodotto.\\nb) Il modulo.")).toBe(
      "Dati i vettori (1, 2) e (3, −2).\na) Calcolare il prodotto.\nb) Il modulo.",
    );
    expect(repairLatexEscapes("Prima.\\nNuova riga e poi \\nuovo punto")).toBe("Prima.\nNuova riga e poi \nuovo punto");
  });

  it("reads \\ne) and \\nu) at the start of a list item as a line break outside a formula", () => {
    expect(repairLatexEscapes("d) Il lavoro.\\ne) La forza.\\nu) Altro")).toBe("d) Il lavoro.\ne) La forza.\nu) Altro");
  });

  it("keeps the LaTeX commands that start with n", () => {
    const text = "$\\nabla f \\neq 0$, $\\nu$ e $a \\ne b$ e $\\not\\in A$ e $\\neg p$ e $A \\nsubseteq B$";
    expect(repairLatexEscapes(text)).toBe(text);
  });

  it("keeps a matrix row break that is followed by an n", () => {
    expect(repairLatexEscapes("$$a \\\\n$$")).toBe("$$a \\\\n$$");
  });

  it("leaves code as written", () => {
    expect(repairLatexOutsideCode("`print('a\\nb')` e\\nfine")).toBe("`print('a\\nb')` e\nfine");
  });
});

describe("repairModelStrings and code", () => {
  it("leaves fenced and inline code as the model wrote it", () => {
    const code = { prompt: "```\na\times b\n```\ne `c\times d` e $\theta$" };
    expect(repairModelStrings(code)).toEqual({ prompt: "```\na\times b\n```\ne `c\times d` e $\\theta$" });
  });

  it("repairs prose that starts in the middle of a line after inline code", () => {
    expect(repairModelStrings(["`x`\theta"])).toEqual(["`x`\\theta"]);
  });
});

describe("repairModelStrings", () => {
  it("repairs every string in a nested value and keeps the rest", () => {
    expect(
      repairModelStrings({ stem: "$\theta$", options: ["$\frac{1}{2}$", "x"], n: 3, ok: true, none: null }),
    ).toEqual({ stem: "$\\theta$", options: ["$\\frac{1}{2}$", "x"], n: 3, ok: true, none: null });
  });
});
