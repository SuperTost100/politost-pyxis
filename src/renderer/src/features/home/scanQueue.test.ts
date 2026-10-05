import { describe, expect, it } from "vitest";
import { afterEarlierScans } from "./scanQueue";

describe("scans of one source run one after another", () => {
  it("a scan that is still stopping finishes before the next starts, and another source is not held up", async () => {
    const events: string[] = [];
    let release!: () => void;
    const first = afterEarlierScans("s", async () => {
      events.push("first start");
      await new Promise<void>((resolve) => (release = resolve));
      events.push("first stopped");
      throw new Error("failed");
    });
    const second = afterEarlierScans("s", async () => {
      events.push("second start");
    });
    await afterEarlierScans("t", async () => {
      events.push("other");
    });
    expect(events).toEqual(["first start", "other"]);
    release();
    await expect(first).rejects.toThrow("failed");
    await second;
    expect(events).toEqual([
      "first start",
      "other",
      "first stopped",
      "second start",
    ]);
  });
});
