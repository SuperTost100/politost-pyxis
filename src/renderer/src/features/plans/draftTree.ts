// The guided flow's topic tree (PLAN-12), edited before the plan exists. Two levels: topics and
// their subtopics. Every function returns a new tree and leaves unknown keys alone.

export type DraftSub = { key: string; title: string };
export type DraftNode = {
  key: string;
  title: string;
  summary: string;
  subtopics: DraftSub[];
};
export type DropPosition = -1 | 0 | 1;

let seq = 0;
const nextKey = (prefix: string) => `${prefix}${(seq += 1)}`;

export function fromProposal(
  topics: Array<{ title: string; summary: string; subtopics: string[] }>,
): DraftNode[] {
  return topics.map((topic) => ({
    key: nextKey("t"),
    title: topic.title,
    summary: topic.summary,
    subtopics: topic.subtopics.map((title) => ({ key: nextKey("s"), title })),
  }));
}

/** Blank rows are dropped, so a half-added row never reaches the plan. */
export function toDraftTopics(nodes: DraftNode[]) {
  return nodes.flatMap((node) => {
    const title = node.title.trim();
    if (!title) return [];
    return [
      {
        title,
        summary: node.summary,
        subtopics: node.subtopics
          .map((sub) => sub.title.trim())
          .filter(Boolean),
      },
    ];
  });
}

export const isTopic = (nodes: DraftNode[], key: string) =>
  nodes.some((node) => node.key === key);

export function rename(
  nodes: DraftNode[],
  key: string,
  title: string,
): DraftNode[] {
  return nodes.map((node) => ({
    ...node,
    title: node.key === key ? title : node.title,
    subtopics: node.subtopics.map((sub) =>
      sub.key === key ? { ...sub, title } : sub,
    ),
  }));
}

export function addTopic(nodes: DraftNode[]): {
  nodes: DraftNode[];
  key: string;
} {
  const key = nextKey("t");
  return {
    key,
    nodes: [...nodes, { key, title: "", summary: "", subtopics: [] }],
  };
}

export function addSubtopic(
  nodes: DraftNode[],
  topicKey: string,
): { nodes: DraftNode[]; key: string } {
  const key = nextKey("s");
  return {
    key,
    nodes: nodes.map((node) =>
      node.key === topicKey
        ? { ...node, subtopics: [...node.subtopics, { key, title: "" }] }
        : node,
    ),
  };
}

export function remove(nodes: DraftNode[], key: string): DraftNode[] {
  return nodes
    .filter((node) => node.key !== key)
    .map((node) => ({
      ...node,
      subtopics: node.subtopics.filter((sub) => sub.key !== key),
    }));
}

function shift<T>(items: T[], index: number, delta: number): T[] {
  const to = index + delta;
  if (index < 0 || to < 0 || to >= items.length) return items;
  const next = [...items];
  [next[index], next[to]] = [next[to]!, next[index]!];
  return next;
}

/** Keyboard route to reordering: a topic moves among topics, a subtopic within its topic. */
export function move(
  nodes: DraftNode[],
  key: string,
  delta: -1 | 1,
): DraftNode[] {
  if (isTopic(nodes, key))
    return shift(
      nodes,
      nodes.findIndex((node) => node.key === key),
      delta,
    );
  return nodes.map((node) => ({
    ...node,
    subtopics: shift(
      node.subtopics,
      node.subtopics.findIndex((sub) => sub.key === key),
      delta,
    ),
  }));
}

/** Which drops the tree accepts: topics between topics, subtopics into or between topics. */
export function canDrop(
  nodes: DraftNode[],
  dragKey: string,
  targetKey: string,
  position: DropPosition,
): boolean {
  if (dragKey === targetKey) return false;
  return isTopic(nodes, dragKey)
    ? isTopic(nodes, targetKey) && position !== 0
    : isTopic(nodes, targetKey)
      ? position === 0
      : position !== 0;
}

export function drop(
  nodes: DraftNode[],
  dragKey: string,
  targetKey: string,
  position: DropPosition,
): DraftNode[] {
  if (!canDrop(nodes, dragKey, targetKey, position)) return nodes;
  if (isTopic(nodes, dragKey)) {
    const dragged = nodes.find((node) => node.key === dragKey)!;
    const rest = nodes.filter((node) => node.key !== dragKey);
    const at = rest.findIndex((node) => node.key === targetKey);
    return [
      ...rest.slice(0, at + (position > 0 ? 1 : 0)),
      dragged,
      ...rest.slice(at + (position > 0 ? 1 : 0)),
    ];
  }
  const sub = nodes
    .flatMap((node) => node.subtopics)
    .find((item) => item.key === dragKey)!;
  return remove(nodes, dragKey).map((node) => {
    if (isTopic(nodes, targetKey)) {
      return node.key === targetKey
        ? { ...node, subtopics: [sub, ...node.subtopics] }
        : node;
    }
    const at = node.subtopics.findIndex((item) => item.key === targetKey);
    if (at < 0) return node;
    const to = at + (position > 0 ? 1 : 0);
    return {
      ...node,
      subtopics: [
        ...node.subtopics.slice(0, to),
        sub,
        ...node.subtopics.slice(to),
      ],
    };
  });
}
