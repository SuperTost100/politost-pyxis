import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate, type NavigateFunction } from "react-router";
import { changed, registerBack } from "./back-slot";
import { goingBackToParent, nameVisit, readTrail, watchTrail } from "./history";
import { placeOf } from "./places";
import { origin, pageOf, wayBack, type PlaceName } from "./trail";

/** Where a page's back control leads, and what it says. */
export type BackTarget = {
  /** The place's name, in the app's language: the control's text. */
  name: string;
  /** "Torna a {{place}}", what a screen reader hears. */
  label: string;
  /** The path it leads to. */
  to: string;
  go: () => void;
  /** True while `beforeLeave` runs. */
  busy: boolean;
};

/**
 * The one hook a page calls to take its place on the trail: it writes the page's name on its history entry, so a back
 * control elsewhere can call it that, and returns the page's own way back. That leads to where the student came from,
 * by moving back in the window's history, or, with nothing behind, to the page's parent (`places.ts`) in place of this
 * entry, so the parent then shows its own way back rather than this page.
 *
 * - `name`: this page as the student knows it (an exam's title, a topic, a map). A page whose title is still loading
 *   passes null and is called by its kind meanwhile.
 * - `parent`: the parent's own name or address when the page knows better than the table, such as the exam's title.
 * - `back: "none"`: the page has no way back of its own (a sidebar section, a running simulation).
 * - `beforeLeave`: runs before the page is left this way; false keeps the student here.
 */
export function usePlace(input: {
  name?: PlaceName | null;
  parent?: { to?: string; name?: PlaceName } | null;
  back?: "show" | "none";
  beforeLeave?: () => Promise<boolean>;
}): BackTarget | null {
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const trail = useSyncExternalStore(watchTrail, readTrail);
  const [busy, setBusy] = useState(false);
  const { key } = location;
  const name = input.name ? JSON.stringify(input.name) : null;
  useEffect(() => {
    if (name) nameVisit(key, JSON.parse(name) as PlaceName);
  }, [key, name]);

  const target = input.back === "none" ? null : backTarget();

  function backTarget(): BackTarget | null {
    const from = origin(trail, key);
    const table = placeOf(location.pathname + location.search).parent;
    const parent = input.parent === null || !table ? null : { ...table, ...input.parent };
    if (!from && !parent) return null;
    const place = from ? (from.name ?? placeOf(from.path).name ?? { key: "nav.back" }) : parent!.name;
    const text = "key" in place ? t(place.key, place.values) : place.text;
    return {
      name: text,
      label: t("places.backTo", { place: text }),
      to: from ? from.path : parent!.to,
      busy,
      go: () => {
        if (busy) return;
        const leave = () => {
          // Read when leaving, which can come after `beforeLeave`: by then the student may be on another page, which
          // this page's way back must not move.
          const step = wayBack(readTrail(), key, parent !== null);
          if (step === "parent" && parent) {
            goingBackToParent(parent.to);
            void navigate(parent.to, { replace: true });
          } else if (step && step !== "parent") void navigate(step.delta);
        };
        if (!input.beforeLeave) return leave();
        setBusy(true);
        input
          .beforeLeave()
          .catch(() => false)
          .then((ok) => {
            setBusy(false);
            if (ok) leave();
          });
      },
    };
  }

  // The menu, the mouse's back button and the swipe run the way back this page shows now. It is registered while the
  // page is mounted, and kept as the page's latest render left it.
  const latest = useRef(target);
  useEffect(() => {
    latest.current = target;
    changed();
  });
  useEffect(() => registerBack(() => latest.current), []);

  return target;
}

/**
 * For a button that names the place it returns to, such as "Torna al percorso": when the back control leads to that
 * page, the button goes back the same way, so history keeps one entry per page; otherwise it opens the page.
 */
export function returnTo(back: BackTarget | null, path: string, navigate: NavigateFunction): void {
  if (back && pageOf(back.to) === pageOf(path)) back.go();
  else void navigate(path);
}
