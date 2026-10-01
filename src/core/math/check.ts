import { derivative, evalExpr } from "./plot";

export type CheckClaim = {
  kind: string;
  expr: string;
  claimed: string;
};

export type CheckState = "verified" | "failed" | "none";

const POINTS = [0.4, 0.8, 1.2, 1.7, 2.1, 2.6, -0.6, -1.4];

function source(text: string): string {
  return text.replaceAll("**", "^").trim();
}

function close(left: number, right: number): boolean {
  if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
  const scale = Math.max(1, Math.abs(left), Math.abs(right));
  return Math.abs(left - right) <= scale * 1e-3;
}

function agrees(left: (x: number) => number, right: (x: number) => number) {
  return POINTS.every((x) => close(left(x), right(x)));
}

/** Numeric stand-in for a SymPy check. The expressions use SymPy's ** for powers. */
export function checkClaim(input: CheckClaim): CheckState {
  const expr = source(input.expr);
  const claimed = source(input.claimed);
  if (!expr || !claimed) return "none";
  try {
    if (input.kind === "derivative") {
      return agrees((x) => derivative(expr, x), (x) => evalExpr(claimed, x))
        ? "verified"
        : "failed";
    }
    if (input.kind === "integral") {
      return agrees((x) => evalExpr(expr, x), (x) => derivative(claimed, x))
        ? "verified"
        : "failed";
    }
    if (input.kind === "equal" || input.kind === "simplify") {
      return agrees((x) => evalExpr(expr, x), (x) => evalExpr(claimed, x))
        ? "verified"
        : "failed";
    }
    if (input.kind === "solve") {
      const roots = claimed.split(",").map((part) => Number(part.trim()));
      if (roots.length === 0 || roots.some((root) => !Number.isFinite(root))) return "failed";
      return roots.every((root) => close(evalExpr(expr, root), 0)) ? "verified" : "failed";
    }
  } catch {
    return "failed";
  }
  return "none";
}
