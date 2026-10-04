import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import { getFunnel } from "./funnel";
import { selectionFor } from "./selection";

describe("engine selection", () => {
  it("uses an advertised model and preserves explicit feature selections", async () => {
    const db = openDatabase(":memory:");
    try {
      expect(() => selectionFor(db, "plan")).toThrow();
      db.prepare(
        "INSERT INTO feature_engines (feature, selection_json, updated_at) VALUES ('default', ?, 1)",
      ).run(JSON.stringify({ provider: "claude", model: "claude-sonnet-5" }));
      const fallback = selectionFor(db, "plan");
      const models = await getFunnel().models(fallback.provider);
      expect(models.map((model) => model.id)).toContain(fallback.model);
      db.prepare(
        "INSERT INTO feature_engines (feature, selection_json, updated_at) VALUES ('plan', ?, 1)",
      ).run(JSON.stringify({ provider: "claude", model: "user-selection" }));
      expect(selectionFor(db, "plan").model).toBe("user-selection");
    } finally {
      db.close();
    }
  });
});
