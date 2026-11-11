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
    refetchInterval: (query) =>
      ["queued", "running"].includes(query.state.data?.state ?? "queued")
        ? 1500
        : false,
  });
  const state = drill ? (drillRead.data?.state ?? "queued") : null;
  const preparing = state === "queued" || state === "running";
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

  return {
    start,
    /** The topic whose drill is being prepared, while it is. */
    preparing: preparing ? (drill?.topicId ?? null) : null,
    /** The topic whose drill stopped, with nothing to open. */
    stopped: stoppedTopic(failedTopic, jobStopped, drill?.topicId ?? null),
    dismiss: () => {
      setFailedTopic(null);
      setDrill(null);
    },
  };
}
