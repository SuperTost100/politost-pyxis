import { describe, expect, it, vi } from "vitest";
import { applySpellCheckerLanguages, SPELLCHECK_FOLLOWS_APP_LANGUAGE, spellCheckerLanguages } from "./spellcheck";

const available = ["en", "en-AU", "en-GB", "en-US", "it", "it-IT"];

describe("spellCheckerLanguages", () => {
  it("lists the app's language first and the other language the app ships second", () => {
    expect(spellCheckerLanguages("it", available)).toEqual(["it-IT", "en-US"]);
    expect(spellCheckerLanguages("en", available)).toEqual(["en-US", "it-IT"]);
  });

  it("falls back to the short code, and leaves out a language Electron does not offer", () => {
    expect(spellCheckerLanguages("it", ["it", "en"])).toEqual(["it", "en"]);
    expect(spellCheckerLanguages("it", ["en-US"])).toEqual(["en-US"]);
    expect(spellCheckerLanguages("en", [])).toEqual([]);
  });
});

describe("applySpellCheckerLanguages", () => {
  const session = () => ({ availableSpellCheckerLanguages: available, setSpellCheckerLanguages: vi.fn() });

  it("sets the languages on Windows and Linux", () => {
    for (const platform of ["win32", "linux"] as const) {
      const s = session();
      expect(applySpellCheckerLanguages(s, "it", platform, true)).toEqual(["it-IT", "en-US"]);
      expect(s.setSpellCheckerLanguages).toHaveBeenCalledWith(["it-IT", "en-US"]);
    }
  });

  it("leaves macOS's own checker alone", () => {
    const s = session();
    expect(applySpellCheckerLanguages(s, "it", "darwin", true)).toBeNull();
    expect(s.setSpellCheckerLanguages).not.toHaveBeenCalled();
  });

  it("does nothing when Electron offers neither language", () => {
    const s = { availableSpellCheckerLanguages: ["de"], setSpellCheckerLanguages: vi.fn() };
    expect(applySpellCheckerLanguages(s, "en", "linux", true)).toBeNull();
    expect(s.setSpellCheckerLanguages).not.toHaveBeenCalled();
  });

  it("is off until the owner allows the dictionary download", () => {
    expect(SPELLCHECK_FOLLOWS_APP_LANGUAGE).toBe(false);
    const s = session();
    expect(applySpellCheckerLanguages(s, "it", "linux")).toBeNull();
    expect(s.setSpellCheckerLanguages).not.toHaveBeenCalled();
  });
});
