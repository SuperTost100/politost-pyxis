import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { isOcrRefusal, ocrErrorKey } from "./ocrErrors";

const locale = (name: string) =>
  JSON.parse(readFileSync(resolve(import.meta.dirname, `../locales/${name}.json`), "utf8")) as Record<string, unknown>;
const lookup = (tree: Record<string, unknown>, key: string) =>
  key.split(".").reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], tree);

describe("OCR data messages", () => {
  it("gives every raw job code and refusal key text in both languages", () => {
    const codes = ["offline", "download", "too-big", "declined", "integrity", "missing"].map((c) => `ocr-data-${c}`);
    const keys = [
      ...codes.map((code) => ocrErrorKey(code)),
      "sources.ocrDataMissing",
      "sources.ocrDataIntegrity",
      "sources.ocrDataOffline",
      "sources.jobs.ocrData",
    ];
    for (const key of keys) {
      expect(key).not.toBeNull();
      for (const name of ["en", "it"]) expect(typeof lookup(locale(name), key!), `${name}: ${key}`).toBe("string");
    }
  });

  it("only treats the three core refusal keys as OCR refusals", () => {
    expect(isOcrRefusal("sources.ocrDataMissing")).toBe(true);
    expect(isOcrRefusal("sources.importFailed")).toBe(false);
    expect(ocrErrorKey("source-unreadable")).toBeNull();
  });
});
