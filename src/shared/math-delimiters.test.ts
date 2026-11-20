import { describe, expect, it } from "vitest";
import { displayMathLines, hasFormula, holdOpenMath, normalizeMathDelimiters } from "./math-delimiters";

describe("normalizeMathDelimiters and control characters", () => {
  it("restores LaTeX commands in prose but leaves code as written", () => {
    expect(normalizeMathDelimiters("Vale $\\theta\theta$ qui")).toBe("Vale $\\theta\\theta$ qui");
    const code = "```\na\times b\nprice $ 5\nnot_found\n```";
    expect(normalizeMathDelimiters(code)).toBe(code);
    const inline = "uso `a\times b` e $\theta$";
    expect(normalizeMathDelimiters(inline)).toBe("uso `a\times b` e $\\theta$");
  });
});

describe("normalizeMathDelimiters and empty fences", () => {
  it("sees an empty fenced block as closed, so the prose after it is still normalized", () => {
    expect(normalizeMathDelimiters("```\n```\nVale \\(x\\) qui")).toBe("```\n```\nVale $x$ qui");
    expect(normalizeMathDelimiters("~~~\n~~~\nVale \\(x\\) qui")).toBe("~~~\n~~~\nVale $x$ qui");
    // A fence with one line of code still closes, and a fence that never closes runs to the end.
    expect(normalizeMathDelimiters("```\ncode \\(x\\)\n```\n\\(y\\)")).toBe("```\ncode \\(x\\)\n```\n$y$");
    expect(normalizeMathDelimiters("```\ncode \\(x\\)")).toBe("```\ncode \\(x\\)");
  });
});

describe("normalizeMathDelimiters and Windows line ends", () => {
  it("sees a fenced block as closed when its lines end in CRLF, so the prose after it is still normalized", () => {
    expect(normalizeMathDelimiters("```\r\ncode \\(x\\)\r\n```\r\n\\(y\\)")).toBe("```\r\ncode \\(x\\)\r\n```\r\n$y$");
    expect(normalizeMathDelimiters("~~~\r\n~~~\r\n\\(y\\)")).toBe("~~~\r\n~~~\r\n$y$");
    expect(normalizeMathDelimiters("```python\r\ncode\r\n```  \r\n\\(y\\)")).toBe("```python\r\ncode\r\n```  \r\n$y$");
  });
});

describe("normalizeMathDelimiters and backslash delimiters", () => {
  it("repairs a command inside \\( … \\) and \\[ … \\] math", () => {
    expect(normalizeMathDelimiters("\\(a\neq b\\)")).toBe("$a\\neq b$");
    expect(normalizeMathDelimiters("\\[x\nu\\]")).toBe("\n$$\nx\\nu\n$$\n");
  });

  it("repairs a command right after inline code, where the chunk starts mid-line", () => {
    expect(normalizeMathDelimiters("uso `x`\theta qui")).toBe("uso `x`\\theta qui");
  });
});

describe("normalizeMathDelimiters", () => {
  it("converts inline \\( \\) to dollar math", () => {
    expect(normalizeMathDelimiters("a \\(x^2\\) b")).toBe("a $x^2$ b");
  });

  it("converts display \\[ \\] to a block equation", () => {
    expect(normalizeMathDelimiters("before\\[\\sum_i x_i\\]after")).toBe(
      "before\n$$\n\\sum_i x_i\n$$\nafter",
    );
  });

  it("leaves existing dollar delimiters alone", () => {
    const s = "inline $a$ and $$b$$";
    expect(normalizeMathDelimiters(s)).toBe(s);
  });

  it("handles all four styles in one document", () => {
    const input = [
      "Inline paren \\(E=mc^2\\)",
      "Display paren \\[\\int_0^1 t\\,dt\\]",
      "Inline dollar $x$",
      "Display dollar $$y$$",
    ].join("\n");
    const out = normalizeMathDelimiters(input);
    expect(out).toContain("$E=mc^2$");
    expect(out).toContain("$$\n\\int_0^1 t\\,dt\n$$");
    expect(out).toContain("Inline dollar $x$");
    expect(out).toContain("Display dollar $$y$$");
  });

  it("leaves delimiters inside code alone", () => {
    const fenced = "```python\nprint('[P1]')\nprint(r'\\[x\\]')\n```";
    expect(normalizeMathDelimiters(fenced)).toBe(fenced);
    const tilde = "~~~\n[P1]\n\\[x\\]\n~~~";
    expect(normalizeMathDelimiters(tilde)).toBe(tilde);
    const wider = "````\n[P1]\n````";
    expect(normalizeMathDelimiters(wider)).toBe(wider);
    const longerClose = "```\n[P1]\n````\n\\(x\\)";
    expect(normalizeMathDelimiters(longerClose)).toContain("$x$");
    expect(normalizeMathDelimiters(longerClose)).toContain("```\n[P1]\n````");
  });
});

describe("displayMathLines", () => {
  it("moves a lone $$ … $$ line onto lines of its own", () => {
    expect(displayMathLines("Testo\n\n$$ F = ma $$\n\nAltro")).toBe("Testo\n\n$$\nF = ma\n$$\n\nAltro");
    expect(displayMathLines("1. Passo\n   $$x^2$$")).toBe("1. Passo\n   $$\n   x^2\n   $$");
  });

  it("leaves inline, block and fenced math alone", () => {
    const inline = "La legge $$F=ma$$ dice";
    expect(displayMathLines(inline)).toBe(inline);
    const block = "$$\nF = ma\n$$";
    expect(displayMathLines(block)).toBe(block);
    const two = "$$a$$ e $$b$$";
    expect(displayMathLines(two)).toBe(two);
    const fenced = "```\n$$x$$\n```";
    expect(displayMathLines(fenced)).toBe(fenced);
  });

  it("leaves a formula that shares its line with inline code", () => {
    const after = "`code` $$x^2$$";
    expect(displayMathLines(after)).toBe(after);
    const before = "$$x^2$$ `code`";
    expect(displayMathLines(before)).toBe(before);
    const both = "`a` $$x^2$$ `b`";
    expect(displayMathLines(both)).toBe(both);
    expect(displayMathLines("`code`\n$$x^2$$")).toBe("`code`\n$$\nx^2\n$$");
  });
});

describe("bold markers inside math", () => {
  it("turns ** inside a formula into \\mathbf instead of two asterisk glyphs", () => {
    expect(normalizeMathDelimiters("$a \\subset **b** \\subset **c**$")).toBe(
      "$a \\subset \\mathbf{b} \\subset \\mathbf{c}$",
    );
    expect(normalizeMathDelimiters("$$\nx **y**\n$$")).toBe("$$\nx \\mathbf{y}\n$$");
  });

  it("leaves bold around a formula, bold in prose, spaced ** and code alone", () => {
    for (const same of [
      "**$x^2$** e **non** $y$",
      "$f ** g$ e $a$ ** $b$",
      "`$a **b** c$`",
      "```\n$a **b** c$\n```",
      "costa \\$5 e **forte** \\$6",
    ])
      expect(normalizeMathDelimiters(same)).toBe(same);
  });
});

describe("hasFormula", () => {
  it("sees a formula in every delimiter the app renders", () => {
    for (const face of ["Se $x < x_0$ allora", "Sono $ C_nH_{2n+2} $", "Vale \\(x^2\\) qui", "Vale\n\\[x^2\\]\nqui", "$$x^2$$"])
      expect(hasFormula(face)).toBe(true);
  });

  it("sees none in plain text, a lone dollar sign or code", () => {
    for (const face of ["Nessuna formula", "Un solo $ qui", "`$a$`"])
      expect(hasFormula(face)).toBe(false);
  });
});

// Recorded answers of the four AI tools (2026-11-19) that drew an error, with the sentence each one came from.
describe("a dollar sign written inside a formula", () => {
  it("is a \\char36{}, because remark-math would end the formula at its $ (Claude, in $…$)", () => {
    expect(normalizeMathDelimiters("4. costo totale: $C_{\\text{tot}} = 25\\ \\$ + C_{\\text{gas}}$.")).toBe(
      "4. costo totale: $C_{\\text{tot}} = 25\\ \\char36{} + C_{\\text{gas}}$.",
    );
  });

  it("when the dollar comes last in the formula (Gemini, in $…$)", () => {
    expect(normalizeMathDelimiters("il costo della bombola di $25\\$$ e il riempimento al $90\\%$")).toBe(
      "il costo della bombola di $25\\char36{}$ e il riempimento al $90\\%$",
    );
  });

  it("in \\( … \\), which becomes $ … $ (ChatGPT)", () => {
    expect(normalizeMathDelimiters("una bombola da \\(25\\ \\$\\) riempita al \\(90\\%\\)")).toBe(
      "una bombola da $25\\ \\char36{}$ riempita al $90\\%$",
    );
    expect(normalizeMathDelimiters("costa \\(\\boxed{\\$22{,}50}\\).")).toBe("costa $\\boxed{\\char36{}22{,}50}$.");
  });

  it("in a display formula", () => {
    // The block closes at its own `$$` line, and KaTeX draws `\$` there, so it is left as it is.
    expect(normalizeMathDelimiters("$$\nprezzo = 25\\ \\$\n$$")).toBe("$$\nprezzo = 25\\ \\$\n$$");
  });

  it("but not in prose, in code or beside a formula", () => {
    for (const same of [
      "il prezzo è \\$25, ma lo riempio al 90 %",
      "costa \\$5 e \\$6, con $x$ dopo",
      "`$a \\$ b$` e \\$7",
      "```\nprice = \\$5 + $x\\$ y$\n```",
      "una sola $ qui, e 25 $ là",
    ])
      expect(normalizeMathDelimiters(same)).toBe(same);
  });
});

describe("a display formula whose first or last line shares its $$ line", () => {
  // Codex, a lesson part: the first line after `$$` is lost and the block never closes, so every $ after it pairs wrongly.
  const recorded =
    "Instantaneous velocity and acceleration:\n\n$$\\bar{\\vec v}=\\frac{\\Delta\\vec r}{\\Delta t},\n\\qquad\n\\vec v=\\frac{d\\vec r}{dt},\n\\qquad\n\\vec a=\\frac{d^2\\vec r}{dt^2}.$$\n\nWhen acceleration $a$ is constant,\n\n$$x=x_0+v_0t+\\frac12at^2.$$";

  it("moves both delimiters onto lines of their own", () => {
    expect(displayMathLines(recorded)).toBe(
      "Instantaneous velocity and acceleration:\n\n$$\n\\bar{\\vec v}=\\frac{\\Delta\\vec r}{\\Delta t},\n\\qquad\n\\vec v=\\frac{d\\vec r}{dt},\n\\qquad\n\\vec a=\\frac{d^2\\vec r}{dt^2}.\n$$\n\nWhen acceleration $a$ is constant,\n\n$$\nx=x_0+v_0t+\\frac12at^2.\n$$",
    );
  });

  it("opens on its own line but closes after the formula, or the other way round", () => {
    expect(displayMathLines("$$\na,\nb$$")).toBe("$$\na,\nb\n$$");
    expect(displayMathLines("$$a,\nb\n$$")).toBe("$$\na,\nb\n$$");
  });

  it("leaves two formulas on one line, a block already closed, and a $$ with no end alone", () => {
    for (const same of ["$$a$$ e $$b$$", "$$\na\nb\n$$", "$$ non si chiude\n\nAltro testo", "$$a\n\nb$$"])
      expect(displayMathLines(same)).toBe(same);
  });
});

describe("holdOpenMath", () => {
  it("turns a formula whose closing delimiter has not arrived into a placeholder link", () => {
    expect(holdOpenMath("Dati: $m = 2\\ \\te")).toBe("Dati: […](pyxis-math:inline:10)");
    expect(holdOpenMath("Dati: \\(m = 2")).toBe("Dati: […](pyxis-math:inline:5)");
    expect(holdOpenMath("Dati:\n\n$$\nm\\ddot{x} + b\\dot{")).toBe("Dati:\n\n[…](pyxis-math:display:19)");
    expect(holdOpenMath("Dati:\n\\[\nm\\ddot")).toBe("Dati:\n[…](pyxis-math:display:7)");
  });

  it("holds a double dollar sign that ends the text, and leaves a single one, which may be a price", () => {
    expect(holdOpenMath("Dati: $")).toBe("Dati: $");
    expect(holdOpenMath("Dati: $$")).toBe("Dati: \n\n[…](pyxis-math:display:0)");
  });

  it("keeps the formulas that closed and puts a display formula on a line of its own", () => {
    expect(holdOpenMath("Con $a$ e $b$ poi $$x +")).toBe("Con $a$ e $b$ poi \n\n[…](pyxis-math:display:3)");
    expect(holdOpenMath("Vale $x$ e \\(y\\) e $$z$$.")).toBe("Vale $x$ e \\(y\\) e $$z$$.");
  });

  it("leaves a dollar sign that cannot open a formula, an escaped one and code alone", () => {
    for (const same of [
      "Costa 25 $ e basta",
      "Costa \\$25 e \\$30",
      "Un $ in fondo\n\nAltro paragrafo",
      "```\n$m = 2",
      "uso `$m = 2` qui",
    ])
      expect(holdOpenMath(same)).toBe(same);
  });

  it("holds a chemical equation alone on the last line until its brace closes", () => {
    expect(holdOpenMath("La reazione è:\n\n\\ce{C3H8 + 5O2 -> 3CO2 + 4H2")).toBe("La reazione è:\n\n[…](pyxis-math:display:28)");
    const done = "La reazione è:\n\n\\ce{C3H8 + 5O2 -> 3CO2 + 4H2O}";
    expect(holdOpenMath(done)).toBe(done);
    expect(holdOpenMath("Vale \\ce{H2")).toBe("Vale \\ce{H2");
  });

  it("does not let a dollar sign in an earlier paragraph hold the last one", () => {
    expect(holdOpenMath("Costa $25 oggi\n\nPoi $x = ")).toBe("Costa $25 oggi\n\nPoi […](pyxis-math:inline:4)");
  });
});

// Recorded answers (2026-11-19) whose formula was never drawn as one.
describe("a chemical equation alone in a code fence", () => {
  // Claude Haiku, a chat answer in Italian.
  const recorded = "### Reazione bilanciata\n\n```\n\\ce{C3H8 + 5O2 -> 3CO2 + 4H2O}\n```\n\nIl bilanciamento: 3 C e 8 H.";

  it("is a display formula", () => {
    expect(normalizeMathDelimiters(recorded)).toBe(
      "### Reazione bilanciata\n\n$$\n\\ce{C3H8 + 5O2 -> 3CO2 + 4H2O}\n$$\n\nIl bilanciamento: 3 C e 8 H.",
    );
    expect(normalizeMathDelimiters("```latex\n\\ce{H2O}\n```")).toBe("$$\n\\ce{H2O}\n$$");
  });

  it("leaves other code blocks alone", () => {
    for (const same of [
      "```\nprint(1)\n```",
      "```python\n\\ce{H2O}\n```",
      "```\n\\ce{H2O}\nmore\n```",
      "uso `\\ce{H2O}` qui",
    ])
      expect(normalizeMathDelimiters(same)).toBe(same);
  });
});

describe("a text that is a formula with no delimiter", () => {
  // Gemini Pro, the answer of a worked example in a lesson part.
  it("is wrapped in dollars", () => {
    expect(normalizeMathDelimiters("\\vec{v}_1 = \\frac{1}{\\sqrt{2}}\\begin{pmatrix} 1 \\\\ -1 \\end{pmatrix}")).toBe(
      "$\\vec{v}_1 = \\frac{1}{\\sqrt{2}}\\begin{pmatrix} 1 \\\\ -1 \\end{pmatrix}$",
    );
  });

  it("leaves prose, a text that has delimiters and code alone", () => {
    for (const same of [
      "Il vettore è \\vec{v}",
      "\\vec{v} e $x$",
      "\\* un asterisco",
      "`\\vec{v}`",
      "\\vec{v}\n\nPoi altro",
      "\\textbf{Nota:} il valore resta lo stesso in tutti i casi",
    ])
      expect(normalizeMathDelimiters(same)).toBe(same);
  });
});

describe("prices escaped one after another", () => {
  it("are all escaped in a long answer, past any fixed number of rounds", () => {
    const text = Array.from({ length: 41 }, () => "Costa 12 $ oppure 15 $.").join("\n\n");
    expect(normalizeMathDelimiters(text)).toBe(Array.from({ length: 41 }, () => "Costa 12 \\$ oppure 15 $.").join("\n\n"));
  });

  it("leave a formula that starts with a number and closes like a formula", () => {
    expect(normalizeMathDelimiters("Costa 12 $ e il risultato è $2 ab!$.")).toBe("Costa 12 \\$ e il risultato è $2 ab!$.");
  });
});

describe("a price in prose beside \\( … \\) formulas", () => {
  // Cursor (Grok), a chat answer in Italian: the price's `$` paired with the `$` of the converted formula.
  const recorded =
    "# Bombola a 25 $ riempita al 90 %\n\nCon soli “25 $” e “90 %” non si può chiudere un calcolo. Se mi dici volume e cosa ti serve (costo per mole di \\(\\ce{CO2}\\), contenuto netto, ecc.), lo risolvo.";

  it("is a plain dollar sign, so the formula after it is a formula", () => {
    expect(normalizeMathDelimiters(recorded)).toBe(
      "# Bombola a 25 $ riempita al 90 %\n\nCon soli “25 \\$” e “90 %” non si può chiudere un calcolo. Se mi dici volume e cosa ti serve (costo per mole di $\\ce{CO2}$, contenuto netto, ecc.), lo risolvo.",
    );
  });

  it("changes nothing without a \\( or \\[ formula in the text", () => {
    expect(normalizeMathDelimiters("Con soli “25 $” e “90 %”, né $x$ né altro")).toBe("Con soli “25 $” e “90 %”, né $x$ né altro");
  });

  it("keeps a dollar sign that opens a formula, and one already escaped", () => {
    expect(normalizeMathDelimiters("Vale $a$ e \\(b\\), costa \\$5")).toBe("Vale $a$ e $b$, costa \\$5");
  });
});

describe("a \\( that never closes", () => {
  // Cursor (Grok), a chat answer: `\\(25\\,\\$$` was typed for `\\(25\\,\\$\\)`, and the next `\\)` was three paragraphs away.
  it("stays in its paragraph, so the formulas after it are still formulas", () => {
    const recorded = "Se il prezzo di \\(25\\,\\$$ è completo:\n\n\\[\nx = 1\n\\]\n\nNon si possono convertire in moli di \\(\\ce{CO2}\\).";
    expect(normalizeMathDelimiters(recorded)).toBe(
      "Se il prezzo di \\(25\\,\\$$ è completo:\n\n\n$$\nx = 1\n$$\n\n\nNon si possono convertire in moli di $\\ce{CO2}$.",
    );
  });
});

describe("a chemical equation alone on a line, with no delimiter", () => {
  // Claude Haiku, a chat answer, seen while it streamed.
  it("is a display formula", () => {
    expect(normalizeMathDelimiters("La reazione bilanciata è:\n\n\\ce{C3H8 + 5O2 -> 3CO2 + 4H2O}\n\nMassa molare: $M$")).toBe(
      "La reazione bilanciata è:\n\n$$\n\\ce{C3H8 + 5O2 -> 3CO2 + 4H2O}\n$$\n\nMassa molare: $M$",
    );
  });

  it("leaves a \\ce in a sentence, in a formula, in code or beside inline code alone", () => {
    for (const same of [
      "Vale \\ce{H2O} qui",
      "$\\ce{H2O}$",
      "$$\n\\ce{H2O}\n$$",
      "`x` \\ce{H2O}",
      "```python\n\\ce{H2O}\n```",
    ])
      expect(normalizeMathDelimiters(same)).toBe(same);
    expect(normalizeMathDelimiters("\\[\n\\ce{H2O}\n\\]")).toBe("\n$$\n\\ce{H2O}\n$$\n");
  });
});

// Review of #534: every guess must leave ordinary text and complete formulas alone.
describe("holdOpenMath leaves complete formulas and prices alone", () => {
  it("a complete formula with spaces inside its delimiters keeps its closing dollar", () => {
    expect(holdOpenMath("Vale $ C_nH_{2n+2} $")).toBe("Vale $ C_nH_{2n+2} $");
    expect(holdOpenMath("Vale $ C_nH_{2n+2} $ per gli alcani")).toBe("Vale $ C_nH_{2n+2} $ per gli alcani");
  });

  it("a price with a space after its dollar sign stays text, not a placeholder", () => {
    expect(holdOpenMath("Costa 25 $ e basta")).toBe("Costa 25 $ e basta");
    expect(holdOpenMath("Costa $ 25 e basta")).toBe("Costa $ 25 e basta");
  });

  it("a backtick span inside a formula is part of the formula", () => {
    expect(holdOpenMath("Vale $\\text{`x`}$ qui")).toBe("Vale $\\text{`x`}$ qui");
    expect(holdOpenMath("Vale $\\text{`x`}$ e $y =")).toBe("Vale $\\text{`x`}$ e […](pyxis-math:inline:3)");
    expect(normalizeMathDelimiters("$\\text{`x`}$ vale \\(25\\ \\$\\)")).toBe("$\\text{`x`}$ vale $25\\ \\char36{}$");
  });

  it("code before a dollar sign is still code", () => {
    expect(holdOpenMath("Uso `$x` e poi $y =")).toBe("Uso `$x` e poi […](pyxis-math:inline:3)");
    expect(normalizeMathDelimiters("`a \\(b\\)` e \\(c\\)")).toBe("`a \\(b\\)` e $c$");
  });
});

describe("a chemistry fence inside another code block", () => {
  it("is code, not a formula", () => {
    const example = "````\n```\n\\ce{H2O}\n```\n````";
    expect(normalizeMathDelimiters(example)).toBe(example);
    const tilde = "~~~~\n~~~\n\\ce{H2O}\n~~~\n~~~~";
    expect(normalizeMathDelimiters(tilde)).toBe(tilde);
  });

  it("a standalone block still is a formula, whatever follows it, and so is one closed by a longer fence", () => {
    expect(normalizeMathDelimiters("```\n\\ce{H2O}\n```\nAcqua")).toBe("$$\n\\ce{H2O}\n$$\nAcqua");
    expect(normalizeMathDelimiters("```\n\\ce{H2O}\n````")).toBe("$$\n\\ce{H2O}\n$$");
    expect(normalizeMathDelimiters("Prima\n\n```tex\n\\pu{5 mol}\n```\n\nDopo")).toBe("Prima\n\n$$\n\\pu{5 mol}\n$$\n\nDopo");
  });
});

describe("a text that starts with a text command", () => {
  it("is prose, however short", () => {
    for (const same of [
      "\\textbf{Nota:} valore nullo",
      "\\textit{Nota} sì",
      "\\textbf{Attenzione}",
      "\\emph{valore} nullo",
    ])
      expect(normalizeMathDelimiters(same)).toBe(same);
  });

  it("is a formula once something mathematical follows", () => {
    expect(normalizeMathDelimiters("\\vec{v}")).toBe("$\\vec{v}$");
    expect(normalizeMathDelimiters("\\text{massa} = 3\\ \\mathrm{kg}")).toBe("$\\text{massa} = 3\\ \\mathrm{kg}$");
  });
});
