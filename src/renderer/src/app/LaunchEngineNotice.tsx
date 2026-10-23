import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useLocation } from "react-router";
import {
  EngineNoticeModal,
  unacknowledged,
  type NoticeEngine,
} from "../components/EngineNotice";
import { enginesQuery } from "../lib/queries";

/** The launch check runs once per app start, and a reload of the window does not count as a start. */
const SETTLED_KEY = "pyxis.engineNoticeChecked";
const isSettled = () => sessionStorage.getItem(SETTLED_KEY) === "1";
const settle = () => sessionStorage.setItem(SETTLED_KEY, "1");

/**
 * Ready engines whose notice was never confirmed get it once, together, right after launch or right after setup if the
 * student skipped it there. Automatic choices ignore an unconfirmed engine, so without this the first plan or chat
 * would fail. It never appears later, so no quiz or chat is interrupted.
 */
export function LaunchEngineNotice({ ready }: { ready: boolean }) {
  const { pathname } = useLocation();
  // Setup and Settings (whose engines section can open from several links) show the same notice themselves.
  const ownNotice =
    pathname.startsWith("/onboarding") || pathname.startsWith("/settings");
  const run = ready && !ownNotice && !isSettled();
  const overview = useQuery({ ...enginesQuery, enabled: run });
  const [pending, setPending] = useState<NoticeEngine[]>([]);
  useEffect(() => {
    if (!run || !overview.isSuccess) return;
    settle();
    setPending(unacknowledged(overview.data));
  }, [run, overview.isSuccess, overview.data]);
  if (pending.length === 0) return null;
  return (
    <EngineNoticeModal
      engines={pending}
      onDone={() => setPending([])}
      onLater={() => setPending([])}
    />
  );
}
