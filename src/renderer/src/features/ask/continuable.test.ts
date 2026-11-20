import { describe, expect, it } from "vitest";
import { canContinue } from "./continuable";

const question = { role: "user" as const };
const done = { role: "assistant" as const };
const stopped = { role: "assistant" as const, stopped: true };
const cutOff = { role: "assistant" as const, stopped: true, error: "engine-failed" };

describe("canContinue", () => {
  it("is offered when the last reply was stopped or cut off by the engine", () => {
    expect(canContinue([question, stopped], false)).toBe(true);
    expect(canContinue([question, cutOff], false)).toBe(true);
  });

  it("is not offered for a finished reply, an empty chat or a question without a reply", () => {
    expect(canContinue([question, done], false)).toBe(false);
    expect(canContinue([], false)).toBe(false);
    expect(canContinue([question, stopped, question], false)).toBe(false);
  });

  it("is not offered for a stopped reply that is not the last message", () => {
    expect(canContinue([question, stopped, question, done], false)).toBe(false);
  });

  it("gives way while a reply is being written", () => {
    expect(canContinue([question, stopped], true)).toBe(false);
  });
});
