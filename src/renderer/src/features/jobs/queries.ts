import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { invoke, onBroadcast } from "../../lib/ipc";

export function useJobs() {
  return useQuery({
    queryKey: ["jobs"],
    queryFn: () => invoke("jobs.list", {}),
  });
}

export function JobsSync() {
  const client = useQueryClient();
  useEffect(() => {
    const offJob = onBroadcast("job.updated", () => {
      void client.invalidateQueries({ queryKey: ["plans"] });
      void client.invalidateQueries({ queryKey: ["plan"] });
      void client.invalidateQueries({ queryKey: ["series"], refetchType: "none" });
      void client.invalidateQueries({ queryKey: ["plan-build"] });
      void client.invalidateQueries({ queryKey: ["sources"] });
      void client.invalidateQueries({ queryKey: ["source-chapters"] });
      void client.invalidateQueries({ queryKey: ["source-meta"] });
      void client.invalidateQueries({ queryKey: ["embedding"] });
      void client.invalidateQueries({ queryKey: ["ocr-data"] });
      void client.invalidateQueries({ queryKey: ["jobs"] });
    });
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
      offEvidence();
      offPort();
    };
  }, [client]);
  return null;
}
