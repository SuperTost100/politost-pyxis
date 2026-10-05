import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import { createPlan, readPlan } from "./create";
import { exportPlan, importPlan } from "./file";

describe("PLAN-11 topic grounding in plan files", () => {
  it("keeps general topics general through export and import, and the imported plan stays a draft", () => {
    const source = openDatabase(":memory:");
    const { planId } = createPlan(source, {
      title: "Fisica",
      sourceIds: [],
      draftTopics: [{ title: "Moto" }, { title: "Forze" }],
    });
    const file = exportPlan(source, planId);
    expect(file.topics.map((t) => t.grounding)).toEqual(["general", "general"]);
    const target = openDatabase(":memory:");
    const imported = readPlan(target, importPlan(target, file))!;
    expect(imported.topics.map((t) => t.grounding)).toEqual(["general", "general"]);
    expect(imported.status).toBe("draft");
    expect(imported.imported).toBe(true);
    source.close();
    target.close();
  });

  it("imports older files without grounding as ready, with unknown grounding", () => {
    const target = openDatabase(":memory:");
    const file = {
      version: 2 as const,
      title: "Old",
      topics: [{ title: "Moto", position: 0 }],
      nodes: [],
      cards: [],
    };
    const imported = readPlan(target, importPlan(target, file))!;
    expect(imported.status).toBe("ready");
    expect(imported.topics[0]!.grounding).toBeNull();
    const v1 = readPlan(target, importPlan(target, { ...file, version: 1 as const }))!;
    expect(v1.status).toBe("ready");
    target.close();
  });

  it("keeps a mixed plan ready and marks only its general topic", () => {
    const source = openDatabase(":memory:");
    source.prepare("INSERT INTO sources(id,kind,title,status,created_at,updated_at) VALUES('s','file','N','ready',1,1)").run();
    source.prepare("INSERT INTO passages(id,source_id,text,locator_json,section_path,created_at) VALUES('p','s','x','{}','A',1)").run();
    const { planId } = createPlan(source, {
      title: "Mix",
      sourceIds: ["s"],
      tree: [
        { title: "A", summary: "", subtopics: [], passageIds: ["p"] },
        { title: "B", summary: "", subtopics: [], passageIds: [] },
      ],
    });
    const target = openDatabase(":memory:");
    const imported = readPlan(target, importPlan(target, exportPlan(source, planId)))!;
    expect(imported.topics.map((t) => t.grounding)).toEqual(["sources", "general"]);
    expect(imported.status).toBe("ready");
    source.close();
    target.close();
  });
});
