import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import { citeExplanation } from "./citations";

const known = "01a110b2-3c0a-78c7-88eb-a17ab5013c6d";
const gone = "01a110b2-3c0a-78c7-88eb-000000000000";

describe("quiz explanation citations", () => {
  it("turns known passage IDs into source chips and never shows an ID", () => {
    const db = openDatabase(":memory:");
    db.prepare(
      "INSERT INTO sources (id, kind, title, status, created_at, updated_at) VALUES ('s', 'file', 'Mazzoldi', 'ready', 1, 1)",
    ).run();
    db.prepare(
      "INSERT INTO source_documents (id, source_id, version, tree_json, created_at) VALUES ('d', 's', 1, '{}', 1)",
    ).run();
    db.prepare(
      "INSERT INTO passages (id, source_id, document_id, text, section_path, locator_json, created_at) VALUES (?, 's', 'd', 'Testo', NULL, '{\"page\":12}', 1)",
    ).run(known);
    expect(
      citeExplanation(
        db,
        `La rigidità richiede distanze costanti [${known}]. Vale anche qui [${gone}, ${known}] e (${gone}).`,
      ),
    ).toEqual({
      explanation:
        "La rigidità richiede distanze costanti [P1]. Vale anche qui [P1] e.",
      citations: [{ passageId: known, label: "p. 12" }],
    });
    // A [P1] label the quiz never defined points at the question's own sources, or goes away.
    expect(citeExplanation(db, "Vedi [P1] e [P2].", [known])).toEqual({
      explanation: "Vedi [P1] e.",
      citations: [{ passageId: known, label: "p. 12" }],
    });
    expect(citeExplanation(db, "Nessun riferimento.")).toEqual({
      explanation: "Nessun riferimento.",
      citations: [],
    });
    db.close();
  });
});
