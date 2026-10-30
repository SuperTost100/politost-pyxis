import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { SOURCE_ERROR_MESSAGE_KEYS } from "../../../../shared/source-errors";
import { jobErrorEngine, jobErrorKey } from "./jobErrors";

describe("job error text", () => {
  it("names why an import stopped instead of a general failure", () => {
    expect(jobErrorKey("encrypted-smartbook")).toBe("sources.encrypted");
    expect(jobErrorKey("licensed-smartbook")).toBe("sources.encrypted");
    expect(jobErrorKey("archive-too-large")).toBe("sources.archiveTooLarge");
    expect(jobErrorKey("archive-corrupt")).toBe("sources.archiveUnreadable");
    expect(jobErrorKey("smartbook-json-missing")).toBe("sources.smartbookBroken");
    expect(jobErrorKey("chapter-missing")).toBe("sources.smartbookBroken");
    expect(jobErrorKey("page-empty")).toBe("sources.pageEmpty");
    expect(jobErrorKey("link-timeout")).toBe("sources.linkFailed");
    expect(jobErrorKey("link-scheme")).toBe("sources.linkScheme");
    expect(jobErrorKey("source-worker-memory")).toBe("sources.workerMemory");
    expect(jobErrorKey("engine-disclosure-required")).toBe("engines.errors.disclosure-required");
    expect(jobErrorKey("engine-disclosure-timeout")).toBe("engines.errors.disclosure-required");
    expect(jobErrorKey("replace-no-text")).toBe("sources.replaceNoText");
  });

  it("names an engine that failed or ran out", () => {
    expect(jobErrorKey("not-logged-in")).toBe("engines.errors.not-logged-in");
    expect(jobErrorKey("quota")).toBe("engines.errors.quota");
    expect(jobErrorKey("cli-failed")).toBe("engines.errors.cli-failed");
    expect(jobErrorKey("not-logged-in: Please run /login")).toBe("engines.errors.not-logged-in");
    expect(jobErrorKey("model-not-included: not in your plan")).toBe("engines.errors.model-not-included");
    expect(jobErrorKey("stream-truncated")).toBe("engines.errors.stream-truncated");
  });

  it("reads which engine a job's failure came from", () => {
    expect(jobErrorKey("not-logged-in [codex]: 401 Unauthorized")).toBe(
      "engines.errors.not-logged-in",
    );
    expect(jobErrorEngine("not-logged-in [codex]: 401 Unauthorized")).toBe("codex");
    expect(jobErrorEngine("not-logged-in: Please run /login")).toBeUndefined();
    expect(jobErrorEngine("something [codex] else")).toBeUndefined();
  });

  it("keeps the messages it already had", () => {
    expect(jobErrorKey("demo-step-failed")).toBe("jobs.demoFailed");
    expect(jobErrorKey("model failed: engine-missing")).toBe("engines.errors.engine-missing");
    expect(jobErrorKey("reextract-no-text")).toBe("sources.reextractNoText");
    expect(jobErrorKey("ocr-data-offline")).toBe("sources.ocrData.errors.offline");
    expect(jobErrorKey("something else")).toBe("jobs.failedGeneral");
  });

  it("has every message in English and Italian", () => {
    for (const lang of ["en", "it"]) {
      const messages = JSON.parse(
        readFileSync(resolve(import.meta.dirname, `../../locales/${lang}.json`), "utf8"),
      ) as Record<string, unknown>;
      for (const key of SOURCE_ERROR_MESSAGE_KEYS) {
        const value = key.split(".").reduce<unknown>(
          (node, part) => (node as Record<string, unknown> | undefined)?.[part],
          messages,
        );
        expect(typeof value, `${lang} ${key}`).toBe("string");
      }
    }
  });
});
