export type BoardPoint = { x: number; y: number };
export type BoardStroke = { width: number; points: BoardPoint[] };

export function strokeHits(stroke: BoardStroke, at: BoardPoint): boolean {
  for (let index = 0; index < stroke.points.length; index += 1) {
    const start = stroke.points[index];
    const end = stroke.points[index + 1] ?? start;
    if (!start || !end) continue;
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const length = dx * dx + dy * dy;
    const t =
      length === 0
        ? 0
        : Math.max(0, Math.min(1, ((at.x - start.x) * dx + (at.y - start.y) * dy) / length));
    const distance = Math.hypot(at.x - (start.x + t * dx), at.y - (start.y + t * dy));
    if (distance <= 18) return true;
  }
  return false;
}
