import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { invoke, onBroadcast } from "../../lib/ipc";
import { staleBatcher, staleFamilies } from "./jobInvalidation";

export function useJobs() {
  return useQuery({
    queryKey: ["jobs"],
    queryFn: () => invoke("jobs.list", {}),
  });
}

/** Jobs that finished today and were not cleared, for the jobs list. */
export function useFinishedJobs() {
  return useQuery({
    queryKey: ["jobs-finished"],
    queryFn: () => invoke("jobs.finished", {}),
  });
}

export function JobsSync() {
  const client = useQueryClient();
  useEffect(() => {
    // A build or an import sends an update at the start and end of every step; refetch only what that job changes,
    // and once per burst.
    const stale = staleBatcher((families) => {
      for (const { key, refetch } of families)
        void client.invalidateQueries({
          queryKey: [key],
          refetchType: refetch ? "active" : "none",
        });
    });
    const offJob = onBroadcast("job.updated", (job) => stale.add(staleFamilies(job)));
    // A study write changed mastery: the next visit to an exam list, plan or Progress tab reads it again.
    const offEvidence = onBroadcast("plans.evidence", () => {
      for (const key of ["plans", "plan", "series"])
        void client.invalidateQueries({ queryKey: [key], refetchType: "none" });
    });
    const offPort = window.pyxis.onPort(() => {
      void client.invalidateQueries({ queryKey: ["jobs"] });
    });
    return () => {
      offJob();
      stale.cancel();
      offEvidence();
      offPort();
    };
  }, [client]);
  return null;
}
