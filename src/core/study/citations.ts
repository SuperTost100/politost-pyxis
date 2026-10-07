import type Database from "better-sqlite3";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const REF = `(?:${UUID}|P\\d+)`;
const GROUP = new RegExp(`\\[\\s*(${REF}(?:\\s*[,;]\\s*${REF})*)\\s*\\]`, "gi");
const BARE = new RegExp(`\\(?\\b${UUID}\\b\\)?`, "gi");

export type Citation = { passageId: string; label: string };

/**
 * Model explanations sometimes name passages by raw ID ("[01a1…]") or by a [P1] label the quiz never defined. Each
 * reference to a passage that still exists becomes [Pn], which the renderer shows as a source chip opening
 * `citations[n - 1]`; any other reference is dropped, so no ID ever reaches the student.
 */
export function citeExplanation(
  db: Database.Database,
  text: string,
  sourceIds: string[] = [],
): { explanation: string; citations: Citation[] } {
  const wanted = new Map<string, string>();
  const refs = (group: string) =>
    group.split(/[,;]/).map((ref) => {
      const label = /^\s*P(\d+)\s*$/i.exec(ref);
      return label ? sourceIds[Number(label[1]) - 1] : ref.trim();
    });
  for (const match of text.matchAll(GROUP))
    for (const id of refs(match[1]!)) if (id) wanted.set(id, id);
  const found = new Map(
    (wanted.size
      ? (db
          .prepare(
            `SELECT p.id, p.section_path, json_extract(p.locator_json, '$.page') AS page, s.title
             FROM passages p LEFT JOIN sources s ON s.id = p.source_id
             WHERE p.id IN (${[...wanted.keys()].map(() => "?").join(", ")})`,
          )
          .all(...wanted.keys()) as Array<{
          id: string;
          section_path: string | null;
          page: number | null;
          title: string | null;
        }>)
      : []
    ).map((row) => [row.id, row]),
  );
  const citations: Citation[] = [];
  const cited = (id: string) => {
    const row = found.get(id);
    if (!row) return "";
    let index = citations.findIndex((item) => item.passageId === row.id);
    if (index < 0) {
      const label =
        row.section_path?.trim() ||
        (row.page != null ? `p. ${row.page}` : "") ||
        row.title?.trim() ||
        `P${citations.length + 1}`;
      citations.push({
        passageId: row.id,
        label: label.length > 48 ? `${label.slice(0, 47)}…` : label,
      });
      index = citations.length - 1;
    }
    return `[P${index + 1}]`;
  };
  const explanation = text
    .replace(GROUP, (_, group: string) => {
      const linked = [...new Set(refs(group).filter(Boolean))]
        .map((id) => cited(id!))
        .filter(Boolean);
      return linked.length ? ` ${linked.join(" ")}` : "";
    })
    .replace(BARE, "")
    .replace(/[ \t]+([.,;:!?])/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
  return { explanation, citations };
}

/** Adds source chips to the explanations of one attempt's answers. */
export function citedAnswers<T extends { id: string; explanation: string }>(
  db: Database.Database,
  attemptId: string,
  rows: T[],
): Array<T & { citations: Citation[] }> {
  if (!rows.length) return [];
  const item = db
    .prepare(
      "SELECT i.body_json FROM attempts a JOIN items i ON i.id = a.item_id WHERE a.id = ?",
    )
    .get(attemptId) as { body_json: string } | undefined;
  const questions = item
    ? (
        JSON.parse(item.body_json) as {
          questions?: Array<{ id: string; sourceIds?: string[] }>;
        }
      ).questions ?? []
    : [];
  return rows.map((row) => ({
    ...row,
    ...citeExplanation(
      db,
      row.explanation,
      questions.find((question) => question.id === row.id)?.sourceIds,
    ),
  }));
}
