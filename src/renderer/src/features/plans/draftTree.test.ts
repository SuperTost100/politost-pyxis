import { describe, expect, it } from "vitest";
import {
  addSubtopic,
  addTopic,
  canDrop,
  drop,
  fromProposal,
  move,
  remove,
  rename,
  toDraftTopics,
} from "./draftTree";

const tree = () =>
  fromProposal([
    {
      title: "Limiti",
      summary: "Base",
      subtopics: ["Definizione", "Continuità"],
    },
    { title: "Derivate", summary: "Pendenza", subtopics: ["Regole"] },
    { title: "Integrali", summary: "Area", subtopics: [] },
  ]);
const titles = (nodes: ReturnType<typeof tree>) =>
  nodes.map((node) => [node.title, node.subtopics.map((sub) => sub.title)]);

describe("PLAN-12 draft topic tree", () => {
  it("renames a topic and a subtopic by key", () => {
    const nodes = tree();
    const named = rename(
      rename(nodes, nodes[0]!.key, "Limiti e continuità"),
      nodes[1]!.subtopics[0]!.key,
      "Regole di derivazione",
    );
    expect(titles(named)).toEqual([
      ["Limiti e continuità", ["Definizione", "Continuità"]],
      ["Derivate", ["Regole di derivazione"]],
      ["Integrali", []],
    ]);
  });

  it("adds topics and subtopics, and deletes either", () => {
    let nodes = tree();
    const topic = addTopic(nodes);
    nodes = rename(topic.nodes, topic.key, "Serie");
    const sub = addSubtopic(nodes, topic.key);
    nodes = rename(sub.nodes, sub.key, "Convergenza");
    expect(titles(nodes).at(-1)).toEqual(["Serie", ["Convergenza"]]);
    nodes = remove(remove(nodes, topic.key), nodes[0]!.subtopics[0]!.key);
    expect(titles(nodes)).toEqual([
      ["Limiti", ["Continuità"]],
      ["Derivate", ["Regole"]],
      ["Integrali", []],
    ]);
  });

  it("moves with the keyboard route and stops at the ends", () => {
    const nodes = tree();
    expect(titles(move(nodes, nodes[2]!.key, -1)).map(([t]) => t)).toEqual([
      "Limiti",
      "Integrali",
      "Derivate",
    ]);
    expect(move(nodes, nodes[0]!.key, -1)).toBe(nodes);
    const reordered = move(nodes, nodes[0]!.subtopics[0]!.key, 1);
    expect(titles(reordered)[0]).toEqual([
      "Limiti",
      ["Continuità", "Definizione"],
    ]);
    // A subtopic never leaves its topic by keyboard.
    expect(titles(move(nodes, nodes[1]!.subtopics[0]!.key, 1))).toEqual(
      titles(nodes),
    );
  });

  it("reorders topics by drag, before or after the target", () => {
    const nodes = tree();
    expect(
      titles(drop(nodes, nodes[0]!.key, nodes[2]!.key, 1)).map(([t]) => t),
    ).toEqual(["Derivate", "Integrali", "Limiti"]);
    expect(
      titles(drop(nodes, nodes[2]!.key, nodes[0]!.key, -1)).map(([t]) => t),
    ).toEqual(["Integrali", "Limiti", "Derivate"]);
  });

  it("drops a subtopic into another topic or between its siblings", () => {
    const nodes = tree();
    const regole = nodes[1]!.subtopics[0]!.key;
    const into = drop(nodes, regole, nodes[2]!.key, 0);
    expect(titles(into)[1]).toEqual(["Derivate", []]);
    expect(titles(into)[2]).toEqual(["Integrali", ["Regole"]]);
    const between = drop(nodes, regole, nodes[0]!.subtopics[0]!.key, 1);
    expect(titles(between)[0]).toEqual([
      "Limiti",
      ["Definizione", "Regole", "Continuità"],
    ]);
  });

  it("refuses drops that would break the two levels", () => {
    const nodes = tree();
    const sub = nodes[0]!.subtopics[0]!.key;
    expect(canDrop(nodes, nodes[0]!.key, nodes[1]!.key, 0)).toBe(false);
    expect(canDrop(nodes, nodes[0]!.key, sub, 1)).toBe(false);
    expect(canDrop(nodes, sub, nodes[1]!.key, 1)).toBe(false);
    expect(drop(nodes, sub, nodes[1]!.key, -1)).toBe(nodes);
  });

  it("drops blank rows when the tree goes back to the plan", () => {
    let nodes = tree();
    const topic = addTopic(nodes);
    const sub = addSubtopic(topic.nodes, nodes[2]!.key);
    nodes = rename(sub.nodes, sub.key, "   ");
    expect(toDraftTopics(nodes)).toEqual([
      {
        title: "Limiti",
        summary: "Base",
        subtopics: ["Definizione", "Continuità"],
      },
      { title: "Derivate", summary: "Pendenza", subtopics: ["Regole"] },
      { title: "Integrali", summary: "Area", subtopics: [] },
    ]);
  });
});
