// ponytail: recursive descent for + - * / ^, x, and sin/cos/tan/exp/log/sqrt/abs.
// Upgrade path is math.js when the grammar needs assignments or matrices.

type Tok =
  | { kind: "num"; value: number }
  | { kind: "id"; value: string }
  | { kind: "op"; value: string };

export function evalExpr(source: string, x: number): number {
  return compileExpr(source)(x);
}

/**
 * Parses a formula once into a function of x, for a curve that evaluates it at many points. It throws the same errors
 * evalExpr does, since evalExpr is this followed by one call.
 */
export function compileExpr(source: string): (x: number) => number {
  const tokens = tokenize(source);
  let i = 0;
  type Node = (x: number) => number;
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
  function parseExpr(): Node {
    let left = parseTerm();
    while (
      peek()?.kind === "op" &&
      (peek()?.value === "+" || peek()?.value === "-")
    ) {
      const op = eat().value;
      const right = parseTerm();
      const a = left;
      left = op === "+" ? (x) => a(x) + right(x) : (x) => a(x) - right(x);
    }
    return left;
  }
  function parseTerm(): Node {
    let left = parseUnary();
    while (
      peek()?.kind === "op" &&
      (peek()?.value === "*" || peek()?.value === "/")
    ) {
      const op = eat().value;
      const right = parseUnary();
      const a = left;
      left = op === "*" ? (x) => a(x) * right(x) : (x) => a(x) / right(x);
    }
    return left;
  }
  function parseUnary(): Node {
    if (peek()?.kind === "op" && peek()?.value === "-") {
      eat("-");
      const value = parsePow();
      return (x) => -value(x);
    }
    return parsePow();
  }
  function parsePow(): Node {
    const base = parsePrimary();
    if (peek()?.kind === "op" && peek()?.value === "^") {
      eat("^");
      const exponent = parseUnary();
      return (x) => base(x) ** exponent(x);
    }
    return base;
  }
  function parsePrimary(): Node {
    const tok = peek();
    if (!tok) throw new Error("expr-end");
    if (tok.kind === "num") {
      eat();
      const value = tok.value;
      return () => value;
    }
    if (tok.kind === "op" && tok.value === "(") {
      eat("(");
      const value = parseExpr();
      eat(")");
      return value;
    }
    if (tok.kind === "id") {
      eat();
      if (tok.value === "x") return (x) => x;
      if (tok.value === "pi") return () => Math.PI;
      if (tok.value === "e") return () => Math.E;
      eat("(");
      const arg = parseExpr();
      eat(")");
      const fn = mathFn(tok.value);
      return (x) => fn(arg(x));
    }
    throw new Error("expr-token");
  }
  const value = parseExpr();
  if (i !== tokens.length) throw new Error("expr-tail");
  return value;
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
  const scale = Math.max(
    1e-9,
    Math.min(Math.abs(prev.y), Math.abs(point.y), Math.abs(mid)),
  );
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

const MATH_FNS: Record<string, (arg: number) => number> = {
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  exp: Math.exp,
  log: Math.log,
  sqrt: Math.sqrt,
  abs: Math.abs,
};

function mathFn(name: string): (arg: number) => number {
  const fn = Object.hasOwn(MATH_FNS, name) ? MATH_FNS[name] : undefined;
  if (!fn) throw new Error("expr-fn");
  return fn;
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
      const raw = source.slice(i).match(/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/)?.[0];
      if (!raw) throw new Error("expr-number");
      i += raw.length;
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
