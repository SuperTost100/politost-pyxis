import { describe, expect, it } from "vitest";
import { imageFileName } from "./imageName";

describe("imageFileName", () => {
  it("makes a plain PNG name from the caption", () => {
    expect(imageFileName("La velocità cresce di 1,5 m/s ogni secondo.", "figura")).toBe(
      "la-velocita-cresce-di-1-5-m-s-ogni-secondo.png",
    );
  });

  it("cuts a long caption at a word", () => {
    const name = imageFileName(
      "Un circuito con una resistenza in serie a un condensatore e a un generatore di tensione alternata",
      "figura",
    );
    expect(name.length).toBeLessThanOrEqual(64);
    expect(name.endsWith("-.png")).toBe(false);
    expect(name).toMatch(/^[a-z0-9-]+\.png$/);
  });

  it("falls back when the caption has no letters or digits, and never carries a path", () => {
    expect(imageFileName("", "figura")).toBe("figura.png");
    expect(imageFileName("../../etc/passwd", "figura")).toBe("etc-passwd.png");
    expect(imageFileName("∑ ∫ ≠", "figura")).toBe("figura.png");
  });

  it("never gives a name Windows reserves for a device, whatever the case", () => {
    for (const caption of ["AUX", "con", "Nul", "PRN", "COM1", "lpt9", "COM0", "Com5."])
      expect(imageFileName(caption, "figura"), caption).toBe("figura.png");
    // A reserved word inside a longer name is an ordinary name.
    expect(imageFileName("AUX plot", "figura")).toBe("aux-plot.png");
    expect(imageFileName("COM10", "figura")).toBe("com10.png");
  });
});
