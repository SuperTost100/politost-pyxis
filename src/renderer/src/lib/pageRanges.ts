/** "3, 7–9, 12": runs of consecutive pages joined by an en dash, as page ranges are printed. Expects pages sorted. */
export function pageRanges(pages: number[]): string {
  const runs: string[] = [];
  let start = pages[0];
  for (let index = 0; index < pages.length; index += 1) {
    const page = pages[index]!;
    const next = pages[index + 1];
    if (next === page + 1) continue;
    runs.push(start === page ? String(page) : `${start}–${page}`);
    start = next;
  }
  return runs.join(", ");
}
