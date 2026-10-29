import { describe, expect, it } from "vitest";
import type { ErrorFields } from "../../../shared/error-fields";
import { reportError, watchWindowErrors } from "./errorReports";

function fire(target: EventTarget, type: string, fields: Record<string, unknown>): void {
  target.dispatchEvent(Object.assign(new Event(type), fields));
}

describe("window error reports", () => {
  it("reports uncaught errors and unhandled rejections", () => {
    const target = new EventTarget();
    const seen: ErrorFields[] = [];
    watchWindowErrors(target, (fields) => seen.push(fields));
    fire(target, "error", { error: new TypeError("x is undefined"), message: "Uncaught TypeError" });
    fire(target, "error", { error: null, message: "Script error." });
    fire(target, "unhandledrejection", { reason: { code: "core-restarted", detail: "the chat text" } });
    fire(target, "unhandledrejection", { reason: new Error("rejected") });
    expect(seen.map(({ name, message }) => `${name}: ${message}`)).toEqual([
      "TypeError: x is undefined",
      "Error: Script error.",
      "NonError: core-restarted",
      "Error: rejected",
    ]);
  });

  it("ignores ResizeObserver loop notices", () => {
    const seen: ErrorFields[] = [];
    reportError(new Error("ResizeObserver loop completed with undelivered notifications."), (f) => seen.push(f));
    expect(seen).toEqual([]);
  });

  it("swallows a failing reporter", () => {
    expect(() =>
      reportError(new Error("x"), () => {
        throw new Error("bridge gone");
      }),
    ).not.toThrow();
  });
});
