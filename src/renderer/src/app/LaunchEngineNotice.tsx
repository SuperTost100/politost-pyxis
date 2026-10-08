import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useLocation } from "react-router";
import { EngineNoticeModal, unacknowledged, type NoticeEngine } from "../components/EngineNotice";
import { invoke } from "../lib/ipc";

/** The launch check runs once per app start, and a reload of the window does not count as a start. */
const SETTLED_KEY = "pyxis.engineNoticeChecked";
const isSettled = () => sessionStorage.getItem(SETTLED_KEY) === "1";
const settle = () => sessionStorage.setItem(SETTLED_KEY, "1");

/**
 * A profile from before engines were acknowledged can have ready engines that never saw the notice. Show it once,
 * together for all of them, right after launch. It never appears later, so no quiz or chat is interrupted.
 */
export function LaunchEngineNotice({ ready }: { ready: boolean }) {
  const { pathname } = useLocation();
  const onboarding = pathname.startsWith("/onboarding");
  // A launch that begins in setup has already shown the notice there.
  useEffect(() => {
    if (onboarding) settle();
  }, [onboarding]);
  const run = ready && !onboarding && !isSettled();
  const overview = useQuery({
    queryKey: ["engines"],
    queryFn: () => invoke("engines.overview", {}),
    enabled: run,
  });
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
