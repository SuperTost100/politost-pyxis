import { evalExpr, splitSeries } from "./plot";
export type GraphPoint = { x: number; y: number };
export type GraphRange = [number, number];

/** Keep the existing scalar grammar; normalize common LaTeX wrappers before parsing. */
export function graphExpression(input: string): string {
  if (!input.trim() || input.length > 500) throw new Error("graph-expression");
  let source = input
    .trim()
    .replace(/^\$+|\$+$/g, "")
    .replace(/\\(?:left|right)/g, "")
    .replace(/\\(?:cdot|times)/g, "*")
    .replace(/\\(?:,|;|!|quad)/g, "")
    .replace(/\\(?:sin|cos|tan|exp|log|ln|sqrt|abs|pi)\b/g, (x) =>
      x.slice(1).replace(/^ln$/, "log"),
    )
    // Plain ln, the Italian sen and π map to the grammar's names.
    .replace(/(?<=^|[^a-zA-Z]|(?:^|[^a-zA-Z])x)(ln|sen)(?![a-zA-Z])/g, (name) =>
      name === "ln" ? "log" : "sin",
    )
    .replace(/π/g, " pi ")
    // The grammar has no argument lists, so a comma between digits can only be a decimal comma.
    .replace(/(\d)(?:,|\{,\})(?=\d)/g, "$1.");
  let cursor = 0;
  function group(): string {
    if (source[cursor] !== "{") throw new Error("graph-latex");
    cursor++;
    const result = fragment(true);
    if (source[cursor++] !== "}") throw new Error("graph-latex");
    return result;
  }
  function fragment(nested = false): string {
    let result = "";
    while (cursor < source.length && !(nested && source[cursor] === "}")) {
      const frac = source.slice(cursor).match(/^\\(?:d?frac)/);
      if (frac) {
        cursor += frac[0].length;
        const numerator = group(),
          denominator = group();
        result += `((${numerator})/(${denominator}))`;
      } else if (source.slice(cursor).startsWith("sqrt{")) {
        cursor += 4;
        result += `sqrt(${group()})`;
      } else if (source[cursor] === "{") result += `(${group()})`;
      else result += source[cursor++];
    }
    return result;
  }
  source = fragment();
  source = source
    .replace(/\|([^|]+)\|/g, "abs($1)")
    .replace(/\b(sin|cos|tan|exp|log|sqrt|abs)\^(\d+)\(([^()]*)\)/g, "($1($3))^$2")
    .replace(/\b(sin|cos|tan|exp|log|sqrt|abs)\s+(x|pi|e)\b/g, "$1($2)");
  source = source
    .replace(/\*\*/g, "^")
    .replace(/\s+/g, "")
    .replace(/(\d)(?=x|pi|e\b(?![+-]?\d)|sin|cos|tan|exp|log|sqrt|abs|\()/g, "$1*")
    .replace(/\)(?=x|pi|e\b|sin|cos|tan|exp|log|sqrt|abs|\d|\()/g, ")*")
    .replace(/x(?=pi|e\b|sin|cos|tan|exp|log|sqrt|abs)/g, "x*")
    .replace(/pi(?=x|e\b|sin|cos|tan|exp|log|sqrt|abs|\()/g, "pi*")
    .replace(/\bx(?=\()/g, "x*");
  // Unknown names and trailing tokens are rejected by the same evaluator used for curves.
  evalExpr(source, 0.37);
  return source;
}
export function graphLatex(source: string): string {
  return source
    .replace(/\*/g, "\\cdot ")
    .replace(/\b(sin|cos|tan|exp|log)\b/g, "\\$1")
    .replace(/\bpi\b/g, "\\pi ")
    .replace(/\b(abs|sqrt)\b/g, "\\operatorname{$1}");
}
function finiteAt(source: string, x: number): number {
  const value = evalExpr(source, x);
  if (Number.isFinite(value)) return value;
  // A removable hole, such as sin(x)/x at zero, has matching finite one-sided limits.
  const h = Math.max(1, Math.abs(x)) * 1e-7;
  const a = evalExpr(source, x - h),
    b = evalExpr(source, x + h);
  return Number.isFinite(a) &&
    Number.isFinite(b) &&
    Math.abs(a - b) < 1e-5 * Math.max(1, Math.abs(a), Math.abs(b))
    ? (a + b) / 2
    : NaN;
}
export function analyzeGraph(
  source: string,
  range: GraphRange,
  lower: number,
  count = 160,
) {
  const [a, b] = range;
  if (
    ![a, b, lower].every(Number.isFinite) ||
    a >= b ||
    Math.max(Math.abs(a), Math.abs(b), Math.abs(lower)) > 1e6 ||
    b - a < 1e-7
  )
    throw new Error("graph-range");
  const at = (x: number) => finiteAt(source, x);
  const d1At = (x: number) => {
    const h = Math.max(1, Math.abs(x)) * 1e-4;
    return (at(x + h) - at(x - h)) / (2 * h);
  };
  const d2At = (x: number) => {
    const h = Math.max(1, Math.abs(x)) * 1e-4;
    return (at(x + h) - 2 * at(x) + at(x - h)) / (h * h);
  };
  const points = (fn: (x: number) => number) =>
    Array.from({ length: count + 1 }, (_, i) => {
      const x = a + ((b - a) * i) / count;
      return { x, y: fn(x) };
    }).filter((p) => Number.isFinite(p.y));
  const f = points(at),
    d1 = points(d1At),
    d2 = points(d2At);
  const domain = [Math.min(a, lower), Math.max(b, lower)];
  const integralGrid = Array.from({ length: count + 1 }, (_, i) => {
    const x = domain[0]! + ((domain[1]! - domain[0]!) * i) / count;
    return { x, y: at(x) };
  });
  if (!integralGrid.some((p) => p.x === lower))
    integralGrid.push({ x: lower, y: at(lower) });
  integralGrid.sort((p, q) => p.x - q.x);
  const group = splitSeries(
    integralGrid.filter((p) => Number.isFinite(p.y)),
    at,
  ).find((g) => g.some((p) => p.x === lower));
  const integral: GraphPoint[] = [];
  if (group) {
    const anchor = group.findIndex((p) => p.x === lower),
      totals = new Map<number, number>([[lower, 0]]);
    for (const direction of [-1, 1]) {
      let total = 0;
      for (let i = anchor; group[i + direction]; i += direction) {
        const p = group[i]!,
          q = group[i + direction]!,
          mid = at((p.x + q.x) / 2);
        if (!Number.isFinite(mid)) break;
        total += ((q.x - p.x) * (p.y + 4 * mid + q.y)) / 6;
        if (!Number.isFinite(total)) break;
        totals.set(q.x, total);
      }
    }
    for (const p of group)
      if (p.x >= a && p.x <= b && totals.has(p.x))
        integral.push({ x: p.x, y: totals.get(p.x)! });
  }
  return {
    f: splitSeries(f, at),
    d1: splitSeries(d1, d1At),
    d2: splitSeries(d2, d2At),
    integral: integral.length ? [integral] : [],
    at,
  };
}

/**
 * Where two curves meet in the range: sign changes of f − g refined by bisection, and touching points (a local minimum
 * of |f − g| that reaches zero) refined by golden-section search. A pole where f − g jumps across zero is not a meeting
 * point, and two curves that coincide have none to mark.
 */
export function graphIntersections(
  f: (x: number) => number,
  g: (x: number) => number,
  range: GraphRange,
  count = 600,
): GraphPoint[] {
  const [a, b] = range;
  if (!(b > a)) return [];
  const gap = (x: number) => f(x) - g(x);
  const meets = (x: number) => {
    const fx = f(x),
      gx = g(x);
    return (
      Number.isFinite(fx) &&
      Number.isFinite(gx) &&
      Math.abs(fx - gx) <= 1e-6 * Math.max(1, Math.abs(fx), Math.abs(gx))
    );
  };
  const xs = Array.from({ length: count + 1 }, (_, i) => a + ((b - a) * i) / count);
  const ds = xs.map(gap);
  if (xs.filter((x) => meets(x)).length > count / 2) return [];
  const found: number[] = [];
  for (let i = 0; i <= count; i++) {
    const d = ds[i]!;
    if (!Number.isFinite(d)) continue;
    if (d === 0) {
      found.push(xs[i]!);
      continue;
    }
    const next = ds[i + 1];
    if (next !== undefined && Number.isFinite(next) && next !== 0 && Math.sign(next) !== Math.sign(d)) {
      let lo = xs[i]!,
        hi = xs[i + 1]!,
        low = d;
      for (let step = 0; step < 80; step++) {
        const mid = (lo + hi) / 2,
          value = gap(mid);
        if (!Number.isFinite(value)) break;
        if (Math.sign(value) === Math.sign(low)) {
          lo = mid;
          low = value;
        } else hi = mid;
      }
      const x = (lo + hi) / 2;
      if (meets(x)) found.push(x);
    }
    const previous = ds[i - 1];
    if (
      previous !== undefined &&
      next !== undefined &&
      Number.isFinite(previous) &&
      Number.isFinite(next) &&
      Math.sign(previous) === Math.sign(d) &&
      Math.sign(next) === Math.sign(d) &&
      Math.abs(d) < Math.abs(previous) &&
      Math.abs(d) <= Math.abs(next)
    ) {
      const ratio = (Math.sqrt(5) - 1) / 2;
      let lo = xs[i - 1]!,
        hi = xs[i + 1]!;
      for (let step = 0; step < 80; step++) {
        const p = hi - ratio * (hi - lo),
          q = lo + ratio * (hi - lo);
        if (Math.abs(gap(p)) < Math.abs(gap(q))) hi = q;
        else lo = p;
      }
      const x = (lo + hi) / 2;
      if (meets(x)) found.push(x);
    }
  }
  const tolerance = (b - a) * 1e-6;
  return found
    .sort((p, q) => p - q)
    .filter((x, index, all) => index === 0 || x - all[index - 1]! > tolerance)
    .map((x) => ({ x, y: (f(x) + g(x)) / 2 }))
    .filter((point) => Number.isFinite(point.y))
    .slice(0, 50);
}
