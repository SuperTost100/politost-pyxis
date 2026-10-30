import { repairLatexOutsideCode } from "./latex-repair";
import { mathSpans, resolveBookRefs } from "./math-delimiters";

const SIGNS: Record<string, string> = {
  cdot: "·", times: "×", div: "÷", pm: "±", mp: "∓", leq: "≤", le: "≤", geq: "≥", ge: "≥", neq: "≠", ne: "≠",
  approx: "≈", sim: "∼", equiv: "≡", propto: "∝", infty: "∞", to: "→", rightarrow: "→", leftarrow: "←",
  Rightarrow: "⇒", Leftrightarrow: "⇔", sum: "∑", prod: "∏", int: "∫", partial: "∂", nabla: "∇", circ: "°",
  degree: "°", perp: "⊥", parallel: "∥", ldots: "…", dots: "…", cdots: "…", in: "∈", forall: "∀", exists: "∃",
  alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε", varepsilon: "ε", zeta: "ζ", eta: "η", theta: "θ",
  vartheta: "θ", iota: "ι", kappa: "κ", lambda: "λ", mu: "μ", nu: "ν", xi: "ξ", pi: "π", rho: "ρ", sigma: "σ",
  tau: "τ", phi: "φ", varphi: "φ", chi: "χ", psi: "ψ", omega: "ω", Gamma: "Γ", Delta: "Δ", Theta: "Θ",
  Lambda: "Λ", Xi: "Ξ", Pi: "Π", Sigma: "Σ", Phi: "Φ", Psi: "Ψ", Omega: "Ω",
};
// Commands that only style their argument: the argument is the reading.
const WRAPPERS =
  "text|textbf|textit|textrm|mathrm|mathbf|mathit|mathsf|mathtt|mathbb|mathcal|boldsymbol|operatorname|vec|hat|bar|dot|ddot|overline|underline|tilde|overrightarrow|mathop";

// For a title: the accent a command puts over a single letter, and the characters that have a subscript or a superscript form.
const ACCENTS: Record<string, string> = { bar: "\u0304", overline: "\u0304", vec: "\u20d7", overrightarrow: "\u20d7", hat: "\u0302", tilde: "\u0303", dot: "\u0307", ddot: "\u0308" };
const SUBSCRIPTS = "0123456789+-=()aehijklmnoprstuvx";
const SUBSCRIPT_GLYPHS = "₀₁₂₃₄₅₆₇₈₉₊₋₌₍₎ₐₑₕᵢⱼₖₗₘₙₒₚᵣₛₜᵤᵥₓ";
const SUPERSCRIPTS = "0123456789+-=()ni";
const SUPERSCRIPT_GLYPHS = "⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁼⁽⁾ⁿⁱ";

// A script glyph after the space a command left in front of it.
const SCRIPT_AFTER_SPACE = new RegExp(` ([${SUBSCRIPT_GLYPHS}${SUPERSCRIPT_GLYPHS}])`, "gu");

/** `text` with every character of it in `from` written as the one at the same place in `to`; `null` when one has no form. */
function setScript(text: string, from: string, to: string): string | null {
  let out = "";
  for (const char of text) {
    const at = from.indexOf(char);
    if (at < 0) return null;
    out += to[at];
  }
  return out;
}

/**
 * One formula as text a screen reader says well: no backslashes, braces or dollar signs. With `glyphs` it is the text a
 * title shows instead: an accent over a single letter and a subscript or an exponent that has a Unicode form is written
 * as that character ("x̄", "σₓ", "m²"), one that has none stays "_x".
 */
function spokenFormula(latex: string, glyphs = false): string {
  // One token as an argument, with no braces around it: `\vec\omega`, `\hat u`, `\frac12`, `\sqrt5`.
  const token = "(\\\\[A-Za-z]+|[A-Za-z0-9])";
  let out = latex
    .replace(new RegExp(`\\\\(${WRAPPERS})(?![A-Za-z])\\s*${token}`, "g"), "\\$1{$2}")
    .replace(new RegExp(`\\\\([dt]?frac)(?![A-Za-z])\\s*([A-Za-z0-9])\\s*([A-Za-z0-9])`, "g"), "\\$1{$2}{$3}")
    .replace(new RegExp(`\\\\sqrt(?![A-Za-z])\\s*([A-Za-z0-9])`, "g"), "\\sqrt{$1}");
  const wrapper = new RegExp(`\\\\(${WRAPPERS})\\s*\\{([^{}]*)\\}`, "g");
  const fraction = /\\[dt]?frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g;
  const root = /\\sqrt\s*\{([^{}]*)\}/g;
  // Innermost first: a command inside another one's argument is read before the outer one.
  for (let pass = 0; pass < 6; pass += 1) {
    const before = out;
    out = out
      // A command name before the argument would swallow its first letter: `\cdot\vec{b}` must not read `\cdotb`.
      .replace(wrapper, (_, name: string, inner: string, at: number, whole: string) => {
        const arg = glyphs && ACCENTS[name] && [...inner].length === 1 ? inner + ACCENTS[name] : inner;
        return /[A-Za-z]/.test(whole[at - 1] ?? "") ? `{}${arg}` : arg;
      })
      .replace(fraction, "$1/$2")
      .replace(root, "√$1");
    if (out === before) break;
  }
  out = out
    .replace(/\\(?:left|right|big|Big|bigg|Bigg)\b\s*/g, "")
    .replace(/\\(?:quad|qquad)\b/g, " ")
    .replace(/\\[ ,;:!]|~/g, " ")
    .replace(/\\\\/g, " ")
    .replace(/\\([A-Za-z]+)/g, (_, name: string) => ` ${SIGNS[name] ?? name} `)
    .replace(/([\^_])\{([^{}]*)\}|([\^_])([A-Za-z0-9+\-=()])/g, (match, mark1?: string, group?: string, mark2?: string, single?: string) => {
      const mark = mark1 ?? mark2!;
      const body = group ?? single!;
      if (!glyphs) return group === undefined ? match : `${mark}${body}`;
      const glyph = mark === "_" ? setScript(body.trim(), SUBSCRIPTS, SUBSCRIPT_GLYPHS) : setScript(body.trim(), SUPERSCRIPTS, SUPERSCRIPT_GLYPHS);
      return glyph ?? `${mark}${body}`;
    })
    .replace(/[{}\\]/g, "");
  // A sign written before a subscript or an exponent gave it a space of its own: "σ _x" is "σ_x".
  return out.replace(/\s+/g, " ").replace(/ ([\^_])/g, "$1").replace(glyphs ? SCRIPT_AFTER_SPACE : /$^/, "$1").trim();
}

/** Markdown with `$…$` formulas as plain text for an accessible name, formulas spoken as signs and words. */
export function spokenText(input: string, glyphs = false): string {
  const markdown = resolveBookRefs(repairLatexOutsideCode(input));
  let out = "";
  let at = 0;
  for (const [start, end] of mathSpans(markdown)) {
    const raw = markdown.slice(start, end);
    out += markdown.slice(at, start) + spokenFormula(raw.startsWith("$$") ? raw.slice(2, -2) : raw.slice(1, -1), glyphs);
    at = end;
  }
  return (out + markdown.slice(at)).replace(/\s+/g, " ").trim();
}

/**
 * A chat's name from the words the student selected or the question stem: formulas as readable text ("x̄", "σₓ"), no `$`,
 * one line, and at most `max` characters cut at a word. A formula cut off by the caller (an opening `$` never closed) is
 * dropped, so no half a formula is left in the name.
 */
export function plainTitle(input: string, max = 80): string {
  // Offsets are read in the text the spans were found in: a book reference changes the length of the text before it.
  let text = resolveBookRefs(repairLatexOutsideCode(input));
  const spans = mathSpans(text);
  const dangling = lastOpenDollar(text, spans);
  if (dangling >= 0) text = text.slice(0, dangling);
  const plain = spokenText(text, true);
  if ([...plain].length <= max) return plain;
  const cut = [...plain].slice(0, max - 1).join("");
  const word = cut.lastIndexOf(" ");
  return `${(word > 0 ? cut.slice(0, word) : cut).trimEnd()}…`;
}

/** Where a `$` that opens no complete formula sits, or -1. An escaped `\$` is a dollar sign. */
function lastOpenDollar(text: string, spans: Array<[number, number]>): number {
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== "$" || text[i - 1] === "\\" || spans.some(([start, end]) => i >= start && i < end)) continue;
    // A dollar sign followed by a space or a digit and a space is a price, not an opening.
    if (/^\$\d*(?:[.,]\d+)?(?:\s|$)/.test(text.slice(i))) continue;
    return i;
  }
  return -1;
}
