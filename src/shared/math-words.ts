import { mathSpans } from "./math-delimiters";
import { SIGNS } from "./spoken-math";

export type ReadingLanguage = "it" | "en";

type Words = {
  plus: string;
  minus: string;
  times: string;
  divided: string;
  equals: string;
  less: string;
  greater: string;
  lessEqual: string;
  greaterEqual: string;
  notEqual: string;
  approx: string;
  plusMinus: string;
  minusPlus: string;
  tends: string;
  implies: string;
  iff: string;
  member: string;
  infinity: string;
  percent: string;
  degrees: string;
  factorial: string;
  primes: string[];
  squared: string;
  cubed: string;
  power: (exponent: string) => string;
  index: string;
  fraction: string;
  of: string;
  root: (index: string | null) => string;
  integral: (from?: string, to?: string) => string;
  sum: (from?: string, to?: string) => string;
  product: (from?: string, to?: string) => string;
  limit: (at?: string) => string;
  differential: (variable: string) => string;
  derivative: (partial: boolean, variable: string) => string;
  derivativeOf: (partial: boolean, of: string, variable: string) => string;
  absolute: string;
  vector: string;
  bar: (letter: string) => string;
  logBase: (base: string) => string;
  functions: Record<string, string>;
};

const range = (name: string, from: string, to: string, over: string, of: string) => (low?: string, high?: string) =>
  low && high ? `${name} ${from} ${low} ${to} ${high} ${of}` : low ? `${name} ${over} ${low} ${of}` : `${name} ${of}`;

const WORDS: Record<ReadingLanguage, Words> = {
  it: {
    plus: "più",
    minus: "meno",
    times: "per",
    divided: "diviso",
    equals: "uguale a",
    less: "minore di",
    greater: "maggiore di",
    lessEqual: "minore o uguale a",
    greaterEqual: "maggiore o uguale a",
    notEqual: "diverso da",
    approx: "circa uguale a",
    plusMinus: "più o meno",
    minusPlus: "meno o più",
    tends: "che tende a",
    implies: "implica",
    iff: "se e solo se",
    member: "appartiene a",
    infinity: "infinito",
    percent: "per cento",
    degrees: "gradi",
    factorial: "fattoriale",
    primes: ["primo", "secondo", "terzo"],
    squared: "al quadrato",
    cubed: "al cubo",
    power: (exponent) => `alla ${exponent}`,
    index: "pedice",
    fraction: "fratto",
    of: "di",
    root: (index) =>
      index === null || index === "2" ? "radice quadrata di" : index === "3" ? "radice cubica di" : `radice ${index}-esima di`,
    integral: range("integrale", "da", "a", "su", "di"),
    sum: range("sommatoria", "da", "a", "su", "di"),
    product: range("produttoria", "da", "a", "su", "di"),
    limit: (at) => (at ? `limite per ${at} di` : "limite di"),
    differential: (variable) => `in d${variable}`,
    derivative: (partial, variable) => `derivata ${partial ? "parziale " : ""}rispetto a ${variable} di`,
    derivativeOf: (partial, of, variable) => `derivata ${partial ? "parziale " : ""}di ${of} rispetto a ${variable}`,
    absolute: "valore assoluto di",
    vector: "vettore",
    bar: (letter) => `${letter} soprassegnato`,
    logBase: (base) => `logaritmo in base ${base}`,
    functions: {
      sin: "seno",
      cos: "coseno",
      tan: "tangente",
      cot: "cotangente",
      sec: "secante",
      csc: "cosecante",
      arcsin: "arcoseno",
      arccos: "arcocoseno",
      arctan: "arcotangente",
      arccot: "arcocotangente",
      sinh: "seno iperbolico",
      cosh: "coseno iperbolico",
      tanh: "tangente iperbolica",
      log: "logaritmo",
      ln: "logaritmo naturale",
      exp: "esponenziale",
    },
  },
  en: {
    plus: "plus",
    minus: "minus",
    times: "times",
    divided: "divided by",
    equals: "equals",
    less: "less than",
    greater: "greater than",
    lessEqual: "less than or equal to",
    greaterEqual: "greater than or equal to",
    notEqual: "not equal to",
    approx: "approximately equal to",
    plusMinus: "plus or minus",
    minusPlus: "minus or plus",
    tends: "approaches",
    implies: "implies",
    iff: "if and only if",
    member: "in",
    infinity: "infinity",
    percent: "percent",
    degrees: "degrees",
    factorial: "factorial",
    primes: ["prime", "double prime", "triple prime"],
    squared: "squared",
    cubed: "cubed",
    power: (exponent) => `to the ${exponent}`,
    index: "sub",
    fraction: "over",
    of: "of",
    root: (index) =>
      index === null || index === "2" ? "square root of" : index === "3" ? "cube root of" : `${index}-th root of`,
    integral: range("integral", "from", "to", "over", "of"),
    sum: range("sum", "from", "to", "over", "of"),
    product: range("product", "from", "to", "over", "of"),
    limit: (at) => (at ? `limit as ${at} of` : "limit of"),
    differential: (variable) => `d${variable}`,
    derivative: (partial, variable) => `${partial ? "partial " : ""}derivative with respect to ${variable} of`,
    derivativeOf: (partial, of, variable) => `${partial ? "partial " : ""}derivative of ${of} with respect to ${variable}`,
    absolute: "absolute value of",
    vector: "vector",
    bar: (letter) => `${letter} bar`,
    logBase: (base) => `log base ${base}`,
    functions: {
      sin: "sine",
      cos: "cosine",
      tan: "tangent",
      cot: "cotangent",
      sec: "secant",
      csc: "cosecant",
      arcsin: "arcsine",
      arccos: "arccosine",
      arctan: "arctangent",
      arccot: "arccotangent",
      sinh: "hyperbolic sine",
      cosh: "hyperbolic cosine",
      tanh: "hyperbolic tangent",
      log: "log",
      ln: "natural log",
      exp: "exponential",
    },
  },
};

/** A table's entry for text a student wrote; never a property every object has, such as `toString`. */
const own = <T>(table: Readonly<Record<string, T>>, key: string): T | undefined =>
  Object.hasOwn(table, key) ? table[key] : undefined;

/** Signs a student can type or paste as characters, by the command that reads the same. */
const TYPED: Record<string, string> = {
  "≤": "le", "≥": "ge", "≠": "ne", "≈": "approx", "±": "pm", "∞": "infty", "→": "to", "·": "cdot", "×": "times",
  "*": "cdot", "÷": "div", "/": "div", "∈": "in", "°": "degree",
};
const DOUBLE_STRUCK: Record<string, string> = { R: "ℝ", N: "ℕ", Z: "ℤ", Q: "ℚ", C: "ℂ" };
/** Commands that only set the style of their argument, or of what follows. */
const STYLES = new Set(["mathbf", "mathit", "mathsf", "mathtt", "mathcal", "boldsymbol", "mathop"]);
const TEXTS = new Set(["text", "textrm", "textbf", "textit", "textnormal", "mbox"]);
const IGNORED = new Set(["quad", "qquad", "displaystyle", "textstyle", "limits", "nolimits"]);
/** Brackets written as commands, by the character that reads the same. */
const BRACKETS: Record<string, string> = {
  lparen: "(", rparen: ")", lbrack: "[", rbrack: "]", vert: "|", lvert: "|", rvert: "|",
};
/** Commands the formula field writes for what a student types, by the command read here. */
const SAME: Record<string, string> = { mleft: "left", mright: "right", lbrace: "{", rbrace: "}" };

type Token = {
  /** `literal` is an escaped character, such as `\%`: never a brace that groups. */
  kind: "command" | "number" | "char" | "literal" | "space";
  text: string;
  source: string;
};

function tokens(latex: string): Token[] {
  const out: Token[] = [];
  // `3{,}5` is how LaTeX writes a decimal comma.
  // A digit is a token of its own, as LaTeX reads an argument written without braces: `x^12` is `x^{1}2`. A number
  // is put together from them where it is read, so "3,5" and "12" stay whole.
  for (const match of latex.replace(/\{,\}/g, ",").matchAll(/\\([A-Za-z]+)|\\([\s\S])|(\d)|(\s+)|([\s\S])/gu)) {
    const source = match[0];
    const name = match[1] ? (own(SAME, match[1]) ?? match[1]) : "";
    const fence = own(BRACKETS, name);
    if (fence) out.push({ kind: "char", text: fence, source });
    else if (name === "{" || name === "}") out.push({ kind: "literal", text: name, source });
    else if (name) out.push({ kind: "command", text: name, source });
    // `\,`, `\;`, `\:`, `\!` and `\ ` are spacing.
    else if (match[2] !== undefined) out.push({ kind: /[\s,;:!]/.test(match[2]) ? "space" : "literal", text: match[2], source });
    else if (match[3]) out.push({ kind: "number", text: match[3], source });
    else if (match[4]) out.push({ kind: "space", text: " ", source });
    else out.push({ kind: "char", text: match[5]!, source });
  }
  return out;
}

type Term = {
  text: string;
  /**
   * `atom`: one number, letter or sign. `closed`: reads as one thing, such as "x al quadrato" or "(a più b)". `open`: a
   * phrase that needs brackets beside another term, such as a fraction. `link`: a sign or a phrase that joins what is
   * around it, such as "più" or "integrale da 0 a 1 di".
   */
  kind: "atom" | "closed" | "open" | "link";
  /** Punctuation, written with no space before it. */
  glue?: boolean;
};

/** A formula this reader has no words for. The caller shows no reading at all, since a wrong one would mislead. */
class Unreadable extends Error {}

const bracket = (term: Term) => (term.kind === "open" || term.kind === "link" ? `(${term.text})` : term.text);
/** As `bracket`, for an exponent or an index: one that is itself a phrase keeps brackets too, "x alla (2 alla n)". */
const script = (term: Term) =>
  term.kind !== "atom" && /\s/.test(term.text) && !/^\(.*\)$/s.test(term.text) ? `(${term.text})` : bracket(term);

/** Terms side by side as one: a fraction beside another factor keeps brackets, and "2x" stays written together. */
function join(terms: Term[]): Term | null {
  if (terms.length < 2) return terms[0] ?? null;
  const parts = terms.map((term, at): Term => {
    if (term.kind !== "open") return term;
    const beside = [terms[at - 1], terms[at + 1]].some((other) => other && other.kind !== "link");
    return beside ? { text: `(${term.text})`, kind: "closed" } : term;
  });
  let text = "";
  for (const [at, term] of parts.entries()) {
    const before = parts[at - 1];
    const tight =
      !before ||
      term.glue ||
      before.text === "(" ||
      before.text === "[" ||
      (before.kind === "atom" && term.kind === "atom") ||
      (term.text.startsWith("(") && before.kind !== "link" && (before.kind === "atom" || before.text.endsWith(")")));
    text += (tight ? "" : " ") + term.text;
  }
  return { text, kind: parts.every((term) => term.kind === "atom") ? "closed" : "open" };
}

class Reader {
  constructor(
    private readonly list: Token[],
    private readonly words: Words,
  ) {}

  /** The terms from `from` up to `to`, as one; null when there are none. */
  read(from = 0, to = this.list.length): Term | null {
    const terms: Term[] = [];
    let at = this.skip(from, to);
    while (at < to) {
      const [term, next] = this.term(at, to);
      if (term) terms.push(term);
      at = this.skip(next, to);
    }
    return join(terms);
  }

  private skip(at: number, to: number): number {
    while (at < to && this.list[at]!.kind === "space") at += 1;
    return at;
  }

  private is(at: number, to: number, kind: Token["kind"], text: string): boolean {
    const token = at < to ? this.list[at] : undefined;
    return token?.kind === kind && token.text === text;
  }

  /** The source between two tokens, without its spaces. */
  private raw(from: number, to: number): string {
    return this.list.slice(from, to).filter((token) => token.kind !== "space").map((token) => token.source).join("");
  }

  private sub(latex: string): Term | null {
    return new Reader(tokens(latex), this.words).read();
  }

  /** Where the bracket opened at `at` closes, or -1. */
  private closing(at: number, to: number, open: string, close: string): number {
    let depth = 0;
    for (let i = at + 1; i < to; i += 1) {
      const token = this.list[i]!;
      if (token.kind !== "char") continue;
      if (token.text === open && open !== close) depth += 1;
      else if (token.text === close) {
        if (depth === 0) return i;
        depth -= 1;
      }
    }
    return -1;
  }

  /** One argument: a `{…}` group or a single token. Returns where its content starts and ends, and what follows it. */
  private argument(from: number, to: number): [number, number, number] {
    const at = this.skip(from, to);
    if (at >= to) throw new Unreadable();
    if (this.is(at, to, "char", "{")) {
      const close = this.closing(at, to, "{", "}");
      if (close < 0) throw new Unreadable();
      return [at + 1, close, close + 1];
    }
    return [at, at + 1, at + 1];
  }

  /** `^…` in words after its base: "al quadrato", "alla n", "gradi", "primo"; null for an empty exponent. */
  private exponent(from: number, to: number): string | null {
    const raw = this.raw(from, to);
    if (/^\\(?:circ|degree)$/.test(raw)) return this.words.degrees;
    if (/^(?:\\prime|')+$/.test(raw)) {
      const word = this.words.primes[raw.split(/\\prime|'/).length - 2];
      if (!word) throw new Unreadable();
      return word;
    }
    const exponent = this.read(from, to);
    if (!exponent) return null;
    return exponent.text === "2" ? this.words.squared : exponent.text === "3" ? this.words.cubed : this.words.power(script(exponent));
  }

  /** One term with what is written after it: an exponent, an index, a factorial or a prime. */
  private term(at: number, to: number): [Term | null, number] {
    let [base, next] = this.primary(at, to);
    while (base) {
      const here = this.skip(next, to);
      if (this.is(here, to, "char", "^")) {
        const [from, end, after] = this.argument(here + 1, to);
        const how = this.exponent(from, end);
        if (how) base = { text: `${bracket(base)} ${how}`, kind: "closed" };
        next = after;
      } else if (this.is(here, to, "char", "_")) {
        const [from, end, after] = this.argument(here + 1, to);
        const index = this.read(from, end);
        if (index) base = { text: `${bracket(base)} ${this.words.index} ${script(index)}`, kind: "closed" };
        next = after;
      } else if (this.is(here, to, "char", "!")) {
        base = { text: `${bracket(base)} ${this.words.factorial}`, kind: "closed" };
        next = here + 1;
      } else if (this.is(here, to, "char", "'")) {
        let count = 0;
        while (this.is(here + count, to, "char", "'")) count += 1;
        const word = this.words.primes[count - 1];
        if (!word) throw new Unreadable();
        base = { text: `${bracket(base)} ${word}`, kind: "closed" };
        next = here + count;
      } else break;
    }
    return [base, next];
  }

  private primary(at: number, to: number): [Term | null, number] {
    const token = this.list[at]!;
    if (token.kind === "number") {
      let text = token.text;
      let end = at + 1;
      for (;;) {
        const next = end < to ? this.list[end] : undefined;
        const after = end + 1 < to ? this.list[end + 1] : undefined;
        if (next?.kind === "number") {
          text += next.text;
          end += 1;
        } else if (next?.kind === "char" && (next.text === "." || next.text === ",") && after?.kind === "number") {
          text += next.text + after.text;
          end += 2;
        } else break;
      }
      return [{ text, kind: "atom" }, end];
    }
    if (token.kind === "command") return this.command(token.text, at, to);
    if (token.kind === "literal")
      return [token.text === "%" ? { text: this.words.percent, kind: "link" } : { text: token.text, kind: "atom" }, at + 1];
    const text = token.text;
    if (text === "{") {
      const close = this.closing(at, to, "{", "}");
      if (close < 0) throw new Unreadable();
      return [this.read(at + 1, close), close + 1];
    }
    if (text === "(" || text === "[") {
      const close = this.closing(at, to, text, text === "(" ? ")" : "]");
      // A bracket with no partner, as in the interval "[2, +∞)", is read as it is written.
      if (close < 0) return [{ text, kind: "atom" }, at + 1];
      const inner = this.read(at + 1, close)?.text ?? "";
      return [{ text: text === "(" ? `(${inner})` : `[${inner}]`, kind: "closed" }, close + 1];
    }
    if (text === "}" || text === "^" || text === "_") throw new Unreadable();
    if (text === ")" || text === "]") return [{ text, kind: "atom", glue: true }, at + 1];
    const typed = own(TYPED, text);
    if (typed) return this.command(typed, at, to);
    const words = this.words;
    const link = (word: string): [Term, number] => [{ text: word, kind: "link" }, at + 1];
    if (text === "+") return link(words.plus);
    if (text === "-" || text === "−") return link(words.minus);
    if (text === "=") return link(words.equals);
    if (text === "<") return link(words.less);
    if (text === ">") return link(words.greater);
    if (text === "%") return link(words.percent);
    if (text === "," || text === ";" || text === "." || text === ":") return [{ text, kind: "link", glue: true }, at + 1];
    return [{ text, kind: "atom" }, at + 1];
  }

  private command(name: string, at: number, to: number): [Term | null, number] {
    const words = this.words;
    const link = (word: string): [Term, number] => [{ text: word, kind: "link" }, at + 1];
    if (IGNORED.has(name)) return [null, at + 1];
    switch (name) {
      case "left":
        return this.delimited(at, to);
      case "frac":
      case "dfrac":
      case "tfrac":
        return this.fraction(at, to);
      case "sqrt":
        return this.root(at, to);
      case "int":
      case "sum":
      case "prod":
      case "lim":
        return this.ranged(name, at, to);
      case "operatorname": {
        const [from, end, after] = this.argument(at + 1, to);
        const written = this.raw(from, end);
        return this.applied(written, own(words.functions, written) ?? written, after, to);
      }
      case "mathrm": {
        const [from, end, after] = this.argument(at + 1, to);
        return (this.raw(from, end) === "d" ? this.differential(after, to) : null) ?? [this.read(from, end), after];
      }
      // The formula field's own upright letters.
      case "differentialD":
        return this.differential(at + 1, to) ?? [{ text: "d", kind: "atom" }, at + 1];
      case "exponentialE":
        return [{ text: "e", kind: "atom" }, at + 1];
      case "imaginaryI":
        return [{ text: "i", kind: "atom" }, at + 1];
      case "mathbb": {
        const [from, end, after] = this.argument(at + 1, to);
        const letter = this.raw(from, end);
        return [{ text: own(DOUBLE_STRUCK, letter) ?? letter, kind: "atom" }, after];
      }
      case "vec":
      case "overrightarrow":
      case "overline":
      case "bar": {
        const [from, end, after] = this.argument(at + 1, to);
        const inner = this.read(from, end);
        if (!inner) throw new Unreadable();
        const text = name === "vec" || name === "overrightarrow" ? `${words.vector} ${bracket(inner)}` : words.bar(bracket(inner));
        return [{ text, kind: "closed" }, after];
      }
      case "cdot":
      case "times":
        return link(words.times);
      case "div":
        return link(words.divided);
      case "pm":
        return link(words.plusMinus);
      case "mp":
        return link(words.minusPlus);
      case "le":
      case "leq":
        return link(words.lessEqual);
      case "ge":
      case "geq":
        return link(words.greaterEqual);
      case "ne":
      case "neq":
        return link(words.notEqual);
      case "approx":
        return link(words.approx);
      case "to":
      case "rightarrow":
        return link(words.tends);
      case "Rightarrow":
        return link(words.implies);
      case "Leftrightarrow":
        return link(words.iff);
      case "in":
        return link(words.member);
      case "circ":
      case "degree":
        return link(words.degrees);
      case "infty":
        return [{ text: words.infinity, kind: "closed" }, at + 1];
      case "prime":
        return [{ text: words.primes[0]!, kind: "closed" }, at + 1];
    }
    const named = own(words.functions, name);
    if (named) return this.applied(name, named, at + 1, to);
    if (TEXTS.has(name)) {
      const [from, end, after] = this.argument(at + 1, to);
      const written = this.list.slice(from, end).map((token) => token.source).join("").trim();
      return [written ? { text: written, kind: "closed" } : null, after];
    }
    if (STYLES.has(name)) {
      const [from, end, after] = this.argument(at + 1, to);
      return [this.read(from, end), after];
    }
    const sign = own(SIGNS, name);
    if (sign) return [{ text: sign, kind: "atom" }, at + 1];
    throw new Unreadable();
  }

  /**
   * An upright d before a variable is a differential, "in dx": the variable is a letter or a command written as a sign,
   * such as `\theta`, with no exponent or index of its own. Null when what follows the d at `from` is something else.
   */
  private differential(from: number, to: number): [Term, number] | null {
    const at = this.skip(from, to);
    const token = at < to ? this.list[at]! : undefined;
    const named = token?.kind === "command" ? Boolean(own(SIGNS, token.text)) : token?.kind === "char" && /^\p{L}$/u.test(token.text);
    const then = this.skip(at + 1, to);
    if (!named || this.is(then, to, "char", "^") || this.is(then, to, "char", "_")) return null;
    return [{ text: this.words.differential(this.primary(at, to)[0]!.text), kind: "link" }, at + 1];
  }

  /** Where the `\right` of the `\left` whose bracket is at `open` stands, or -1. */
  private right(open: number, to: number): number {
    let depth = 0;
    for (let i = open + 1; i < to; i += 1) {
      const token = this.list[i]!;
      if (token.kind !== "command") continue;
      if (token.text === "left") depth += 1;
      else if (token.text === "right") {
        if (depth === 0) return i;
        depth -= 1;
      }
    }
    return -1;
  }

  /** `\left( … \right)` with whichever brackets it has; `\left| … \right|` is an absolute value. */
  private delimited(at: number, to: number): [Term, number] {
    const open = this.skip(at + 1, to);
    const right = open < to ? this.right(open, to) : -1;
    const close = this.skip(right + 1, to);
    if (right < 0 || close >= to) throw new Unreadable();
    const inner = this.read(open + 1, right);
    const [first, last] = [this.list[open]!.text, this.list[close]!.text];
    if (first === "|" && last === "|" && inner)
      return [{ text: `${this.words.absolute} ${bracket(inner)}`, kind: "open" }, close + 1];
    // An interval can open with one bracket and close with another: "[2, più infinito)".
    if (!"([{".includes(first) || !")]}".includes(last)) throw new Unreadable();
    return [{ text: `${first}${inner?.text ?? ""}${last}`, kind: "closed" }, close + 1];
  }

  private fraction(at: number, to: number): [Term, number] {
    const [topFrom, topEnd, afterTop] = this.argument(at + 1, to);
    const [bottomFrom, bottomEnd, after] = this.argument(afterTop, to);
    // d/dx and ∂/∂x, with or without what is derived on top.
    const letter = "\\\\[A-Za-z]+|[A-Za-z]";
    const d = "\\\\mathrm\\{d\\}|d|\\\\partial";
    const over = new RegExp(`^(${d})(${letter})?$`).exec(this.raw(topFrom, topEnd));
    const by = new RegExp(`^(${d})(${letter})$`).exec(this.raw(bottomFrom, bottomEnd));
    if (over && by && (over[1] === "\\partial") === (by[1] === "\\partial")) {
      const partial = by[1] === "\\partial";
      const variable = this.sub(by[2]!)?.text ?? "";
      const derived = over[2] ? this.sub(over[2]) : null;
      return derived
        ? [{ text: this.words.derivativeOf(partial, bracket(derived), variable), kind: "open" }, after]
        : [{ text: this.words.derivative(partial, variable), kind: "link" }, after];
    }
    const top = this.read(topFrom, topEnd);
    const bottom = this.read(bottomFrom, bottomEnd);
    if (!top || !bottom) throw new Unreadable();
    return [{ text: `${bracket(top)} ${this.words.fraction} ${bracket(bottom)}`, kind: "open" }, after];
  }

  private root(at: number, to: number): [Term, number] {
    let next = this.skip(at + 1, to);
    let index: Term | null = null;
    if (this.is(next, to, "char", "[")) {
      const close = this.closing(next, to, "[", "]");
      if (close < 0) throw new Unreadable();
      index = this.read(next + 1, close);
      next = close + 1;
    }
    const [from, end, after] = this.argument(next, to);
    const inner = this.read(from, end);
    if (!inner) throw new Unreadable();
    return [{ text: `${this.words.root(index ? bracket(index) : null)} ${bracket(inner)}`, kind: "open" }, after];
  }

  /** An integral, a sum, a product or a limit, with the limits written under and over it. */
  private ranged(name: "int" | "sum" | "prod" | "lim", at: number, to: number): [Term, number] {
    let next = at + 1;
    let low: string | undefined;
    let high: string | undefined;
    for (;;) {
      const here = this.skip(next, to);
      const under = this.is(here, to, "char", "_");
      if (!under && !this.is(here, to, "char", "^")) break;
      const [from, end, after] = this.argument(here + 1, to);
      const text = this.read(from, end)?.text;
      if (under) low = text;
      else high = text;
      next = after;
    }
    // An upper bound with no lower one has no wording here: a reading without it would be a wrong one.
    if (high && (!low || name === "lim")) throw new Unreadable();
    const words = this.words;
    const text =
      name === "lim"
        ? words.limit(low)
        : (name === "int" ? words.integral : name === "sum" ? words.sum : words.product)(low, high);
    return [{ text, kind: "link" }, next];
  }

  /** A function with its power or base and its argument: "seno al quadrato di x", "logaritmo in base 2 di 8". */
  private applied(name: string, word: string, from: number, to: number): [Term, number] {
    let next = from;
    let power: string | null = null;
    let base: Term | null = null;
    for (;;) {
      const here = this.skip(next, to);
      const under = this.is(here, to, "char", "_");
      if (!under && !this.is(here, to, "char", "^")) break;
      const [start, end, after] = this.argument(here + 1, to);
      if (under) base = this.read(start, end);
      else power = this.exponent(start, end);
      next = after;
    }
    const words = this.words;
    let label = base ? (name === "log" ? words.logBase(bracket(base)) : `${word} ${words.index} ${bracket(base)}`) : word;
    if (power) label += ` ${power}`;
    const here = this.skip(next, to);
    if (here >= to) return [{ text: label, kind: "closed" }, next];
    // The argument: what is in the brackets after the name, or the term after it.
    const [argument, after] = this.term(here, to);
    if (!argument || argument.kind === "link") return [{ text: label, kind: "closed" }, next];
    const bracketed = argument.kind === "closed" && /^\(.*\)$/s.test(argument.text);
    const bare = bracketed ? this.plain(here, to) : null;
    return [{ text: `${label} ${words.of} ${bare ?? bracket(argument)}`, kind: "open" }, after];
  }

  /** What is inside the round brackets that open at `at`, without them when it is a single term: "x", not "(x)". */
  private plain(at: number, to: number): string | null {
    const left = this.is(at, to, "command", "left");
    const open = left ? this.skip(at + 1, to) : at;
    if (!this.is(open, to, "char", "(")) return null;
    const end = left ? this.right(open, to) : this.closing(open, to, "(", ")");
    const inner = end < 0 ? null : this.read(open + 1, end);
    return inner && inner.kind !== "open" && inner.kind !== "link" ? inner.text : null;
  }
}

/**
 * One formula in words, as a person would read it aloud: "integrale da 0 a 1 di x al quadrato in dx". Letters, numbers
 * and Greek letters stay as written, and brackets mark what belongs together. Null when the formula is empty or holds
 * something this has no words for: no reading is better than a wrong one.
 */
export function formulaWords(latex: string, language: ReadingLanguage): string | null {
  try {
    return new Reader(tokens(latex), WORDS[language]).read()?.text.replace(/\s+/g, " ").trim() || null;
  } catch (error) {
    if (error instanceof Unreadable) return null;
    throw error;
  }
}

/**
 * A written answer as it reads, its `$…$` formulas in words and its other text as it is. Null when the answer holds no
 * formula, since it then reads as it is typed, or holds one that cannot be read.
 */
export function answerReading(input: string, language: ReadingLanguage): string | null {
  const spans = mathSpans(input);
  if (!spans.length) return null;
  let out = "";
  let at = 0;
  for (const [start, end] of spans) {
    const raw = input.slice(start, end);
    const words = formulaWords(raw.startsWith("$$") ? raw.slice(2, -2) : raw.slice(1, -1), language);
    if (!words) return null;
    out += `${input.slice(at, start)} ${words} `;
    at = end;
  }
  return (out + input.slice(at)).replace(/\s+/g, " ").trim();
}
