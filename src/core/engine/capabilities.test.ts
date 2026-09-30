import { describe, expect, it } from "vitest";
import { capabilityWarning } from "./capabilities";

describe("capabilityWarning", () => {
  it("warns when a model cannot see images", () => {
    expect(capabilityWarning("text-only-small", "vision")).toBe(
      "engines.capabilityWarning",
    );
    expect(capabilityWarning("claude-sonnet-4-6", "vision")).toBeNull();
  });
});
