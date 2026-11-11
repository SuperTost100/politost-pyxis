import { describe, expect, it } from "vitest";
import { focusAfterRemoval, mapMenu, requestName, type MapMenuEntry } from "./mapMenu";

/** The menu as its keys, a submenu's after its parent, and the hairline as "-". */
function keys(entries: MapMenuEntry[]): string[] {
  return entries.flatMap((entry) =>
    entry.kind === "divider" ? ["-"] : [entry.key, ...(entry.children ? keys(entry.children).map((key) => `  ${key}`) : [])],
  );
}
const off = (entries: MapMenuEntry[]): string[] =>
  entries.flatMap((entry) => (entry.kind === "action" ? [...(entry.disabled ? [entry.key] : []), ...off(entry.children ?? [])] : []));

describe("a map's menu", () => {
  it("holds Rinomina, Esporta with its formats, a hairline and the soft red delete on the map page", () => {
    const menu = mapMenu({ view: true });
    expect(keys(menu)).toEqual([
      "rename",
      "export",
      "  export-markdown",
      "  export-svg",
      "  export-pdf",
      "  export-png",
      "-",
      "delete",
    ]);
    expect(menu.find((entry) => entry.kind === "action" && entry.key === "delete")).toMatchObject({ danger: true });
    expect(off(menu)).toEqual([]);
  });

  it("starts with Apri on a tile, which has no view on screen to save as a picture", () => {
    expect(keys(mapMenu({ tile: true }))).toEqual([
      "open",
      "rename",
      "export",
      "  export-markdown",
      "  export-svg",
      "  export-pdf",
      "-",
      "delete",
    ]);
  });

  it("offers only to delete a map still being written, which stops its build", () => {
    expect(off(mapMenu({ view: true, writing: true }))).toEqual(["rename", "export"]);
  });

  it("lets a rename wait while the map is changing, and an export while another runs", () => {
    expect(off(mapMenu({ view: true, busy: true }))).toEqual(["rename"]);
    expect(off(mapMenu({ view: true, exporting: true }))).toEqual([
      "export-markdown",
      "export-svg",
      "export-pdf",
      "export-png",
    ]);
  });
});

describe("naming a map by its request", () => {
  it("quotes what the student asked for, and names a map made without a request as the whole map", () => {
    expect(requestName({ instruction: " solo i teoremi " }, "Mappa completa")).toBe("«solo i teoremi»");
    expect(requestName({ instruction: null }, "Mappa completa")).toBe("Mappa completa");
    expect(requestName({ instruction: "   " }, "Mappa completa")).toBe("Mappa completa");
    expect(requestName({}, "Whole map")).toBe("Whole map");
  });
});

describe("focus after a tile leaves", () => {
  it("goes to the tile that takes its place, else the one before, else to the page", () => {
    expect(focusAfterRemoval(["a", "b", "c"], "b")).toBe("c");
    expect(focusAfterRemoval(["a", "b", "c"], "c")).toBe("b");
    expect(focusAfterRemoval(["a"], "a")).toBeUndefined();
    expect(focusAfterRemoval(["a", "b"], "gone")).toBe("a");
  });
});
