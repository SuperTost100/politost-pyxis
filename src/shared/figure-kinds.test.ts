import { expect, it } from "vitest";
import {
  FIGURE_KINDS,
  drawableKinds,
  figureKind,
  figureKinds,
  figureProblem,
} from "./figure-kinds";

it("reads the kind a block names: a plot when it names none, nothing for a kind this Pyxis does not draw", () => {
  expect(figureKinds).toEqual(["plot", "circuit"]);
  expect(figureKind(undefined)).toBe("plot");
  expect(figureKind(null)).toBe("plot");
  expect(figureKind("  ")).toBe("plot");
  expect(figureKind("circuit")).toBe("circuit");
  expect(figureKind(" Circuit ")).toBe("circuit");
  expect(figureKind("molecule")).toBeNull();
  expect(figureKind("constructor")).toBeNull();
  expect(figureKind(7)).toBeNull();
});

it("holds a circuit to 4,000 characters and 8 seconds, with a message the model can act on", () => {
  expect(FIGURE_KINDS.circuit).toMatchObject({ codeMax: 4000, timeoutMs: 8000 });
  expect(figureProblem("circuit", "d += elm.Resistor()")).toBeNull();
  expect(figureProblem("circuit", "x".repeat(4000))).toBeNull();
  expect(figureProblem("circuit", "x".repeat(4001))).toBe(
    "the code has 4001 characters: keep it within 4000",
  );
  expect(figureProblem("plot", "x".repeat(4001))).not.toBeNull();
});

it("draws a plot with Python alone and a circuit only with the drawing pack too", () => {
  expect(drawableKinds(() => true)).toEqual(["plot", "circuit"]);
  expect(drawableKinds((pack) => pack === "pyodide")).toEqual(["plot"]);
  // The drawing pack without Python draws nothing: schemdraw runs in the Python sandbox.
  expect(drawableKinds((pack) => pack === "drawing")).toEqual([]);
  expect(drawableKinds(() => false)).toEqual([]);
});
