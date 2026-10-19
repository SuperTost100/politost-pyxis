import type Database from "better-sqlite3";
import {
  NODE_MIN_HEIGHT,
  NODE_WIDTH,
  layoutTree,
} from "../../shared/map-layout";
import type { ConceptGraph, MapNode } from "./graph";
import { readStoredMap } from "./store";

export type MapExportLanguage = "en" | "it";

const labels = {
  en: { untitled: "Map", exam: "Exam", topic: "Topic", links: "Cross-links" },
  it: {
    untitled: "Mappa",
    exam: "Esame",
    topic: "Argomento",
    links: "Collegamenti",
  },
} as const;

/** The light theme's colours, since an exported map is read on paper or in another app. */
const fills: Record<string, string> = {
  "surface-raised": "#efede7",
  "primary-soft": "#e5ecfc",
  "mastery-soft": "#dcf3e9",
  "star-soft": "#fbf0d6",
  "danger-soft": "#fbe3e3",
};
const INK = "#15181e";
const INK_MUTED = "#50576a";
const LINE = "#7e8492";
const PAD = 40;
const FONT = "Figtree, 'Segoe UI', Helvetica, Arial, sans-serif";
// Node text in the editor: 15 px body, the root 17 px semibold, inside 16 px of padding on a 240 px box.
const TEXT = { size: 15, line: 22, chars: 25 };
const ROOT_TEXT = { size: 17, line: 25, chars: 20 };
const LINK_TEXT = { size: 13, line: 18, chars: 30 };

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

/** A label as plain text for the drawing: math keeps its source, emphasis and code marks go. */
function plain(label: string): string {
  return oneLine(label.replace(/\$\$?|\*\*|__|`/g, ""));
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Greedy word wrap; a word longer than a line is cut. */
export function wrapText(text: string, chars: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (let word of text.split(" ").filter(Boolean)) {
    while (word.length > chars) {
      if (line) lines.push(line);
      line = "";
      lines.push(word.slice(0, chars));
      word = word.slice(chars);
    }
    if (!line) line = word;
    else if (line.length + 1 + word.length <= chars) line += ` ${word}`;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line || !lines.length) lines.push(line);
  return lines;
}

function childrenOf(nodes: MapNode[]): Map<string, MapNode[]> {
  const children = new Map<string, MapNode[]>();
  for (const node of nodes)
    if (node.parent !== null)
      children.set(node.parent, [...(children.get(node.parent) ?? []), node]);
  return children;
}

/** Edges that are not a parent-child line of the tree. */
function crossLinks(graph: ConceptGraph) {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  return graph.edges.filter(
    (edge) =>
      byId.get(edge.to)?.parent !== edge.from &&
      byId.get(edge.from)?.parent !== edge.to,
  );
}

/**
 * The map as a nested Markdown list from the root, every branch unfolded. A labelled tree edge leads its child's line;
 * the other links follow in their own list, with their labels.
 */
export function mapOutline(
  title: string,
  graph: ConceptGraph,
  context: { planTitle: string; topicTitle: string },
  language: MapExportLanguage = "en",
): string {
  const words = labels[language];
  const children = childrenOf(graph.nodes);
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const treeLabel = new Map(
    graph.edges.flatMap((edge) => {
      if (!edge.label?.trim()) return [];
      if (byId.get(edge.to)?.parent === edge.from)
        return [[edge.to, oneLine(edge.label)] as const];
      if (byId.get(edge.from)?.parent === edge.to)
        return [[edge.from, oneLine(edge.label)] as const];
      return [];
    }),
  );
  const lines: string[] = [];
  const walk = (node: MapNode, depth: number) => {
    const lead = treeLabel.get(node.id);
    lines.push(
      `${"  ".repeat(depth)}- ${lead ? `*${lead}:* ` : ""}${oneLine(node.label)}`,
    );
    for (const child of children.get(node.id) ?? []) walk(child, depth + 1);
  };
  const root = graph.nodes.find((node) => node.parent === null);
  if (root) walk(root, 0);
  const blocks = [
    `# ${oneLine(title) || words.untitled}`,
    `${words.exam}: ${oneLine(context.planTitle)} · ${words.topic}: ${oneLine(context.topicTitle)}`,
    lines.join("\n"),
  ];
  const links = crossLinks(graph);
  if (links.length)
    blocks.push(
      `## ${words.links}`,
      links
        .map((edge) => {
          const from = oneLine(byId.get(edge.from)?.label ?? "");
          const to = oneLine(byId.get(edge.to)?.label ?? "");
          const label = oneLine(edge.label ?? "");
          return `- ${from} → ${to}${label ? `: *${label}*` : ""}`;
        })
        .join("\n"),
    );
  return `${blocks.join("\n\n")}\n`;
}

type Box = {
  node: MapNode;
  x: number;
  y: number;
  height: number;
  lines: string[];
  root: boolean;
};

/**
 * The whole map as one SVG at full size, laid out as the editor lays it out: the tree from the shared layout with
 * estimated node heights, the radial layout from saved positions, and a dragged node where it was dropped. Folded
 * branches are open, and every cross-link shows its label.
 */
export function mapSvg(title: string, graph: ConceptGraph): string {
  const boxes = new Map<string, Box>();
  const heights = new Map<string, number>();
  for (const node of graph.nodes) {
    const root = node.parent === null;
    const text = root ? ROOT_TEXT : TEXT;
    const lines = wrapText(plain(node.label), text.chars);
    const height = Math.max(NODE_MIN_HEIGHT, lines.length * text.line + 26);
    heights.set(node.id, height);
    boxes.set(node.id, { node, x: node.x, y: node.y, height, lines, root });
  }
  if (graph.layout === "tree") {
    const places = layoutTree(graph.nodes, heights);
    for (const box of boxes.values()) {
      const at = places.get(box.node.id);
      if (at && !box.node.pinned) Object.assign(box, at);
    }
  }
  const all = [...boxes.values()];
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  type Curve = { tree: boolean; points: number[] };
  type Label = { x: number; y: number; width: number; lines: string[] };
  const curves: Curve[] = [];
  const labelBoxes: Label[] = [];
  for (const edge of graph.edges) {
    let source = boxes.get(edge.from);
    let target = boxes.get(edge.to);
    if (!source || !target) continue;
    const tree =
      byId.get(edge.to)?.parent === edge.from ||
      byId.get(edge.from)?.parent === edge.to;
    if (byId.get(edge.from)?.parent === edge.to)
      [source, target] = [target, source];
    const sy = source.y + source.height / 2;
    const ty = target.y + target.height / 2;
    let points: number[];
    if (!tree && source.x === target.x) {
      // Two nodes in one column: a loop out of their right sides, rather than a line through both boxes.
      const side = source.x + NODE_WIDTH;
      points = [side, sy, side + 70, sy, side + 70, ty, side, ty];
    } else {
      // The editor's handles: out on the side facing the target, in on the side facing the source.
      const forward = target.x >= source.x;
      const sx = forward ? source.x + NODE_WIDTH : source.x;
      const tx = forward ? target.x : target.x + NODE_WIDTH;
      const bend = Math.max(Math.abs(tx - sx) / 2, 40) * (forward ? 1 : -1);
      points = [sx, sy, sx + bend, sy, tx - bend, ty, tx, ty];
    }
    curves.push({ tree, points });
    const label = oneLine(edge.label ?? "");
    if (tree || !label) continue;
    const lines = wrapText(label, LINK_TEXT.chars);
    // The middle of the curve.
    const [x0, y0, x1, y1, x2, y2, x3, y3] = points as [
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
    ];
    labelBoxes.push({
      x: (x0 + 3 * x1 + 3 * x2 + x3) / 8,
      y: (y0 + 3 * y1 + 3 * y2 + y3) / 8,
      width:
        Math.max(...lines.map((line) => line.length)) * LINK_TEXT.size * 0.56 +
        16,
      lines,
    });
  }
  const labelHeight = (label: Label) => label.lines.length * LINK_TEXT.line + 8;

  const left =
    Math.min(
      ...all.map((box) => box.x),
      ...curves.flatMap((curve) => curve.points.filter((_, i) => i % 2 === 0)),
      ...labelBoxes.map((label) => label.x - label.width / 2),
    ) - PAD;
  const top =
    Math.min(
      ...all.map((box) => box.y),
      ...labelBoxes.map((label) => label.y - labelHeight(label) / 2),
    ) - PAD;
  const right =
    Math.max(
      ...all.map((box) => box.x + NODE_WIDTH),
      ...curves.flatMap((curve) => curve.points.filter((_, i) => i % 2 === 0)),
      ...labelBoxes.map((label) => label.x + label.width / 2),
    ) + PAD;
  const bottom =
    Math.max(
      ...all.map((box) => box.y + box.height),
      ...labelBoxes.map((label) => label.y + labelHeight(label) / 2),
    ) + PAD;
  const width = Math.ceil(right - left);
  const height = Math.ceil(bottom - top);
  // Shift everything so the drawing starts at 0,0.
  const X = (x: number) => Math.round((x - left) * 10) / 10;
  const Y = (y: number) => Math.round((y - top) * 10) / 10;

  const path = ({ points: [x0, y0, x1, y1, x2, y2, x3, y3] }: Curve) =>
    `<path d="M${X(x0!)} ${Y(y0!)} C${X(x1!)} ${Y(y1!)} ${X(x2!)} ${Y(y2!)} ${X(x3!)} ${Y(y3!)}"/>`;
  const treeEdges = curves.filter((curve) => curve.tree).map(path);
  const linkEdges = curves.filter((curve) => !curve.tree).map(path);
  const linkLabels = labelBoxes.map((label) => {
    const boxHeight = labelHeight(label);
    return (
      `<g><rect x="${X(label.x - label.width / 2)}" y="${Y(label.y - boxHeight / 2)}" width="${Math.round(label.width)}" height="${boxHeight}" rx="6" fill="#ffffff" stroke="${LINE}"/>` +
      `<text font-size="${LINK_TEXT.size}" fill="${INK}" text-anchor="middle">${label.lines
        .map(
          (line, i) =>
            `<tspan x="${X(label.x)}" y="${Y(label.y - boxHeight / 2 + 4 + (i + 0.75) * LINK_TEXT.line)}">${escapeXml(line)}</tspan>`,
        )
        .join("")}</text></g>`
    );
  });

  const nodes = all.map((box) => {
    const text = box.root ? ROOT_TEXT : TEXT;
    const color = box.node.color;
    const fill = color?.startsWith("#")
      ? color
      : (fills[color ?? ""] ??
        (box.root ? "#ffffff" : fills["surface-raised"]));
    const first =
      box.y +
      (box.height - box.lines.length * text.line) / 2 +
      text.line * 0.72;
    return (
      `<g><rect x="${X(box.x)}" y="${Y(box.y)}" width="${NODE_WIDTH}" height="${box.height}" rx="12" fill="${fill}" stroke="${LINE}" stroke-width="${box.root ? 2 : 1}"/>` +
      `<text font-size="${text.size}"${box.root ? ' font-weight="600"' : ""} fill="${INK}">${box.lines
        .map(
          (line, i) =>
            `<tspan x="${X(box.x + 17)}" y="${Y(first + i * text.line)}">${escapeXml(line)}</tspan>`,
        )
        .join("")}</text></g>`
    );
  });

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="${escapeXml(FONT)}" role="img">`,
    `<title>${escapeXml(oneLine(title))}</title>`,
    `<rect width="${width}" height="${height}" fill="#ffffff"/>`,
    `<g fill="none" stroke="${LINE}" stroke-width="1.5" stroke-linecap="round">${treeEdges.join("")}</g>`,
    `<g fill="none" stroke="${INK_MUTED}" stroke-width="1.25" stroke-dasharray="6 5" stroke-linecap="round">${linkEdges.join("")}</g>`,
    nodes.join(""),
    linkLabels.join(""),
    `</svg>`,
    "",
  ].join("\n");
}

/** `maps.export`: one map's outline and drawing, named after its title. */
export function exportMap(
  db: Database.Database,
  input: {
    planId: string;
    topicId: string;
    mapId?: string;
    language: MapExportLanguage;
  },
): { filename: string; markdown: string; svg: string } {
  const map = readStoredMap(db, input.planId, input.topicId, input.mapId);
  if (!map) throw new Error("map-missing");
  const context = db
    .prepare(
      "SELECT p.title AS planTitle, t.title AS topicTitle FROM topics t JOIN plans p ON p.id = t.plan_id WHERE t.id = ? AND p.id = ?",
    )
    .get(input.topicId, input.planId) as {
    planTitle: string;
    topicTitle: string;
  };
  const name =
    map.title
      .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 100) || labels[input.language].untitled;
  return {
    filename: `${name}.md`,
    markdown: mapOutline(map.title, map.graph, context, input.language),
    svg: mapSvg(map.title, map.graph),
  };
}
