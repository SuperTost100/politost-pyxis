/**
 * Key layouts of the formula keyboard. One tab per group, three rows of ten keys each.
 * `label` is LaTeX drawn on the key; `insert` is what the field receives:
 * `#@` takes the selection (or the term before the caret) and `#?` leaves a slot to fill.
 */
export type MathKey = {
  id: string;
  label: string;
  insert: string;
  /** Spoken and tooltip text when the glyph says it all, such as a letter or a digit. */
  text?: string;
  tone?: "digit";
  /** Long names shrink so they stay inside a narrow key. */
  fit?: "tight" | "tighter";
};

export type MathTab = {
  id: "arithmetic" | "functions" | "trigonometry" | "calculus";
  /** What the tab shows; the same in both languages. `short` is for narrow panels. */
  caption: string;
  short: string;
  rows: MathKey[][];
};

function glyph(label: string, insert = label, tone?: "digit"): MathKey {
  return { id: `g:${insert}`, label, insert, text: label, tone };
}

function named(id: string, label: string, insert: string, fit?: MathKey["fit"]): MathKey {
  return { id, label, insert, fit };
}

const digits = "0123456789".split("").map((d) => glyph(d, d, "digit"));

const parenLeft = named("lparen", "(", "(");
const parenRight = named("rparen", ")", ")");

const sqrt = named("sqrt", "\\sqrt{x}", "\\sqrt{#@}");
const nroot = named("nroot", "\\sqrt[n]{x}", "\\sqrt[#?]{#@}");
const square = named("square", "a^2", "#@^{2}");
const power = named("power", "x^n", "#@^{#?}");
const fraction = named("fraction", "\\frac{x}{y}", "\\frac{#@}{#?}");

export const MATH_TABS: MathTab[] = [
  {
    id: "arithmetic",
    caption: "+ − × ÷",
    short: "+ − × ÷",
    rows: [
      digits,
      [
        glyph("x"),
        glyph("y"),
        sqrt,
        nroot,
        square,
        power,
        parenLeft,
        parenRight,
        named("divide", "\\div", "\\div"),
        named("lt", "<", "<"),
      ],
      [
        named("gt", ">", ">"),
        named("times", "\\times", "\\times"),
        named("le", "\\le", "\\le"),
        named("ge", "\\ge", "\\ge"),
        named("minus", "-", "-"),
        fraction,
        named("ne", "\\ne", "\\ne"),
        named("comma", ",", ","),
        named("eq", "=", "="),
        named("plus", "+", "+"),
      ],
    ],
  },
  {
    id: "functions",
    caption: "f(x) e log ln",
    short: "f(x) e ln",
    rows: [
      [
        named("fx", "f(x)", "f\\left(#?\\right)", "tight"),
        named("gx", "g(x)", "g\\left(#?\\right)", "tight"),
        named("e", "e", "\\mathrm{e}"),
        named("exp", "e^x", "\\mathrm{e}^{#?}"),
        named("pow10", "10^x", "10^{#?}"),
        named("pi", "\\pi", "\\pi"),
        named("abs", "|x|", "\\left|#@\\right|"),
        named("fact", "x!", "#@!"),
        named("sub", "x_n", "#@_{#?}"),
        named("percent", "\\%", "\\%"),
      ],
      [
        named("log", "\\log", "\\log\\left(#?\\right)"),
        named("ln", "\\ln", "\\ln\\left(#?\\right)"),
        named("logb", "\\log_a", "\\log_{#?}\\left(#?\\right)", "tight"),
        sqrt,
        nroot,
        square,
        power,
        fraction,
        parenLeft,
        parenRight,
      ],
      [
        glyph("x"),
        glyph("y"),
        glyph("n"),
        glyph("a"),
        glyph("b"),
        named("approx", "\\approx", "\\approx"),
        named("pm", "\\pm", "\\pm"),
        named("in", "\\in", "\\in"),
        named("reals", "\\mathbb{R}", "\\mathbb{R}"),
        named("comma", ",", ","),
      ],
    ],
  },
  {
    id: "trigonometry",
    caption: "sin cos tan cot",
    short: "sin cos",
    rows: [
      [
        named("sin", "\\sin", "\\sin\\left(#?\\right)"),
        named("cos", "\\cos", "\\cos\\left(#?\\right)"),
        named("tan", "\\tan", "\\tan\\left(#?\\right)"),
        named("cot", "\\cot", "\\cot\\left(#?\\right)"),
        named("sec", "\\sec", "\\sec\\left(#?\\right)"),
        named("csc", "\\csc", "\\csc\\left(#?\\right)"),
        named("pi", "\\pi", "\\pi"),
        named("theta", "\\theta", "\\theta"),
        named("alpha", "\\alpha", "\\alpha"),
        named("degree", "^\\circ", "^{\\circ}"),
      ],
      [
        named("arcsin", "\\arcsin", "\\arcsin\\left(#?\\right)", "tighter"),
        named("arccos", "\\arccos", "\\arccos\\left(#?\\right)", "tighter"),
        named("arctan", "\\arctan", "\\arctan\\left(#?\\right)", "tighter"),
        named("arccot", "\\operatorname{arccot}", "\\operatorname{arccot}\\left(#?\\right)", "tighter"),
        named("sinh", "\\sinh", "\\sinh\\left(#?\\right)", "tight"),
        named("cosh", "\\cosh", "\\cosh\\left(#?\\right)", "tight"),
        named("tanh", "\\tanh", "\\tanh\\left(#?\\right)", "tight"),
        named("sin2", "\\sin^2", "\\sin^{2}\\left(#?\\right)", "tight"),
        named("beta", "\\beta", "\\beta"),
        named("phi", "\\varphi", "\\varphi"),
      ],
      [
        glyph("x"),
        glyph("y"),
        parenLeft,
        parenRight,
        named("plus", "+", "+"),
        named("minus", "-", "-"),
        named("times", "\\times", "\\times"),
        named("divide", "\\div", "\\div"),
        named("eq", "=", "="),
        fraction,
      ],
    ],
  },
  {
    id: "calculus",
    caption: "lim dx ∫ Σ ∞",
    short: "∫ Σ ∞",
    rows: [
      [
        named("lim", "\\lim", "\\lim_{#?\\to #?}"),
        named("ddx", "\\frac{d}{dx}", "\\frac{\\mathrm{d}}{\\mathrm{d}#?}"),
        named("dx", "dx", "\\,\\mathrm{d}x"),
        named("int", "\\int", "\\int #?\\,\\mathrm{d}#?"),
        named("intab", "\\int_a^b", "\\int_{#?}^{#?}#?\\,\\mathrm{d}#?"),
        named("sum", "\\sum", "\\sum_{#?}^{#?}#?"),
        named("prod", "\\prod", "\\prod_{#?}^{#?}#?"),
        named("infty", "\\infty", "\\infty"),
        named("to", "\\to", "\\to"),
        named("partial", "\\partial", "\\partial"),
      ],
      [
        named("pdx", "\\frac{\\partial}{\\partial x}", "\\frac{\\partial}{\\partial #?}"),
        named("prime", "f'", "#@^{\\prime}"),
        named("dprime", "f''", "#@^{\\prime\\prime}"),
        named("nabla", "\\nabla", "\\nabla"),
        named("vec", "\\vec{v}", "\\vec{#@}"),
        named("bar", "\\overline{x}", "\\overline{#@}"),
        named("implies", "\\Rightarrow", "\\Rightarrow"),
        named("sqrt", "\\sqrt{x}", "\\sqrt{#@}"),
        square,
        power,
      ],
      [
        glyph("x"),
        glyph("t"),
        glyph("n"),
        parenLeft,
        parenRight,
        named("plus", "+", "+"),
        named("minus", "-", "-"),
        named("eq", "=", "="),
        fraction,
        named("comma", ",", ","),
      ],
    ],
  },
];
