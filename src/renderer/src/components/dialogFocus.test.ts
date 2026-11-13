import { describe, expect, it } from "vitest";
import { closingFocus, openingFocus, outsideClickCloses, stayingFocus, wrapTab } from "./dialogFocus";

describe("openingFocus", () => {
  const all = [
    { node: "delete", role: "danger" as const },
    { node: "close", role: "close" as const },
    { node: "archive", role: "action" as const },
    { node: "cancel", role: "cancel" as const },
    { node: "name", role: "field" as const },
  ];

  it("takes the element the page names", () => {
    expect(openingFocus("goal", all)).toBe("goal");
  });

  it("takes the first field, then Annulla, then a harmless button, then the X", () => {
    expect(openingFocus(null, all)).toBe("name");
    expect(openingFocus(null, all.filter((item) => item.role !== "field"))).toBe("cancel");
    expect(openingFocus(null, all.filter((item) => !["field", "cancel"].includes(item.role)))).toBe("archive");
    expect(openingFocus(null, all.filter((item) => ["danger", "close"].includes(item.role)))).toBe("close");
  });

  it("never gives the focus to a destructive button", () => {
    expect(openingFocus(null, [{ node: "delete", role: "danger" }])).toBeNull();
  });
});

describe("wrapTab", () => {
  it("wraps from the last stop to the first and back", () => {
    expect(wrapTab(3, 2, false)).toBe(0);
    expect(wrapTab(3, 0, true)).toBe(2);
  });

  it("leaves a move between stops to the browser", () => {
    expect(wrapTab(3, 0, false)).toBeNull();
    expect(wrapTab(3, 2, true)).toBeNull();
  });

  it("goes to the first or the last stop from the dialog itself", () => {
    expect(wrapTab(3, -1, false)).toBe(0);
    expect(wrapTab(3, -1, true)).toBe(2);
    expect(wrapTab(0, -1, false)).toBeNull();
  });
});

describe("closingFocus", () => {
  const onPage = (node: string) => node !== "gone";

  it("gives the focus back to the first choice still on the page", () => {
    expect(closingFocus(["field", "button"], onPage, true)).toBe("field");
    expect(closingFocus([null, "gone", "button"], onPage, true)).toBe("button");
  });

  it("leaves the focus alone when something else took it", () => {
    expect(closingFocus(["field"], onPage, false)).toBeNull();
  });

  it("has nowhere to go when every choice left the page", () => {
    expect(closingFocus(["gone", undefined], onPage, true)).toBeNull();
  });
});

describe("outsideClickCloses", () => {
  it("closes a dialog with no typed text", () => {
    expect(outsideClickCloses([], false)).toBe(true);
    expect(outsideClickCloses(["", "  "], false)).toBe(true);
  });

  it("keeps a dialog with typed text, and a busy one", () => {
    expect(outsideClickCloses(["", "Fisica 1"], false)).toBe(false);
    expect(outsideClickCloses([], true)).toBe(false);
  });
});

describe("stayingFocus", () => {
  it("goes back to the field the student was in before clicking a link", () => {
    expect(stayingFocus("sidebar link", "title field", true)).toBe("title field");
  });

  it("stays where it is from the keyboard or with nothing before", () => {
    expect(stayingFocus("title field", "goal slider", false)).toBe("title field");
    expect(stayingFocus("sidebar link", null, true)).toBe("sidebar link");
  });
});
