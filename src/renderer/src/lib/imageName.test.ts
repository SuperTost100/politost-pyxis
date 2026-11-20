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
});
