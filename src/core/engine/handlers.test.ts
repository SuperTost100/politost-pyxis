import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import { engineHandlers } from "./handlers";
import { selectionFor } from "./selection";

describe("clearFeature", () => {
  it("drops a chat choice so the default engine is used again", () => {
    const db = openDatabase(":memory:");
    const engines = engineHandlers(db, () => undefined);
    engines.setFeature({ feature: "chat", provider: "openai-api", model: "gpt-test" });
    expect(selectionFor(db, "chat").provider).toBe("openai-api");
    engines.clearFeature({ feature: "chat" });
    expect(selectionFor(db, "chat").provider).toBe("claude");
  });
});
