import { beforeEach, describe, expect, it } from "vitest";
import { arrivedAt, noteForArrival, takeArrivalNote } from "./arrival-note";

describe("arrival note", () => {
  beforeEach(() => {
    // A note left by an earlier case would show as a pass here.
    arrivedAt("/somewhere-else");
  });

  it("is taken once by the page it was left for", () => {
    noteForArrival("/maps", "/maps/an/t-lim", { shrinkMap: "m-teo" });
    expect(takeArrivalNote("/maps")).toEqual({ shrinkMap: "m-teo" });
    expect(takeArrivalNote("/maps")).toBeUndefined();
  });

  it("is not taken by another page, and that page does not use it up", () => {
    noteForArrival("/maps?subject=an", "/maps/an/t-lim", { shrinkMap: "m-teo" });
    expect(takeArrivalNote("/flashcards")).toBeUndefined();
    expect(takeArrivalNote("/maps")).toEqual({ shrinkMap: "m-teo" });
  });

  // The map page's redirect and the window's move back can both finish before Mappe has drawn itself.
  it("survives several navigations that finish at its destination or at the page it was left from", () => {
    noteForArrival("/maps", "/maps/an/t-lim", { shrinkMap: "m-teo" });
    arrivedAt("/maps/an/t-lim");
    arrivedAt("/maps");
    arrivedAt("/maps");
    expect(takeArrivalNote("/maps")).toEqual({ shrinkMap: "m-teo" });
  });

  it("ends when the student has moved on to another page, so a later visit to the destination gets nothing", () => {
    noteForArrival("/maps", "/maps/an/t-lim", { shrinkMap: "m-teo" });
    arrivedAt("/flashcards");
    arrivedAt("/maps");
    expect(takeArrivalNote("/maps")).toBeUndefined();
  });

  it("is replaced by a newer note, never joined to it", () => {
    noteForArrival("/maps", "/maps/an/t-lim", { shrinkMap: "m-teo" });
    noteForArrival("/maps", "/maps/chem", { shrinkMap: "m-atom" });
    expect(takeArrivalNote("/maps")).toEqual({ shrinkMap: "m-atom" });
    expect(takeArrivalNote("/maps")).toBeUndefined();
  });
});
