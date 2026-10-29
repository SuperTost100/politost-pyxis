import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import i18next from "i18next";
import { describe, expect, it } from "vitest";
import { disclosureText } from "./disclosure";

const locale = (name: string) =>
  JSON.parse(
    readFileSync(
      resolve(import.meta.dirname, `../../locales/${name}.json`),
      "utf8",
    ),
  ) as Record<string, unknown>;

async function translator(language: "en" | "it") {
  const instance = i18next.createInstance();
  await instance.init({
    lng: language,
    resources: { [language]: { translation: locale(language) } },
    interpolation: { escapeValue: false },
  });
  return instance.t;
}

const on = (provider: string) => ({ provider, model: "m" });
const all = (provider: string) =>
  Object.fromEntries(
    ["default", "chat", "map", "plan", "lesson", "cards", "vision", "grading"].map(
      (task) => [task, on(provider)],
    ),
  );

describe("what leaves this computer", () => {
  it("keeps the vendor line while no task uses the local model", async () => {
    const t = await translator("en");
    expect(disclosureText({ t, language: "en", features: all("claude") })).toBe(
      "The text, the retrieved passages and the attachments leave this computer and go to that engine's vendor.",
    );
    expect(disclosureText({ t, language: "en", features: undefined })).toBe(
      t("engines.disclosure"),
    );
  });

  it("says nothing leaves when the local model does every task", async () => {
    const en = await translator("en");
    expect(
      disclosureText({ t: en, language: "en", features: all("ollama") }),
    ).toBe("Every task uses the model on this computer, so nothing leaves it.");
    const it_ = await translator("it");
    expect(
      disclosureText({ t: it_, language: "it", features: all("ollama") }),
    ).toBe(
      "Tutte le attività usano il modello su questo computer, quindi non esce nulla.",
    );
    // A task without its own row uses the default engine.
    expect(
      disclosureText({
        t: en,
        language: "en",
        features: { default: on("ollama") },
      }),
    ).toBe(en("engines.disclosureLocal"));
  });

  it("names which tasks stay here and which go to a vendor when engines are mixed", async () => {
    const features = {
      ...all("claude"),
      chat: on("ollama"),
      map: on("ollama"),
    };
    const en = await translator("en");
    expect(disclosureText({ t: en, language: "en", features })).toBe(
      "Chat and maps run on this computer, so nothing leaves it for them. For exams, lessons, flashcards, photos and grading, the text, the retrieved passages and the attachments go to that engine's vendor.",
    );
    const it_ = await translator("it");
    expect(disclosureText({ t: it_, language: "it", features })).toBe(
      "La chat e le mappe girano su questo computer, quindi per queste non esce nulla. Per gli esami, le lezioni, le flashcard, le foto e le correzioni, il testo, i brani recuperati e gli allegati arrivano al fornitore del motore.",
    );
    expect(
      disclosureText({
        t: en,
        language: "en",
        features: { ...all("codex"), chat: on("ollama") },
      }),
    ).toMatch(
      /^Chat runs on this computer, so nothing leaves it for that\. For maps, /,
    );
  });
});
