import { useSyncExternalStore } from "react";
import { viaOf, readTrail, watchTrail } from "./history";
import { sectionFor, type Section } from "./trail";

/** The sidebar row to light for the page the window shows, or is opening (a page loads on its first visit). */
export function useSection(target: { key: string; pathname: string; search: string; state: unknown }): Section {
  const trail = useSyncExternalStore(watchTrail, readTrail);
  return sectionFor(trail, { key: target.key, path: target.pathname + target.search, via: viaOf(target.state) });
}
