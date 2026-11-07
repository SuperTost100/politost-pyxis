import { describe, expect, it } from "vitest";
import { describeChange } from "./mapChange";

const map = [
  { id: "r", label: "Cinematica", parent: null },
  { id: "a", label: "Moto nel piano", parent: "r" },
];

describe("describeChange", () => {
  it("names the one concept added and its parent", () => {
    expect(
      describeChange(map, [
        ...map,
        { id: "b", label: "Moto circolare", parent: "a" },
      ]),
    ).toEqual({
      kind: "added",
      label: "Moto circolare",
      parent: "Moto nel piano",
    });
  });

  it("says only that the map changed when the edit did more than add one concept", () => {
    const one = { id: "b", label: "Moto circolare", parent: "a" };
    const two = { id: "c", label: "Moto parabolico", parent: "a" };
    expect(describeChange(map, [...map, one, two])).toEqual({
      kind: "changed",
    });
    expect(
      describeChange(map, [map[0]!, { ...map[1]!, label: "Moto" }, one]),
    ).toEqual({ kind: "changed" });
    expect(describeChange(map, [map[0]!, one])).toEqual({ kind: "changed" });
    expect(describeChange(map, map)).toEqual({ kind: "changed" });
  });
});
