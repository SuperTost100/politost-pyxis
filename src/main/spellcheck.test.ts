import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applySpellCheckerLanguages,
  BUNDLED_DICTIONARIES,
  NO_DOWNLOAD_URL,
  seedDictionaries,
  spellCheckerLanguages,
} from "./spellcheck";

const available = ["en", "en-AU", "en-GB", "en-US", "it", "it-IT"];
const shipped = join(import.meta.dirname, "../../resources/dictionaries");
const files = Object.values(BUNDLED_DICTIONARIES).map((entry) => entry.file);

describe("spellCheckerLanguages", () => {
  it("lists the app's language first and the other language the app ships second", () => {
    expect(spellCheckerLanguages("it", available)).toEqual(["it-IT", "en-US"]);
    expect(spellCheckerLanguages("en", available)).toEqual(["en-US", "it-IT"]);
  });

  it("leaves out a language Electron does not offer, and never picks one the app does not ship", () => {
    expect(spellCheckerLanguages("it", ["it", "en", "en-US"])).toEqual(["en-US"]);
    expect(spellCheckerLanguages("en", ["de-DE"])).toEqual([]);
  });
});

describe("applySpellCheckerLanguages", () => {
  const session = () => {
    const calls: string[] = [];
    return {
      calls,
      availableSpellCheckerLanguages: available,
      setSpellCheckerDictionaryDownloadURL: vi.fn((url: string) => void calls.push(`url ${url}`)),
      setSpellCheckerLanguages: vi.fn((languages: string[]) => void calls.push(`languages ${languages.join(",")}`)),
    };
  };

  it("points downloads away from the network before it sets the languages, on Windows and Linux", () => {
    for (const platform of ["win32", "linux"] as const) {
      const s = session();
      expect(applySpellCheckerLanguages(s, "it", platform)).toEqual(["it-IT", "en-US"]);
      expect(s.calls).toEqual([`url ${NO_DOWNLOAD_URL}`, "languages it-IT,en-US"]);
    }
  });

  it("follows a change of interface language", () => {
    const s = session();
    applySpellCheckerLanguages(s, "it", "linux");
    applySpellCheckerLanguages(s, "en", "linux");
    expect(s.setSpellCheckerLanguages).toHaveBeenLastCalledWith(["en-US", "it-IT"]);
  });

  it("leaves macOS's own checker alone", () => {
    const s = session();
    expect(applySpellCheckerLanguages(s, "it", "darwin")).toBeNull();
    expect(s.calls).toEqual([]);
  });

  it("uses a download URL no network loader serves", () => {
    const url = new URL(NO_DOWNLOAD_URL);
    expect(url.protocol).toBe("file:");
    // An empty host: on Windows a file: URL with a host names a network share.
    expect(url.host).toBe("");
    expect(NO_DOWNLOAD_URL.endsWith("/")).toBe(true);
  });
});

describe("the shipped dictionaries", () => {
  it("are the files recorded in BUNDLED_DICTIONARIES, byte for byte", () => {
    for (const { file, sha256 } of Object.values(BUNDLED_DICTIONARIES))
      expect(createHash("sha256").update(readFileSync(join(shipped, file))).digest("hex"), file).toBe(sha256);
  });
});

describe("seedDictionaries", () => {
  let root: string;
  let profile: string;
  let errors: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "pyxis-dictionaries-"));
    profile = join(root, "profile");
    errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    errors.mockRestore();
    rmSync(root, { recursive: true, force: true });
  });

  it("copies both dictionaries into a new profile, then leaves identical copies alone", () => {
    expect(seedDictionaries(shipped, profile, "linux").sort()).toEqual([...files].sort());
    for (const file of files)
      expect(readFileSync(join(profile, "Dictionaries", file)).equals(readFileSync(join(shipped, file)))).toBe(true);
    expect(seedDictionaries(shipped, profile, "win32")).toEqual([]);
  });

  it("replaces a damaged or different copy", () => {
    mkdirSync(join(profile, "Dictionaries"), { recursive: true });
    writeFileSync(join(profile, "Dictionaries", "it-IT-3-0.bdic"), "not a dictionary");
    expect(seedDictionaries(shipped, profile, "linux").sort()).toEqual([...files].sort());
    expect(readFileSync(join(profile, "Dictionaries", "it-IT-3-0.bdic")).equals(readFileSync(join(shipped, "it-IT-3-0.bdic")))).toBe(true);
  });

  it("skips a dictionary missing from the app and still copies the other", () => {
    const partial = join(root, "bundled");
    mkdirSync(partial);
    writeFileSync(join(partial, "en-US-10-2.bdic"), readFileSync(join(shipped, "en-US-10-2.bdic")));
    expect(seedDictionaries(partial, profile, "linux")).toEqual(["en-US-10-2.bdic"]);
    expect(readdirSync(join(profile, "Dictionaries"))).toEqual(["en-US-10-2.bdic"]);
    expect(errors).toHaveBeenCalledWith("pyxis: spelling dictionary it-IT-3-0.bdic not installed", "ENOENT");
  });

  it("does nothing on macOS", () => {
    expect(seedDictionaries(shipped, profile, "darwin")).toEqual([]);
    expect(() => readdirSync(profile)).toThrow();
  });
});
