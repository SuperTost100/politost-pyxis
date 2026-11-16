import { describe, expect, it } from "vitest";
import { shownFigures, showsLiveText } from "./lessonLive";

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

describe("shownFigures", () => {
  const old = { "figure-a": "data:image/png;base64,OLD", "figure-b": "data:image/png;base64,OLDB" };

  it("shows only the figures told for the lesson being written, so a figure that fails now does not get the saved lesson's picture", () => {
    // The same block as before is drawn again and fails: told as empty, and the saved picture must not take its place.
    expect(shownFigures({ fromLive: true, live: { "figure-a": "" }, saved: old })).toEqual({ "figure-a": "" });
    expect(shownFigures({ fromLive: true, live: { "figure-a": "data:image/png;base64,NEW" }, saved: old })).toEqual({
      "figure-a": "data:image/png;base64,NEW",
    });
  });

  it("shows the saved lesson's figures when the saved lesson is what shows", () => {
    expect(shownFigures({ fromLive: false, live: { "figure-a": "data:image/png;base64,NEW" }, saved: old })).toEqual(old);
    expect(shownFigures({ fromLive: false, live: {}, saved: undefined })).toEqual({});
  });
});
