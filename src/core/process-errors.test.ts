import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { watchProcessErrors } from "./process-errors";
import type { ErrorFields } from "../shared/error-fields";

describe("watchProcessErrors", () => {
  it("passes uncaught exceptions and unhandled rejections on as error fields", () => {
    const source = new EventEmitter();
    const seen: ErrorFields[] = [];
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    watchProcessErrors("test", (fields) => seen.push(fields), source);
    source.emit("uncaughtExceptionMonitor", new TypeError("thrown"));
    source.emit("unhandledRejection", new RangeError("rejected"));
    source.emit("unhandledRejection", "a student's sentence");
    expect(seen.map(({ name, message }) => ({ name, message }))).toEqual([
      { name: "TypeError", message: "thrown" },
      { name: "RangeError", message: "rejected" },
      { name: "NonError", message: "string" },
    ]);
    // The rejection is still logged, as Electron's warning did before.
    expect(log).toHaveBeenCalledWith("test: unhandled rejection", expect.any(RangeError));
    log.mockRestore();
  });

  it("keeps the process going when the report itself fails", () => {
    const source = new EventEmitter();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    watchProcessErrors("test", () => {
      throw new Error("disk full");
    }, source);
    expect(() => source.emit("uncaughtExceptionMonitor", new Error("x"))).not.toThrow();
    expect(log).toHaveBeenCalledWith("test: error report failed", "disk full");
    log.mockRestore();
  });
});
