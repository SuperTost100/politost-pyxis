import { describe, expect, it } from "vitest";
import { showsLiveText } from "./lessonLive";

describe("showsLiveText", () => {
  it("shows the saved lesson while a regenerate has not streamed yet", () => {
    expect(
      showsLiveText({
        writing: true,
        live: "",
        saved: "Old [P1]",
        cancelled: false,
      }),
    ).toBe(false);
  });

  it("shows the stream once text arrives", () => {
    expect(
      showsLiveText({
        writing: true,
        live: "New",
        saved: "Old",
        cancelled: false,
      }),
    ).toBe(true);
    expect(
      showsLiveText({
        writing: true,
        live: "New",
        saved: undefined,
        cancelled: false,
      }),
    ).toBe(true);
  });

  it("keeps the saved lesson after a stopped regenerate", () => {
    expect(
      showsLiveText({
        writing: false,
        live: "Part",
        saved: "Old",
        cancelled: true,
      }),
    ).toBe(false);
  });

  it("shows the partial text of a first lesson that was stopped", () => {
    expect(
      showsLiveText({
        writing: false,
        live: "Part",
        saved: undefined,
        cancelled: true,
      }),
    ).toBe(true);
    expect(
      showsLiveText({
        writing: false,
        live: "Part",
        saved: undefined,
        cancelled: false,
      }),
    ).toBe(false);
  });
});
