/**
 * What a ```pyxis-figure block can draw. A block names its kind in `kind`, and one without it is a plot. Each kind has
 * the limits its code must keep and the downloaded packs that draw it, so core, the renderer and the tests read one
 * table.
 */

/** The packs the student downloads from the Python page: Python itself, and the files that draw the other figures. */
export const runtimePackIds = ["pyodide", "drawing"] as const;
export type PackId = (typeof runtimePackIds)[number];

type KindRules = {
  /** Longest code, in characters. */
  codeMax: number;
  /** Run time of one drawing. The Python sandbox caps a run at 10 s. */
  timeoutMs: number;
  /** Every pack the kind needs before it can be drawn. */
  packs: readonly PackId[];
};

export const FIGURE_KINDS = {
  /** Function plots, vectors and geometry: matplotlib code. */
  plot: { codeMax: 4000, timeoutMs: 8000, packs: ["pyodide"] },
  /** Electric and electronic circuits: schemdraw code, which draws through matplotlib. */
  circuit: { codeMax: 4000, timeoutMs: 8000, packs: ["pyodide", "drawing"] },
} as const satisfies Record<string, KindRules>;

export type FigureKind = keyof typeof FIGURE_KINDS;
export const figureKinds = Object.keys(FIGURE_KINDS) as FigureKind[];

/** The kind a block names: a plot when it names none, and null when it names one this Pyxis does not draw. */
export function figureKind(value: unknown): FigureKind | null {
  if (value == null) return "plot";
  const name = typeof value === "string" ? value.trim().toLowerCase() : null;
  if (name === "") return "plot";
  return name != null && Object.hasOwn(FIGURE_KINDS, name)
    ? (name as FigureKind)
    : null;
}

/** Why the code cannot be drawn as this kind, in words for the model that wrote it, or null when it passes. */
export function figureProblem(kind: FigureKind, code: string): string | null {
  const { codeMax } = FIGURE_KINDS[kind];
  return code.length > codeMax
    ? `the code has ${code.length} characters: keep it within ${codeMax}`
    : null;
}

/** The kinds that can be drawn with the packs that are `ready`. */
export function drawableKinds(ready: (pack: PackId) => boolean): FigureKind[] {
  return figureKinds.filter((kind) => FIGURE_KINDS[kind].packs.every(ready));
}
