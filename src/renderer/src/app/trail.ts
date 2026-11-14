/**
 * The trail: one record per history entry of the window, beside the browser's own history, so a page's back control can
 * name the place the student came from and return to it. Pure: `history.ts` feeds it the router's navigations and keeps
 * it in session storage.
 */

/** What a back control calls a place: an interface key, resolved in the app's language when drawn, or the student's own words. */
export type PlaceName = { key: string; values?: Record<string, string> } | { text: string };

/** The sidebar row a visit lights: a section, a chat's own row, or none (Settings opened first, the gallery). */
export type Section = "ask" | "exams" | "maps" | "flashcards" | "library" | { chat: string } | null;

export type Visit = {
  /** The router location's key, which `window.history.state` keeps across a reload. */
  key: string;
  /** The entry's position in the window's history (`window.history.state.idx`). */
  idx: number;
  /** Pathname and search. */
  path: string;
  /** `pageOf(pathname)`: moves inside one page keep it. */
  page: string;
  /** The sidebar row lit while it shows: the section of the page that opened it, so a map opened from an exam keeps Esami lit. */
  section: Section;
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

/** Where the window keeps its trail, in session storage. */
export const TRAIL_STORE = "pyxis.trail";

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

/**
 * The section a path belongs to by itself, which a visit takes when it starts a trail, when it is a chat (a chat always
 * lights its own row) or when the page that opened it had none.
 */
export function sectionOf(path: string): Section {
  const pathname = pageOf(path);
  const chat = /^\/ask\/([^/]+)$/.exec(pathname);
  if (chat) return { chat: chat[1]! };
  if (pathname === "/ask") return "ask";
  if (pathname === "/exams/library") return "library";
  if (/^\/maps(\/|$)/.test(pathname) || /^\/plans\/[^/]+\/map\//.test(pathname)) return "maps";
  if (/^\/(exams|plans)(\/|$)/.test(pathname)) return "exams";
  if (pathname === "/flashcards" || pathname.startsWith("/flashcards/") || pathname.startsWith("/cards/")) return "flashcards";
  return null;
}

/** Chiedi lights its own row wherever it is opened from: a chat its row, a new chat "Nuova chat". */
const isChat = (section: Section): boolean => section === "ask" || (section !== null && typeof section === "object");

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
 * The row a page opened from `showing` lights. The page that opened it lights its row for it, except where the path
 * names its own: a sidebar row, a page from outside, a chat, or an opener with no row.
 */
function pushedSection(showing: Visit | undefined, path: string, via: Navigation["via"]): Section {
  const own = via !== undefined || !showing || (showing.page !== pageOf(path) && isChat(sectionOf(path)));
  return own ? sectionOf(path) : (showing.section ?? sectionOf(path));
}

/**
 * The row to light for a page the window shows or is about to open, which the sidebar follows from the start of the
 * navigation. A page the trail knows (the one showing, or an entry going back or forward) has its own record; a new
 * one is read as a push.
 */
export function sectionFor(trail: Trail, target: { key: string; path: string; via?: Navigation["via"] }): Section {
  const known = find(trail, target.key);
  if (known && known.page === pageOf(target.path)) return known.section;
  return pushedSection(find(trail, trail.current), target.path, target.via);
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
    // An address typed into the window arrives with the key "default" and no position of its own: it is a new last
    // entry, so nothing is ahead of it, whatever the trail still holds above position 0.
    const typed = nav.key === "default";
    const others = trail.visits.filter((visit) => visit.idx !== nav.idx && visit.key !== nav.key && !(typed && visit.idx > nav.idx));
    return {
      visits: capped([...others, { key: nav.key, idx: nav.idx, path: nav.path, page, section: sectionOf(nav.path), from: null }], nav.key),
      current: nav.key,
    };
  }
  if (nav.action === "REPLACE") {
    const samePage = showing?.page === page;
    // A sidebar row clicked while its page shows replaces it, and starts the trail over. A chat lights its own row.
    const own = nav.via !== undefined || (!samePage && isChat(sectionOf(nav.path)));
    const visit: Visit = {
      key: nav.key,
      idx: nav.idx,
      path: nav.path,
      page,
      section: own ? sectionOf(nav.path) : (showing?.section ?? sectionOf(nav.path)),
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
  const section = pushedSection(showing, nav.path, nav.via);
  return { visits: capped([...behind, { key: nav.key, idx: nav.idx, path: nav.path, page, section, from }], nav.key), current: nav.key };
}

/** The visit `key` was opened from, while it is still behind it in the window's history and still exists. */
export function origin(trail: Trail, key: string): Visit | null {
  const visit = find(trail, key);
  const from = find(trail, visit?.from ?? null);
  if (!visit || !from || from.gone || from.idx >= visit.idx) return null;
  return from;
}

/**
 * Whether the window's history has a page ahead of the one showing, which Avanti goes to. A page the student deleted
 * is not one.
 */
export function canForward(trail: Trail, key: string | null): boolean {
  const here = find(trail, key);
  const next = here && trail.visits.find((visit) => visit.idx === here.idx + 1);
  return Boolean(next && !next.gone);
}

/**
 * The id of the chat whose row the window's page lights: a tool opened from a chat takes that chat's section, so it can
 * hand its work back there. None for a new chat, or a page that came from elsewhere.
 */
export function lastChat(trail: Trail): string | undefined {
  const section = find(trail, trail.current)?.section;
  return section && typeof section === "object" ? section.chat : undefined;
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

function isSection(value: unknown): value is Section {
  if (value === null || value === "ask" || value === "exams" || value === "maps" || value === "flashcards" || value === "library")
    return true;
  return typeof value === "object" && typeof (value as { chat?: unknown }).chat === "string";
}

function isVisit(value: unknown): value is Visit {
  if (!value || typeof value !== "object") return false;
  const visit = value as Record<string, unknown>;
  return (
    // A trail written before visits carried their section has none: it is read from the path.
    (visit.section === undefined || isSection(visit.section)) &&
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
    return {
      visits: capped(
        visits.map((visit) => ({ ...visit, section: visit.section === undefined ? sectionOf(visit.path) : visit.section })),
        current,
      ),
      current,
    };
  } catch {
    return emptyTrail;
  }
}
