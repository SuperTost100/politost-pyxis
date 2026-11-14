/**
 * The trail: one record per history entry of the window, beside the browser's own history, so a page's back control can
 * name the place the student came from and return to it. Pure: `history.ts` feeds it the router's navigations and keeps
 * it in session storage.
 */

/** What a back control calls a place: an interface key, resolved in the app's language when drawn, or the student's own words. */
export type PlaceName = { key: string; values?: Record<string, string> } | { text: string };

export type Visit = {
  /** The router location's key, which `window.history.state` keeps across a reload. */
  key: string;
  /** The entry's position in the window's history (`window.history.state.idx`). */
  idx: number;
  /** Pathname and search. */
  path: string;
  /** `pageOf(pathname)`: moves inside one page keep it. */
  page: string;
  /** The key of the visit this one was opened from, or null when it has none (the first page, a reminder, a file). */
  from: string | null;
  /** What a back control elsewhere calls this visit, written by the page once it knows it. */
  name?: PlaceName;
  /** What had the focus when the student left this visit, so going back can return the focus there. */
  opener?: string;
  /** The thing the page showed was deleted: a back control no longer leads here. */
  gone?: boolean;
};

export type Trail = { visits: Visit[]; current: string | null };

export type Navigation = {
  action: "PUSH" | "REPLACE" | "POP";
  key: string;
  idx: number;
  /** Pathname and search. */
  path: string;
  /** A navigation that starts a new trail: a sidebar section, or a page opened from outside (a reminder, a file). */
  via?: "sidebar" | "outside";
  /** On a PUSH: what had the focus on the page being left. */
  opener?: string;
};

/** The most visits kept; the oldest go first. */
export const TRAIL_CAP = 200;

export const emptyTrail: Trail = { visits: [], current: null };

/**
 * The page a path belongs to: its pathname without a trailing slash, with every Settings section one page. The query
 * never makes a new page, so a lesson's `?part=3` or a filter is a move inside the page.
 */
export function pageOf(path: string): string {
  const pathname = path.split(/[?#]/)[0]!.replace(/\/+$/, "") || "/";
  return pathname === "/settings" || pathname.startsWith("/settings/") ? "/settings" : pathname;
}

const find = (trail: Trail, key: string | null) =>
  key == null ? undefined : trail.visits.find((visit) => visit.key === key);

/**
 * At most TRAIL_CAP visits: the ones nearest the visit the window shows, so it always stays, with the entries just
 * behind it that its way back needs. After a push those are the newest.
 */
function capped(visits: Visit[], current: string | null): Visit[] {
  if (visits.length <= TRAIL_CAP) return visits;
  const at = visits.find((visit) => visit.key === current)?.idx ?? Math.max(...visits.map((visit) => visit.idx));
  return [...visits]
    .sort((a, b) => Math.abs(a.idx - at) - Math.abs(b.idx - at) || b.idx - a.idx)
    .slice(0, TRAIL_CAP)
    .sort((a, b) => a.idx - b.idx);
}

/**
 * The trail after one navigation the router finished. A PUSH records where it came from: the visit that was showing,
 * or, for a move inside the same page, that visit's own origin; a new trail starts from a sidebar section or from
 * outside. A REPLACE takes over the replaced visit's origin, so a redirect or an address the page rewrites keeps it. A
 * POP returns to a recorded visit and changes nothing else; one the trail does not know (the first page of a window,
 * or a trail that was lost) starts with no origin.
 */
export function arrive(trail: Trail, nav: Navigation): Trail {
  const showing = find(trail, trail.current);
  const page = pageOf(nav.path);
  if (nav.action === "POP") {
    // An entry that now shows another page (an address typed into the window keeps the key "default") is a new visit.
    const known = find(trail, nav.key);
    if (known && known.page === page)
      return {
        visits: trail.visits.map((visit) => (visit === known ? { ...visit, idx: nav.idx, path: nav.path, page } : visit)),
        current: nav.key,
      };
    const others = trail.visits.filter((visit) => visit.idx !== nav.idx && visit.key !== nav.key);
    return { visits: capped([...others, { key: nav.key, idx: nav.idx, path: nav.path, page, from: null }], nav.key), current: nav.key };
  }
  if (nav.action === "REPLACE") {
    const samePage = showing?.page === page;
    const visit: Visit = {
      key: nav.key,
      idx: nav.idx,
      path: nav.path,
      page,
      // A page from outside (a file opened over the shared-exam page) starts the trail over, so it goes to its parent.
      from: nav.via ? null : (showing?.from ?? null),
      ...(samePage && showing?.name ? { name: showing.name } : {}),
      ...(showing?.opener ? { opener: showing.opener } : {}),
    };
    // An entry ahead that was opened from the replaced one now comes from its replacement.
    const others = trail.visits
      .filter((visit) => visit !== showing && visit.idx !== nav.idx && visit.key !== nav.key)
      .map((visit) => (showing && visit.from === showing.key ? { ...visit, from: nav.key } : visit));
    return { visits: capped([...others, visit], nav.key), current: nav.key };
  }
  // PUSH: the entries ahead of the new one are gone from the window's history, as the browser drops them.
  const from = nav.via || !showing ? null : showing.page === page ? showing.from : showing.key;
  const behind = trail.visits
    .filter((visit) => visit.idx < nav.idx && visit.key !== nav.key)
    .map((visit) => {
      if (visit !== showing) return visit;
      const { opener: _left, ...rest } = visit;
      return nav.opener === undefined ? rest : { ...rest, opener: nav.opener };
    });
  return { visits: capped([...behind, { key: nav.key, idx: nav.idx, path: nav.path, page, from }], nav.key), current: nav.key };
}

/** The visit `key` was opened from, while it is still behind it in the window's history and still exists. */
export function origin(trail: Trail, key: string): Visit | null {
  const visit = find(trail, key);
  const from = find(trail, visit?.from ?? null);
  if (!visit || !from || from.gone || from.idx >= visit.idx) return null;
  return from;
}

/**
 * How the back control of the visit `key` leaves it: back in history to its origin, to its parent when it has one,
 * or not at all when the window no longer shows that visit (the student moved on while the page finished its work).
 */
export function wayBack(trail: Trail, key: string, hasParent: boolean): { delta: number } | "parent" | null {
  if (trail.current !== key) return null;
  const behind = origin(trail, key);
  const here = find(trail, key);
  if (behind && here) return { delta: behind.idx - here.idx };
  return hasParent ? "parent" : null;
}

/** The visit the window shows. */
export function currentVisit(trail: Trail): Visit | null {
  return find(trail, trail.current) ?? null;
}

/** Writes the name a page gives itself on its visit. */
export function named(trail: Trail, key: string, name: PlaceName): Trail {
  const visit = find(trail, key);
  if (!visit || JSON.stringify(visit.name) === JSON.stringify(name)) return trail;
  return { ...trail, visits: trail.visits.map((item) => (item === visit ? { ...item, name } : item)) };
}

/** Marks the visits whose path `gone` matches as deleted, so no back control leads to them any more. */
export function forget(trail: Trail, gone: (path: string) => boolean): Trail {
  if (!trail.visits.some((visit) => !visit.gone && gone(visit.path))) return trail;
  return { ...trail, visits: trail.visits.map((visit) => (!visit.gone && gone(visit.path) ? { ...visit, gone: true } : visit)) };
}

function isName(value: unknown): value is PlaceName {
  if (!value || typeof value !== "object") return false;
  const name = value as Record<string, unknown>;
  if (typeof name.text === "string") return true;
  if (typeof name.key !== "string") return false;
  return (
    name.values === undefined ||
    (typeof name.values === "object" &&
      name.values !== null &&
      Object.values(name.values).every((item) => typeof item === "string"))
  );
}

function isVisit(value: unknown): value is Visit {
  if (!value || typeof value !== "object") return false;
  const visit = value as Record<string, unknown>;
  return (
    typeof visit.key === "string" &&
    typeof visit.idx === "number" &&
    Number.isInteger(visit.idx) &&
    typeof visit.path === "string" &&
    typeof visit.page === "string" &&
    (visit.from === null || typeof visit.from === "string") &&
    (visit.name === undefined || isName(visit.name)) &&
    (visit.opener === undefined || typeof visit.opener === "string") &&
    (visit.gone === undefined || typeof visit.gone === "boolean")
  );
}

/** A stored trail, or no history when it does not read as one (another build's, or damaged). */
export function parseTrail(raw: string | null): Trail {
  if (!raw) return emptyTrail;
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object") return emptyTrail;
    const { visits, current } = value as Record<string, unknown>;
    if (!Array.isArray(visits) || !visits.every(isVisit) || !(current === null || typeof current === "string"))
      return emptyTrail;
    return { visits: capped(visits, current), current };
  } catch {
    return emptyTrail;
  }
}
