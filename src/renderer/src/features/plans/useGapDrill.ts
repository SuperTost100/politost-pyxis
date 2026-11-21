import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { invoke } from "../../lib/ipc";
import { useStillHere } from "../../lib/useStillHere";
import { cancelsStoppedStart, drillQuizPath, drillStatus, readDrillRequest, stoppedTopic } from "./gapDrillRequest";

/**
 * Rivedi gli errori: a targeted drill on a topic's gaps, built by a durable job. The page watches the job and opens the
 * quiz once it is ready. `?drill=<topicId>` in the address starts one, as a step on the path asks for it; the request
 * is spent once read, so Back from the drill's quiz does not start another. The exam page uses it for the path's rows
 * and opens the quiz as a new page; a gap's own page (`GapPage`) starts the drill of one gap and, with `replace`, opens
 * the quiz in place of itself, so the history keeps one entry and Back goes where the gap's page would have gone.
 */
export function useGapDrill(planId: string, { replace = false }: { replace?: boolean } = {}) {
  const navigate = useNavigate();
  const client = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const stillHere = useStillHere();
  const requestedDrill = searchParams.get("drill");
  const startedDrill = useRef<string | null>(null);
  // `jobId` is the job the start made: from then on the drill is read by it, since its gap can merge into another while it is
  // written, and the read by gap then finds nothing.
  const [drill, setDrill] = useState<{
    topicId: string;
    gapId?: string;
    jobId?: string;
  } | null>(null);
  // The topic of a drill that could not be started: there is no job to read, so Retry needs it kept here.
  const [failedTopic, setFailedTopic] = useState<string | null>(null);
  // The gap of the last drill asked for, which Retry asks for again; the path's drills name a topic only.
  const lastGap = useRef<string | undefined>(undefined);
  const drillRead = useQuery({
    queryKey: ["gap-drill", planId, drill?.topicId, drill?.gapId, drill?.jobId],
    enabled: Boolean(drill),
    gcTime: 0,
    queryFn: () =>
      invoke("study.gapDrillRead", {
        planId,
        topicId: drill?.topicId ?? "",
        ...(drill?.gapId ? { gapId: drill.gapId } : {}),
        ...(drill?.jobId ? { jobId: drill.jobId } : {}),
      }),
    // A failed read stops the polling: the page says so, and Retry reads again. So does a drill with nothing more to come.
    refetchInterval: (query) =>
      query.state.status !== "error" &&
      ["queued", "running"].includes(drillStatus(query.state.data, Boolean(drill?.jobId)).state)
        ? 1500
        : false,
  });
  // A read that failed says nothing about the job, so it is not taken for a drill that is queued.
  const readFailed = Boolean(drill) && drillRead.isError;
  const status = drillStatus(drillRead.data, Boolean(drill?.jobId));
  const state = drill ? status.state : null;
  const preparing = !readFailed && (state === "queued" || state === "running");
  const jobStopped =
    state === "failed" || state === "cancelled" || state === "interrupted";
  const readyAttempt = drill && state === "succeeded" ? status.attemptId : null;
  // The drill opens only while this page is the one the router shows: the read can come back after the student has left.
  // Until then it is kept, because the answer can also be no while the page has not yet been drawn at a newer entry of
  // its own, such as the one without `?drill` that the request below leaves. A drill already built is ready at the
  // first read, inside that moment. The effect asks again once the page has caught up.
  useEffect(() => {
    if (!drill || !readyAttempt || !stillHere()) return;
    setDrill(null);
    navigate(drillQuizPath(planId, drill.topicId, readyAttempt, drill.gapId), { replace });
  }, [drill, readyAttempt, planId, stillHere]);

  // The start that is the latest: a start that is still on its way when another begins has nothing left to say.
  const latestStart = useRef(0);
  // The latest start the student stopped before its job was known: the job is stopped as soon as the start returns it.
  const stoppedStart = useRef(0);
  // What the latest start asked for, so a stopped start leaves a job a later start of the same drill was handed.
  const latestDrill = useRef<{ topicId: string; gapId?: string } | null>(null);
  async function start(topicId: string, gapId?: string) {
    if (preparing) return;
    const mine = (latestStart.current += 1);
    latestDrill.current = { topicId, gapId };
    setFailedTopic(null);
    lastGap.current = gapId;
    setDrill({ topicId, gapId });
    try {
      const { jobId } = await invoke("study.gapDrillStart", {
        planId,
        topicId,
        ...(gapId ? { gapId } : {}),
      });
      if (stoppedStart.current >= mine) {
        const later = latestStart.current > mine ? latestDrill.current : null;
        if (cancelsStoppedStart({ topicId, gapId }, later)) void invoke("jobs.cancel", { jobId }).catch(() => undefined);
        return;
      }
      // Only the drill this start made: the student may have asked for another one, or dismissed it, in the meantime.
      setDrill((current) => (current && current.topicId === topicId && current.gapId === gapId ? { ...current, jobId } : current));
      await client.invalidateQueries({ queryKey: ["gap-drill", planId] });
    } catch {
      // A start the student stopped, or one a later start replaced, has nothing to say.
      if (mine !== latestStart.current || stoppedStart.current >= mine) return;
      setDrill(null);
      setFailedTopic(topicId);
    }
  }

  useEffect(() => {
    const request = readDrillRequest(requestedDrill, startedDrill.current);
    startedDrill.current = request.started;
    if (!request.begin) return;
    // The address is cleaned only while this page is the one the router shows: this effect can run after the student
    // has moved on, and the cleanup would then replace that page's address.
    if (stillHere())
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
      if (stopped) void start(stopped, lastGap.current);
    },
    /** Stops the drill being prepared, so the page that asked for it is as it was; its job is stopped and can be resumed from Attività. */
    stop: () => {
      stoppedStart.current = latestStart.current;
      const jobId = drill?.jobId;
      setFailedTopic(null);
      setDrill(null);
      if (jobId) void invoke("jobs.cancel", { jobId }).catch(() => undefined);
    },
    dismiss: () => {
      setFailedTopic(null);
      setDrill(null);
    },
  };
}
