import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { engineChoiceQuery, enginesQuery } from "../../lib/queries";
import { callAfter, limitsOf, nextTool } from "../../lib/toolOrder";

/**
 * The tools as the jobs list needs them: which are out of requests and until when, and the tools a stopped job can go
 * on with. Read again when a tool runs out of requests or gets them back (`engine.status`, which JobsSync turns into a
 * new read), and when the soonest limit ends.
 */
export function useToolLimits() {
  const client = useQueryClient();
  const overview = useQuery(enginesQuery);
  const choice = useQuery(engineChoiceQuery);
  const [now, setNow] = useState(() => Date.now());
  const rows = overview.data;
  const limits = useMemo(() => limitsOf(rows ?? [], now), [rows, now]);
  const soonest = Math.min(...limits.values());
  useEffect(() => {
    if (!Number.isFinite(soonest)) return;
    // A wait longer than a timer holds (about 24 days) is made in stretches by `callAfter`.
    return callAfter(soonest, () => {
      setNow(Date.now());
      void client.invalidateQueries({ queryKey: enginesQuery.queryKey });
    });
  }, [soonest, client]);
  return {
    limits,
    rows: rows ?? [],
    next: (failed: string | undefined) => nextTool(rows ?? [], choice.data?.order ?? null, failed, now),
  };
}

export type ToolLimits = ReturnType<typeof useToolLimits>;
