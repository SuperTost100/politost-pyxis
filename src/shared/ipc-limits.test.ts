import { describe, expect, it } from "vitest";
import {
  CHAT_SEED_BODY_MAX,
  CHAT_TEXT_MAX,
  CHAT_TITLE_MAX,
  PROFILE_LIMITS,
  requests,
  toIpcError,
} from "./ipc";

/** What the student sees when the core refuses text that is too long: a named error, not "Something went wrong". */
function refusal(run: () => unknown) {
  try {
    run();
  } catch (err) {
    return toIpcError(err);
  }
  throw new Error("accepted");
}

describe("input length limits", () => {
  it("lets a pasted page of notes through and names the limit when a chapter is pasted", () => {
    const page = "Appunti di fisica. ".repeat(250);
    expect(requests["chats.ask"].input.parse({ text: page }).text).toBe(page);
    expect(requests["chats.ask"].input.parse({ text: "x".repeat(CHAT_TEXT_MAX) })).toBeTruthy();
    expect(refusal(() => requests["chats.ask"].input.parse({ text: "x".repeat(CHAT_TEXT_MAX + 1) }))).toMatchObject({
      code: "input-too-long",
      messageKey: "errors.inputTooLong",
      params: { max: CHAT_TEXT_MAX },
    });
  });

  it("limits the pinned body and title of a seeded chat and a rename", () => {
    const seed = { kind: "passage" as const, title: "T", body: "b" };
    expect(requests["chats.seed"].input.parse(seed)).toBeTruthy();
    expect(refusal(() => requests["chats.seed"].input.parse({ ...seed, body: "b".repeat(CHAT_SEED_BODY_MAX + 1) })).params).toEqual({
      max: CHAT_SEED_BODY_MAX,
    });
    expect(refusal(() => requests["chats.seed"].input.parse({ ...seed, title: "t".repeat(CHAT_TITLE_MAX + 1) })).code).toBe(
      "input-too-long",
    );
    expect(refusal(() => requests["chats.rename"].input.parse({ chatId: "c", title: "t".repeat(CHAT_TITLE_MAX + 1) })).code).toBe(
      "input-too-long",
    );
  });

  it("limits each profile field, the interests and their number", () => {
    const save = requests["profile.save"].input;
    expect(save.parse({ school: "s".repeat(PROFILE_LIMITS.school), interests: ["a", "b"] })).toBeTruthy();
    for (const field of ["displayName", "year", "school", "course", "contentLanguage"] as const) {
      const limit = field === "contentLanguage" ? PROFILE_LIMITS.language : PROFILE_LIMITS[field];
      expect(refusal(() => save.parse({ [field]: "x".repeat(limit + 1) })).code, field).toBe("input-too-long");
    }
    expect(refusal(() => save.parse({ interests: ["x".repeat(PROFILE_LIMITS.interest + 1)] })).code).toBe("input-too-long");
    expect(() => save.parse({ interests: Array.from({ length: PROFILE_LIMITS.interests + 1 }, () => "a") })).toThrow();
  });

  it("keeps any other invalid input an internal error", () => {
    expect(refusal(() => requests["chats.ask"].input.parse({ text: 4 })).code).toBe("internal");
  });
});
