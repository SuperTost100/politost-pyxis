/** The zoom steps of the picture viewer, in per cent of the size that fits the window. */
export const ZOOM_STEPS = [50, 75, 100, 150, 200, 300] as const;
export const ZOOM_START = 100;

/** The next step up (+1) or down (-1) from `percent`, which stays where it is at the ends. */
export function zoomFrom(percent: number, way: 1 | -1): number {
  if (way === 1) return ZOOM_STEPS.find((step) => step > percent) ?? ZOOM_STEPS.at(-1)!;
  return [...ZOOM_STEPS].reverse().find((step) => step < percent) ?? ZOOM_STEPS[0];
}
