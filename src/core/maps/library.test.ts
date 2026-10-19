import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import type { ConceptGraph } from "./graph";
import { listAllMaps } from "./library";
import { storeMap } from "./store";

function graph(labels: string[]): ConceptGraph {
  return {
    layout: "tree",
    undo: null,
    nodes: labels.map((label, i) => ({
      id: `n${i}`,
      label,
      parent: i ? "n0" : null,
      x: 0,
      y: 0,
      pinned: false,
    })),
    edges: labels.slice(1).map((_, i) => ({ from: "n0", to: `n${i + 1}` })),
  };
}

function seed() {
  const db = openDatabase(":memory:");
  db.exec(`
    INSERT INTO subjects(id,name,position,created_at) VALUES('chem','Chimica',1,1),('phys','Fisica',0,1);
    INSERT INTO plans(id,subject_id,title,status,created_at,updated_at) VALUES
      ('p-chem','chem','Chimica generale','ready',1,1),
      ('p-phys','phys','Meccanica','ready',1,1),
      ('p-loose',NULL,'Appunti','ready',1,1);
    INSERT INTO topics(id,plan_id,title,position,created_at) VALUES
      ('t-atoms','p-chem','Atomi',0,1),
      ('t-forces','p-phys','Forze',1,1),
      ('t-motion','p-phys','Moto',0,1),
      ('t-old','p-phys','Archiviato',2,1),
      ('t-loose','p-loose','Varie',0,1);
    UPDATE topics SET archived_at = 5 WHERE id = 't-old';
  `);
  const put = (planId: string, topicId: string, id: string, labels: string[]) =>
    storeMap(db, planId, topicId, {
      id,
      title: labels[0]!,
      passageIds: id === "m-general" ? [] : ["passage"],
      graph: graph(labels),
    });
  put("p-chem", "t-atoms", "m-atoms", ["Atomo", "Protoni", "Elettroni"]);
  put("p-phys", "t-forces", "m-forces", ["Forze", "Perché $F=ma$"]);
  put("p-phys", "t-motion", "m-motion", ["Moto", "Velocità"]);
  put("p-phys", "t-motion", "m-general", ["Cinematica", "Accelerazione"]);
  put("p-phys", "t-old", "m-old", ["Vecchia", "Mappa"]);
  put("p-loose", "t-loose", "m-loose", ["Varie", "Note"]);
  return db;
}

describe("listAllMaps", () => {
  it("lists every map by subject position, exam, topic position and saved order, without archived topics", () => {
    const maps = listAllMaps(seed());
    expect(maps.map((map) => map.id)).toEqual([
      "m-motion",
      "m-general",
      "m-forces",
      "m-atoms",
      "m-loose",
    ]);
    expect(maps[0]).toEqual({
      id: "m-motion",
      title: "Moto",
      planId: "p-phys",
      planTitle: "Meccanica",
      topicId: "t-motion",
      topicTitle: "Moto",
      subjectId: "phys",
      subjectName: "Fisica",
      nodeCount: 2,
      grounding: "sources",
    });
    expect(maps[1]!.grounding).toBe("general");
    expect(maps.at(-1)!.subjectName).toBeNull();
  });

  it("finds a map by any word of its labels, exam, topic or subject, ignoring case and accents", () => {
    const db = seed();
    const ids = (query: string) => listAllMaps(db, query).map((map) => map.id);
    expect(ids("perche")).toEqual(["m-forces"]);
    expect(ids("VELOCITA moto")).toEqual(["m-motion"]);
    expect(ids("chimica")).toEqual(["m-atoms"]);
    expect(ids("meccanica cinematica")).toEqual(["m-general"]);
    expect(ids("vecchia")).toEqual([]);
    expect(ids("   ")).toHaveLength(5);
  });

  it("reads a row saved before collections as one map", () => {
    const db = openDatabase(":memory:");
    db.exec(`
      INSERT INTO plans(id,title,status,created_at,updated_at) VALUES('p','Esame','ready',1,1);
      INSERT INTO topics(id,plan_id,title,position,created_at) VALUES('t','p','Tema',0,1);
    `);
    db.prepare(
      "INSERT INTO maps(id,plan_id,topic_id,graph_json,grounding,created_at) VALUES('legacy','p','t',?,'general',1)",
    ).run(JSON.stringify(graph(["Radice", "Ramo"])));
    expect(listAllMaps(db)).toMatchObject([
      { id: "legacy", title: "Radice", nodeCount: 2, grounding: "general" },
    ]);
  });
});
