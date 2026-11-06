// Ask, Exams and Maps each remember the page they were left on, for the sidebar and the Go menu.

type Door = "ask" | "exams" | "maps";

const doorRoots: Record<Door, string> = {
  ask: "/ask",
  exams: "/exams",
  maps: "/maps",
};

const LAST_KEY = "pyxis.lastDoorPath";

function readLast(): Record<Door, string> {
  try {
    const raw = JSON.parse(sessionStorage.getItem(LAST_KEY) ?? "") as Partial<
      Record<Door, string>
    >;
    return {
      ask: raw.ask || doorRoots.ask,
      exams: raw.exams || doorRoots.exams,
      maps: raw.maps || doorRoots.maps,
    };
  } catch {
    return { ...doorRoots };
  }
}

/** Settings and dev pages belong to no door, so neither door is selected there. */
function doorForPath(pathname: string): Door | null {
  if (pathname.startsWith("/ask")) return "ask";
  if (pathname.startsWith("/exams") || pathname.startsWith("/plans"))
    return "exams";
  if (pathname.startsWith("/maps")) return "maps";
  return null;
}

/**
 * Records `pathname` as where its door was left. The router calls it on every navigation it finishes, not a render
 * effect: React can skip the render of a page the student passed through quickly, and the door would then remember a
 * page left earlier.
 */
export function rememberDoorPath(pathname: string): void {
  const door = doorForPath(pathname);
  if (!door) return;
  sessionStorage.setItem(
    LAST_KEY,
    JSON.stringify({ ...readLast(), [door]: pathname }),
  );
}

/** Where a door leads from `pathname`: back to where it was left, or to its root when it is already open. */
export function doorTarget(door: Door, pathname: string): string {
  if (doorForPath(pathname) === door) return doorRoots[door];
  return readLast()[door];
}
