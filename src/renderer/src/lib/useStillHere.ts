import { useCallback, useContext, useEffect, useRef } from "react";
import { UNSAFE_DataRouterContext, useLocation } from "react-router";

/** The part of the router's state the decision reads. */
export interface RouterSnapshot {
  navigation: { state: string };
  location: { pathname: string; key: string };
}

/** Whether the page drawn for `page.pathname` and `page.key` is still the entry the router shows, and still mounted. */
export function isStillHere(
  router: RouterSnapshot | undefined,
  page: { pathname: string; key: string; mounted: boolean },
): boolean {
  if (!page.mounted) return false;
  return (
    !router ||
    (router.navigation.state === "idle" &&
      router.location.pathname === page.pathname &&
      router.location.key === page.key)
  );
}

/**
 * Tells whether the page that is rendering is still the page the router shows. A page cleans up its own address (a
 * request it has read, a flag that belongs to its arrival) with a relative navigation, and that navigation always
 * applies to the router's current location, not to the page that asked. An effect can run after the router has moved
 * on, because React commits a page and runs its effects a little later, and so can a callback that waits for a reply.
 * Asked at that moment, the cleanup would drop the parameters of the page the student is on now, or pull them back.
 *
 * Call the returned function right before the cleanup, in the same synchronous step: it reads the router's own state,
 * which is ahead of what React has rendered. It is false while another navigation is under way too, because the
 * cleanup would cancel it. A page that is no longer current has nothing left to clean up: its address went with it.
 *
 * "The page" is one history entry, not one path: two entries can share a pathname, as two requests opened on the same
 * map page do, so the entry's key is compared too. A callback made while another entry was showing never passes, and
 * neither does one that outlives the component.
 */

export function useStillHere(): () => boolean {
  const router = useContext(UNSAFE_DataRouterContext)?.router;
  const { pathname, key } = useLocation();
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return useCallback(
    () => isStillHere(router?.state, { pathname, key, mounted: mounted.current }),
    [router, pathname, key],
  );
}
