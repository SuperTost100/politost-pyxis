import { describe, expect, it } from "vitest";
import { claimOnce, wasClaimed } from "./claimOnce";

function memory() {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  };
}

describe("claimOnce", () => {
  it("lets an entry claim a name once, and refuses the second time", () => {
    const storage = memory();
    expect(wasClaimed(storage, "map-build", "k1")).toBe(false);
    expect(claimOnce(storage, "map-build", "k1")).toBe(true);
    expect(wasClaimed(storage, "map-build", "k1")).toBe(true);
    expect(claimOnce(storage, "map-build", "k1")).toBe(false);
  });

  it("keeps entries and names apart", () => {
    const storage = memory();
    expect(claimOnce(storage, "map-build", "k1")).toBe(true);
    expect(claimOnce(storage, "map-build", "k2")).toBe(true);
    expect(claimOnce(storage, "other", "k1")).toBe(true);
  });

  it("claims without a usable storage, where the page's own cleanup is all there is", () => {
    expect(claimOnce(undefined, "map-build", "k1")).toBe(true);
    const broken = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(claimOnce(broken, "map-build", "k1")).toBe(true);
    expect(wasClaimed(broken, "map-build", "k1")).toBe(false);
  });
});
