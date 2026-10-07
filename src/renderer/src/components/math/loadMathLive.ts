type MathLive = typeof import("mathlive");

let loading: Promise<MathLive> | null = null;
let loaded: MathLive | null = null;

/** MathLive, once it has loaded. Editors call `loadMathLive` early so the first formula opens at once. */
export function mathLive(): MathLive | null {
  return loaded;
}

/** Loads MathLive the first time a student focuses a field that can hold a formula. */
export function loadMathLive(): Promise<MathLive> {
  loading ??= import("mathlive").then((module) => {
    // The app serves everything from its own bundle. The glyphs come from the KaTeX fonts that
    // katex.min.css already declares, and nothing is fetched or played.
    const { MathfieldElement } = module;
    MathfieldElement.fontsDirectory = null;
    MathfieldElement.soundsDirectory = null;
    MathfieldElement.computeEngine = null;
    MathfieldElement.keypressSound = null;
    MathfieldElement.plonkSound = null;
    loaded = module;
    return module;
  });
  return loading;
}
