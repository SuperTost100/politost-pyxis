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

export function splitSeries(
  points: Array<{ x: number; y: number }>,
  at?: (x: number) => number,
) {
  const gaps: number[] = [];
  for (let index = 1; index < points.length; index++) {
    const dx = (points[index]?.x ?? 0) - (points[index - 1]?.x ?? 0);
    if (dx > 0) gaps.push(dx);
  }
  gaps.sort((a, b) => a - b);
  const step = gaps[0] ?? Number.POSITIVE_INFINITY;
  const groups: Array<Array<{ x: number; y: number }>> = [];
  let current: Array<{ x: number; y: number }> = [];
  for (const point of points) {
    const prev = current[current.length - 1];
    if (prev && (point.x - prev.x > step * 1.5 || !connects(prev, point, at))) {
      groups.push(current);
      current = [];
    }
    current.push(point);
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

// ponytail: bisection, then a geometric walk. A finite peak that stops climbing stays one stroke. Upgrade path is a denser sample or a CAS.
function connects(
  prev: { x: number; y: number },
  point: { x: number; y: number },
  at: ((x: number) => number) | undefined,
  depth = 0,
  origin = 0,
): boolean {
  if (!at) return true;
  const root =
    depth === 0 ? Math.max(Math.abs(prev.y), Math.abs(point.y), 1e-12) : origin;
  let mid = Number.NaN;
  try {
    mid = at((prev.x + point.x) / 2);
  } catch {
    return false;
  }
  if (!Number.isFinite(mid)) return false;
  const chord = (prev.y + point.y) / 2;
  const scale = Math.max(1e-9, Math.min(Math.abs(prev.y), Math.abs(point.y), Math.abs(mid)));
  const span = Math.max(Math.abs(prev.y), Math.abs(point.y), Math.abs(mid));
  if (Math.abs(mid - chord) <= 0.25 * scale && span <= 8 * scale) return true;
  if (depth >= 16) return !unresolvedPole(prev, point, mid, at, root);
  const middle = { x: (prev.x + point.x) / 2, y: mid };
  return (
    connects(prev, middle, at, depth + 1, root) &&
    connects(middle, point, at, depth + 1, root)
  );
}

function unresolvedPole(
  prev: { x: number; y: number },
  point: { x: number; y: number },
  mid: number,
  at: (x: number) => number,
  origin: number,
) {
  const bound = Math.max(Math.abs(prev.y), Math.abs(point.y), 1e-9);
  const ceiling = Math.max(origin, bound);
  if (prev.y * point.y < 0 && tallerInside(prev, point, at, bound)) return true;
  if (Math.abs(mid) > 8 * ceiling) return true;
  for (const t of [0.2, 0.4, 0.6, 0.8]) {
    let probe = Number.NaN;
    try {
      probe = at(prev.x + (point.x - prev.x) * t);
    } catch {
      return true;
    }
    if (!Number.isFinite(probe) || Math.abs(probe) > 8 * ceiling) return true;
  }
  return false;
}

// The last cell can hide a pole beside the bigger sample. A smooth zero stays at or below that sample.
function tallerInside(
  prev: { x: number; y: number },
  point: { x: number; y: number },
  at: (x: number) => number,
  limit: number,
) {
  const magnitude = (x: number) => {
    try {
      const y = at(x);
      return Number.isFinite(y) ? Math.abs(y) : Number.POSITIVE_INFINITY;
    } catch {
      return Number.POSITIVE_INFINITY;
    }
  };
  const width = point.x - prev.x;
  for (let k = 1; k <= 48; k++) {
    const step = width * 2 ** -k;
    if (keepsClimbing(prev.x + step, step, magnitude, limit)) return true;
    if (keepsClimbing(point.x - step, step, magnitude, limit)) return true;
  }
  return false;
}

function keepsClimbing(
  start: number,
  step: number,
  magnitude: (x: number) => number,
  limit: number,
) {
  let x = start;
  let mag = magnitude(x);
  if (mag <= limit) return false;
  let h = step;
  for (let i = 0; i < 40; i++) {
    h /= 2;
    if (x + h === x) return mag > limit * 8;
    const left = magnitude(x - h);
    const right = magnitude(x + h);
    if (!Number.isFinite(left) || !Number.isFinite(right)) return true;
    const next = Math.max(left, right);
    if (next <= mag) {
      let hh = h;
      let bounded = true;
      for (let j = 0; j < 16; j++) {
        hh /= 2;
        if (x + hh === x) break;
        const nearer = Math.max(magnitude(x - hh), magnitude(x + hh));
        if (!Number.isFinite(nearer)) return true;
        if (nearer > mag) {
          bounded = false;
          mag = nearer;
          x = magnitude(x - hh) >= magnitude(x + hh) ? x - hh : x + hh;
          h = hh;
          break;
        }
      }
      if (bounded) return false;
      continue;
    }
    mag = next;
    x = left >= right ? x - h : x + h;
  }
  return true;
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
