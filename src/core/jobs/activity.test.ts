import { afterEach, describe, expect, it } from "vitest";
import { activityOf, forgetActivity, trackCall } from "./activity";

afterEach(() => forgetActivity());

describe("job activity", () => {
  it("follows a call from its start through thinking to writing, and clears it at the end", () => {
    const call = trackCall("job", 1_000);
    expect(activityOf("job")).toEqual({ phase: "starting", since: 1_000 });
    call.event("session");
    expect(activityOf("job")?.phase).toBe("starting");
    call.event("reasoning.delta");
    expect(activityOf("job")).toEqual({ phase: "thinking", since: 1_000 });
    call.event("text.delta");
    expect(activityOf("job")).toEqual({ phase: "writing", since: 1_000 });
    // Reasoning that arrives after the text began does not take the phase back.
    call.event("reasoning.delta");
    expect(activityOf("job")?.phase).toBe("writing");
    call.end();
    expect(activityOf("job")).toBeNull();
  });

  it("goes straight to writing for a tool that reports no reasoning", () => {
    const call = trackCall("job", 5);
    call.event("text.delta");
    expect(activityOf("job")).toEqual({ phase: "writing", since: 5 });
  });

  it("tracks nothing for a call outside a job, and keeps jobs apart", () => {
    trackCall(undefined).event("text.delta");
    const a = trackCall("a", 1);
    trackCall("b", 2).event("text.delta");
    expect(activityOf("a")).toEqual({ phase: "starting", since: 1 });
    expect(activityOf("b")?.phase).toBe("writing");
    expect(activityOf(null)).toBeNull();
    a.end();
    expect(activityOf("a")).toBeNull();
    expect(activityOf("b")).not.toBeNull();
  });

  it("does not bring back a call that ended when a late event arrives", () => {
    const call = trackCall("job", 1);
    call.end();
    call.event("text.delta");
    expect(activityOf("job")).toBeNull();
  });
});
