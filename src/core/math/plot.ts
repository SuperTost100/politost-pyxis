// ponytail: recursive descent for + - * / ^, x, and sin/cos/tan/exp/log/sqrt/abs.
// Upgrade path is math.js when the grammar needs assignments or matrices.

type Tok = { kind: "num"; value: number } | { kind: "id"; value: string } | { kind: "op"; value: string };

export function evalExpr(source: string, x: number): number {
  const tokens = tokenize(source);
  let i = 0;
  function peek(): Tok | undefined {
    return tokens[i];
  }
  function eat(value?: string): Tok {
    const tok = tokens[i];
    if (!tok) throw new Error("expr-end");
    if (value != null && tok.value !== value) throw new Error("expr-token");
    i += 1;
    return tok;
  }
  function parseExpr(): number {
    let left = parseTerm();
    while (peek()?.kind === "op" && (peek()?.value === "+" || peek()?.value === "-")) {
      const op = eat().value;
      const right = parseTerm();
      left = op === "+" ? left + right : left - right;
    }
    return left;
  }
  function parseTerm(): number {
    let left = parsePow();
    while (peek()?.kind === "op" && (peek()?.value === "*" || peek()?.value === "/")) {
      const op = eat().value;
      const right = parsePow();
      left = op === "*" ? left * right : left / right;
    }
    return left;
  }
  function parsePow(): number {
    const base = parseUnary();
    if (peek()?.kind === "op" && peek()?.value === "^") {
      eat("^");
      return base ** parseUnary();
    }
    return base;
  }
  function parseUnary(): number {
    if (peek()?.kind === "op" && peek()?.value === "-") {
      eat("-");
      return -parseUnary();
    }
    return parsePrimary();
  }
  function parsePrimary(): number {
    const tok = peek();
    if (!tok) throw new Error("expr-end");
    if (tok.kind === "num") {
      eat();
      return tok.value;
    }
    if (tok.kind === "op" && tok.value === "(") {
      eat("(");
      const value = parseExpr();
      eat(")");
      return value;
    }
    if (tok.kind === "id") {
      eat();
      if (tok.value === "x") return x;
      eat("(");
      const arg = parseExpr();
      eat(")");
      return applyFn(tok.value, arg);
    }
    throw new Error("expr-token");
  }
  const value = parseExpr();
  if (i !== tokens.length) throw new Error("expr-tail");
  return value;
}

export function derivative(source: string, x: number, h = 1e-4): number {
  return (evalExpr(source, x + h) - evalExpr(source, x - h)) / (2 * h);
}

export function secondDerivative(source: string, x: number, h = 1e-4): number {
  return (evalExpr(source, x + h) - 2 * evalExpr(source, x) + evalExpr(source, x - h)) / (h * h);
}

export function simpson(source: string, a: number, b: number, n = 200): number {
  const steps = n % 2 === 0 ? n : n + 1;
  const h = (b - a) / steps;
  let sum = evalExpr(source, a) + evalExpr(source, b);
  for (let i = 1; i < steps; i += 1) {
    const weight = i % 2 === 0 ? 2 : 4;
    sum += weight * evalExpr(source, a + i * h);
  }
  return (sum * h) / 3;
}

export function sample(source: string, a: number, b: number, n = 240): Array<{ x: number; y: number }> {
  const points: Array<{ x: number; y: number }> = [];
  for (let i = 0; i <= n; i += 1) {
    const x = a + ((b - a) * i) / n;
    const y = evalExpr(source, x);
    if (Number.isFinite(y)) points.push({ x, y });
  }
  return points;
}

function applyFn(name: string, arg: number): number {
  if (name === "sin") return Math.sin(arg);
  if (name === "cos") return Math.cos(arg);
  if (name === "tan") return Math.tan(arg);
  if (name === "exp") return Math.exp(arg);
  if (name === "log") return Math.log(arg);
  if (name === "sqrt") return Math.sqrt(arg);
  if (name === "abs") return Math.abs(arg);
  throw new Error("expr-fn");
}

function tokenize(source: string): Tok[] {
  const tokens: Tok[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i] ?? "";
    if (ch.trim() === "") {
      i += 1;
      continue;
    }
    if (/[0-9.]/.test(ch)) {
      let raw = ch;
      i += 1;
      while (i < source.length && /[0-9.]/.test(source[i] ?? "")) {
        raw += source[i];
        i += 1;
      }
      tokens.push({ kind: "num", value: Number(raw) });
      continue;
    }
    if (/[a-zA-Z]/.test(ch)) {
      let raw = ch;
      i += 1;
      while (i < source.length && /[a-zA-Z]/.test(source[i] ?? "")) {
        raw += source[i];
        i += 1;
      }
      tokens.push({ kind: "id", value: raw });
      continue;
    }
    tokens.push({ kind: "op", value: ch });
    i += 1;
  }
  return tokens;
}
