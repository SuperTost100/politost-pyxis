import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { invoke } from "../../lib/ipc";
import { readDrillRequest, stoppedTopic } from "./gapDrillRequest";

/**
 * Ripasso mirato: a targeted drill on a topic's gaps, built by a durable job. The page watches the job and opens the
 * quiz once it is ready. `?drill=<topicId>` in the address starts one, as a step on the path asks for it; the request
 * is spent once read, so Back from the drill's quiz does not start another.
 */
export function useGapDrill(planId: string) {
  const navigate = useNavigate();
  const client = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedDrill = searchParams.get("drill");
  const startedDrill = useRef<string | null>(null);
  const [drill, setDrill] = useState<{
    topicId: string;
    gapId?: string;
  } | null>(null);
  // The topic of a drill that could not be started: there is no job to read, so Retry needs it kept here.
  const [failedTopic, setFailedTopic] = useState<string | null>(null);
  const drillRead = useQuery({
    queryKey: ["gap-drill", planId, drill?.topicId, drill?.gapId],
    enabled: Boolean(drill),
    gcTime: 0,
    queryFn: () =>
      invoke("study.gapDrillRead", {
        planId,
        topicId: drill?.topicId ?? "",
        ...(drill?.gapId ? { gapId: drill.gapId } : {}),
      }),
    // A failed read stops the polling: the page says so, and Retry reads again.
    refetchInterval: (query) =>
      query.state.status !== "error" &&
      ["queued", "running"].includes(query.state.data?.state ?? "queued")
        ? 1500
        : false,
  });
  // A read that failed says nothing about the job, so it is not taken for a drill that is queued.
  const readFailed = Boolean(drill) && drillRead.isError;
  const state = drill ? (drillRead.data?.state ?? "queued") : null;
  const preparing = !readFailed && (state === "queued" || state === "running");
  const jobStopped =
    state === "failed" || state === "cancelled" || state === "interrupted";
  const readyAttempt =
    drill && state === "succeeded" ? drillRead.data?.attemptId : null;
  useEffect(() => {
    if (!drill || !readyAttempt) return;
    setDrill(null);
    navigate(`/plans/${planId}/quiz/${drill.topicId}?attempt=${readyAttempt}`);
  }, [drill, readyAttempt, planId]);

  async function start(topicId: string, gapId?: string) {
    if (preparing) return;
    setFailedTopic(null);
    setDrill({ topicId, gapId });
    try {
      await invoke("study.gapDrillStart", {
        planId,
        topicId,
        ...(gapId ? { gapId } : {}),
      });
      await client.invalidateQueries({ queryKey: ["gap-drill", planId] });
    } catch {
      setDrill(null);
      setFailedTopic(topicId);
    }
  }

  useEffect(() => {
    const request = readDrillRequest(requestedDrill, startedDrill.current);
    startedDrill.current = request.started;
    if (!request.begin) return;
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.delete("drill");
        return next;
      },
      { replace: true },
    );
    void start(request.begin);
  }, [requestedDrill]);

  const stopped = stoppedTopic(failedTopic, jobStopped || readFailed, drill?.topicId ?? null);
  return {
    start,
    /** The topic whose drill is being prepared, while it is. */
    preparing: preparing ? (drill?.topicId ?? null) : null,
    /** The topic whose drill stopped, with nothing to open. */
    stopped,
    /** The drill's state could not be read, so it is not known to have stopped. */
    readFailed,
    /** Reads the drill again after a failed read; otherwise starts the stopped drill again. */
    retry: () => {
      if (readFailed) {
        void drillRead.refetch();
        return;
      }
      setFailedTopic(null);
      setDrill(null);
      if (stopped) void start(stopped);
    },
    dismiss: () => {
      setFailedTopic(null);
      setDrill(null);
    },
  };
}
