import type Database from "better-sqlite3";

// Which lesson items are a part's text. This module imports nothing at run time, so any core module can use it
// without an import cycle.

/** The part id a `lesson.part` item's cache key carries as its scope, as SQL on the item's alias; NULL otherwise. */
const scopeOf = (item: string) =>
  `CASE WHEN json_valid(json_extract(${item}.body_json, '$.cacheKey'))
    THEN json_extract(json_extract(${item}.body_json, '$.cacheKey'), '$.scopeId') END`;

/**
 * SQL that is true when item `item` is a text of lesson part `part` (both table aliases): the text the part points at
 * now, or an earlier text of it in another wording. Every part text is saved with the template `lesson.part` and a
 * cache key whose scope is the part's id, so an earlier wording stays a text of its part after the part points at a
 * newer one. To leave every part text out of a list of items:
 * `NOT EXISTS (SELECT 1 FROM lesson_parts lp WHERE ${partTextSql("lp", "items")})`.
 */
export function partTextSql(part: string, item: string): string {
  return `(${part}.item_id = ${item}.id OR (${item}.prompt_template = 'lesson.part' AND ${part}.id = ${scopeOf(item)}))`;
}

/** The part an item is a text of, through the indexes on items' ids and on `lesson_parts`. */
export const PART_OF_TEXT_SQL = `SELECT lp.id AS partId, lp.outline_id AS outlineId, lp.position, lp.kind
  FROM items i JOIN lesson_parts lp ON ${partTextSql("lp", "i")}
  WHERE i.id = ?`;

export type PartOfText = { partId: string; outlineId: string; position: number; kind: "part" | "recap" };

/** The part a lesson item is a text of, in any wording, or null for an item that is no part's text. */
export function partOfText(db: Database.Database, itemId: string): PartOfText | null {
  return (db.prepare(PART_OF_TEXT_SQL).get(itemId) as PartOfText | undefined) ?? null;
}
