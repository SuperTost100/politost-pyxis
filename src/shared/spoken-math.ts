import { repairLatexEscapes } from "./latex-repair";
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

/** One formula as text a screen reader says well: no backslashes, braces or dollar signs. */
function spokenFormula(latex: string): string {
  let out = latex;
  const wrapper = new RegExp(`\\\\(?:${WRAPPERS})\\s*\\{([^{}]*)\\}`, "g");
  const fraction = /\\[dt]?frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g;
  const root = /\\sqrt\s*\{([^{}]*)\}/g;
  // Innermost first: a command inside another one's argument is read before the outer one.
  for (let pass = 0; pass < 6; pass += 1) {
    const before = out;
    out = out.replace(wrapper, "$1").replace(fraction, "$1/$2").replace(root, "√$1");
    if (out === before) break;
  }
  out = out
    .replace(/\\(?:left|right|big|Big|bigg|Bigg)\b\s*/g, "")
    .replace(/\\(?:quad|qquad)\b/g, " ")
    .replace(/\\[ ,;:!]|~/g, " ")
    .replace(/\\\\/g, " ")
    .replace(/\\([A-Za-z]+)/g, (_, name: string) => ` ${SIGNS[name] ?? name} `)
    .replace(/([\^_])\{([^{}]*)\}/g, "$1$2")
    .replace(/[{}\\]/g, "");
  return out.replace(/\s+/g, " ").trim();
}

/** Markdown with `$…$` formulas as plain text for an accessible name, formulas spoken as signs and words. */
export function spokenText(input: string): string {
  const markdown = resolveBookRefs(repairLatexEscapes(input));
  let out = "";
  let at = 0;
  for (const [start, end] of mathSpans(markdown)) {
    const raw = markdown.slice(start, end);
    out += markdown.slice(at, start) + spokenFormula(raw.startsWith("$$") ? raw.slice(2, -2) : raw.slice(1, -1));
    at = end;
  }
  return (out + markdown.slice(at)).replace(/\s+/g, " ").trim();
}
