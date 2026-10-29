import { describe, expect, it } from "vitest";
import { attachableSources, saveThenRefresh } from "./examSettingsData";

describe("saving exam settings", () => {
  it("reads the plan again after a save that went through, even when a later step fails", async () => {
    const calls: string[] = [];
    const step = (name: string, fail = false) => async () => {
      calls.push(name);
      if (fail) throw new Error(`${name} failed`);
    };
    const refresh = async () => {
      calls.push("refresh");
    };

    await saveThenRefresh([step("settings"), step("hours")], refresh);
    expect(calls).toEqual(["settings", "hours", "refresh"]);

    // The settings are stored, so the page must compare the edits with them; the hours error still reaches the page.
    calls.length = 0;
    await expect(saveThenRefresh([step("settings"), step("hours", true)], refresh)).rejects.toThrow("hours failed");
    expect(calls).toEqual(["settings", "hours", "refresh"]);

    // Nothing was stored, so nothing needs reading again.
    calls.length = 0;
    await expect(saveThenRefresh([step("settings", true), step("hours")], refresh)).rejects.toThrow("settings failed");
    expect(calls).toEqual(["settings"]);
  });

  it("reports the save's error when reading the plan again fails too", async () => {
    await expect(
      saveThenRefresh(
        [async () => undefined, async () => Promise.reject(new Error("hours failed"))],
        async () => Promise.reject(new Error("refresh failed")),
      ),
    ).rejects.toThrow("hours failed");
  });
});

describe("attachable sources", () => {
  const library = [{ id: "book" }, { id: "notes" }, { id: "paper" }, { id: "attached" }];

  it("offers library sources the plan neither has nor uses as a past paper", () => {
    const papers = { papers: [{ sourceIds: ["paper"] }] };
    expect(attachableSources(library, ["attached"], papers).map((source) => source.id)).toEqual(["book", "notes"]);
  });

  it("offers nothing until the past papers are known, so one can't be picked before it is filtered out", () => {
    expect(attachableSources(library, ["attached"], undefined)).toEqual([]);
    expect(attachableSources(undefined, [], { papers: [] })).toEqual([]);
  });
});
