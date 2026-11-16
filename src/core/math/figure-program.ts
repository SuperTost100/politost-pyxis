import type { FigureData } from "../../shared/smart-text";

/**
 * The model's code between a fixed prologue and the `plt.show()` that hands the open figure to the sandbox. A circuit
 * adds its elements to the drawing `d`, which is drawn after the code in dark ink at a size that reads in a lesson.
 * schemdraw sizes the figure to the circuit, and the tight box keeps a label that reaches past it.
 */
export function figureProgram(figure: FigureData): string {
  if (figure.figureKind === "circuit")
    return [
      "import matplotlib",
      "matplotlib.use('Agg')",
      "import matplotlib.pyplot as plt",
      "plt.close('all')",
      "plt.rcParams.update({'savefig.bbox': 'tight', 'savefig.pad_inches': 0.15})",
      "import schemdraw",
      "import schemdraw.elements as elm",
      "schemdraw.use('matplotlib')",
      "d = schemdraw.Drawing(show=False)",
      "d.config(inches_per_unit=0.8, fontsize=12, lw=1.8, color='#15181e')",
      figure.code,
      "if d.elements:",
      "    d.draw(show=False).getfig()",
      "plt.show()",
    ].join("\n");
  return [
    "import matplotlib",
    "matplotlib.use('Agg')",
    "import matplotlib.pyplot as plt",
    "import numpy as np",
    "plt.close('all')",
    "plt.rcParams.update({'figure.figsize': (6.4, 4.0), 'font.size': 11, 'axes.grid': True, 'grid.alpha': 0.3})",
    figure.code,
    "plt.show()",
  ].join("\n");
}
