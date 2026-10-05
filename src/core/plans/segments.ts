// A plan build never asks the model to echo every page. Sources are folded into at most
// SEGMENT_LIMIT numbered segments and the model names only the ones a topic is mainly about.

export const SEGMENT_LIMIT = 120;
/** Sources whose sections carry no structure (pasted text, DOCX) are cut by passage order. */
const FLAT_PARTS = 24;

export type SegmentRow = {
  id: string;
  source_id: string;
  text: string;
  section_path: string | null;
};
export type Segment = {
  id: string;
  sourceId: string;
  label: string;
  passageIds: string[];
  sample: string;
  /** True when several sections were folded into this segment. */
  packed: boolean;
};

const sectionOf = (row: SegmentRow) => row.section_path ?? "Material";

function chunk<T>(items: T[], parts: number): T[][] {
  const size = Math.ceil(items.length / parts);
  return Array.from({ length: Math.ceil(items.length / size) }, (_, i) =>
    items.slice(i * size, (i + 1) * size),
  );
}

/** `rows` arrive in reading order; segments keep that order and use ids s1, s2, ... */
export function buildSegments(
  rows: SegmentRow[],
  limit = SEGMENT_LIMIT,
): Segment[] {
  const bySource = new Map<string, SegmentRow[]>();
  for (const row of rows)
    bySource.set(row.source_id, [...(bySource.get(row.source_id) ?? []), row]);
  const perSource = Math.max(1, Math.floor(limit / Math.max(bySource.size, 1)));
  const out: Segment[] = [];
  const add = (
    sourceId: string,
    group: SegmentRow[],
    label: string,
    packed: boolean,
  ) =>
    out.push({
      id: `s${out.length + 1}`,
      sourceId,
      label,
      passageIds: group.map((row) => row.id),
      sample: group[0]?.text ?? "",
      packed,
    });
  for (const [sourceId, list] of bySource) {
    const sections = new Map<string, SegmentRow[]>();
    for (const row of list)
      sections.set(sectionOf(row), [
        ...(sections.get(sectionOf(row)) ?? []),
        row,
      ]);
    const groups = [...sections.entries()];
    if (groups.length === 1 && list.length > 1) {
      const parts = chunk(list, Math.min(perSource, FLAT_PARTS, list.length));
      parts.forEach((part, i) =>
        add(sourceId, part, `${groups[0]![0]} ${i + 1}/${parts.length}`, false),
      );
    } else if (groups.length <= perSource) {
      for (const [label, group] of groups) add(sourceId, group, label, false);
    } else {
      for (const part of chunk(groups, perSource)) {
        const first = part[0]![0];
        const last = part.at(-1)![0];
        add(
          sourceId,
          part.flatMap(([, group]) => group),
          first === last ? first : `${first} to ${last}`,
          true,
        );
      }
    }
  }
  return out;
}

/**
 * Passage ids per topic. A segment no topic names goes to the topic that owns the nearest
 * earlier segment of the same source, or the nearest later one when it comes first.
 */
export function passagesByTopic(
  segments: Segment[],
  named: string[][],
): string[][] {
  const owners = new Map<string, Set<number>>();
  named.forEach((ids, topic) =>
    ids.forEach((id) => {
      const set = owners.get(id) ?? new Set<number>();
      set.add(topic);
      owners.set(id, set);
    }),
  );
  const filled = new Map(owners);
  const sweep = (list: Segment[]) => {
    const last = new Map<string, Set<number>>();
    for (const segment of list) {
      const own = owners.get(segment.id);
      if (own) last.set(segment.sourceId, own);
      else if (!filled.has(segment.id) && last.has(segment.sourceId))
        filled.set(segment.id, last.get(segment.sourceId)!);
    }
  };
  sweep(segments);
  sweep([...segments].reverse());
  return named.map((_, topic) =>
    segments
      .filter((segment) => filled.get(segment.id)?.has(topic))
      .flatMap((segment) => segment.passageIds),
  );
}
