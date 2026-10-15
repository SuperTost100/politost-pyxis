import { describe, expect, it } from "vitest";
import { capabilityWarning, engineSeesImages } from "./capabilities";

describe("capabilityWarning", () => {
  it("warns when a model cannot see images", () => {
    expect(capabilityWarning("text-only-small", "vision")).toBe(
      "engines.capabilityWarning",
    );
    expect(capabilityWarning("claude-sonnet-4-6", "vision")).toBeNull();
  });
  it("only allows image attachments for known GPT vision models", () => {
    for (const model of ["gpt-3.5-turbo", "gpt-4", "gpt-oss-120b", "gpt-audio", "gpt-4o-transcribe", "gpt-4o-audio-preview", "gpt-unknown"])
      expect(capabilityWarning(model, "vision"), model).toBe("engines.capabilityWarning");
    for (const model of ["gpt-4o", "gpt-4o-mini-2024-07-18", "gpt-4.1-nano", "gpt-5.1", "gpt-5.4-mini", "gpt-5.6-sol", "gpt-6-astra"])
      expect(capabilityWarning(model, "vision"), model).toBeNull();
  });
});

describe("engineSeesImages", () => {
  it("also needs a provider that takes images, whatever the model id says", () => {
    expect(engineSeesImages({ provider: "claude", model: "claude-sonnet-5" })).toBe(true);
    expect(engineSeesImages({ provider: "codex", model: "gpt-5.6-sol" })).toBe(true);
    // Cursor Agent and Antigravity list claude-* and gpt-* ids but refuse attachments.
    expect(engineSeesImages({ provider: "agent", model: "claude-sonnet-5" })).toBe(false);
    expect(engineSeesImages({ provider: "antigravity", model: "claude-sonnet-4-6" })).toBe(false);
    expect(engineSeesImages({ provider: "claude", model: "text-only-small" })).toBe(false);
  });
});
