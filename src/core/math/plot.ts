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
    let left = parseUnary();
    while (peek()?.kind === "op" && (peek()?.value === "*" || peek()?.value === "/")) {
      const op = eat().value;
      const right = parseUnary();
      left = op === "*" ? left * right : left / right;
    }
    return left;
  }
  function parseUnary(): number {
    if (peek()?.kind === "op" && peek()?.value === "-") {
      eat("-");
      return -parsePow();
    }
    return parsePow();
  }
  function parsePow(): number {
    const base = parsePrimary();
    if (peek()?.kind === "op" && peek()?.value === "^") {
      eat("^");
      return base ** parseUnary();
    }
    return base;
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

export function splitSeries(points: Array<{ x: number; y: number }>) {
  const slopes: number[] = [];
  const gaps: number[] = [];
  for (let index = 1; index < points.length; index++) {
    const prev = points[index - 1];
    const point = points[index];
    if (!prev || !point) continue;
    const dx = point.x - prev.x;
    if (dx <= 0) continue;
    gaps.push(dx);
    slopes.push((point.y - prev.y) / dx);
  }
  gaps.sort((a, b) => a - b);
  const step = gaps[0] ?? Number.POSITIVE_INFINITY;
  const magnitudes = slopes.map((slope) => Math.abs(slope)).sort((a, b) => a - b);
  const typical = magnitudes[Math.floor(magnitudes.length / 2)] ?? 0;
  const groups: Array<Array<{ x: number; y: number }>> = [];
  let current: Array<{ x: number; y: number }> = [];
  points.forEach((point, index) => {
    const prev = current[current.length - 1];
    const slope = slopes[index - 1];
    const left = slopes[index - 2];
    const right = slopes[index];
    const pole =
      slope != null &&
      left != null &&
      right != null &&
      left * right > 0 &&
      slope * left < 0 &&
      Math.abs(slope) > 8 * Math.max(typical, 1e-9);
    if (prev && (point.x - prev.x > step * 1.5 || pole)) {
      groups.push(current);
      current = [];
    }
    current.push(point);
  });
  if (current.length > 0) groups.push(current);
  return groups;
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
