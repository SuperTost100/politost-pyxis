import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import type { JobView } from "@shared/ipc";
import { invoke, onBroadcast } from "../../lib/ipc";

const active = new Set(["queued", "running", "failed", "interrupted"]);

export function useJobs() {
  return useQuery({
    queryKey: ["jobs"],
    queryFn: () => invoke("jobs.list", {}),
  });
}

export function JobsSync() {
  const client = useQueryClient();
  useEffect(() => {
    const offJob = onBroadcast("job.updated", (job) => {
      client.setQueryData<JobView[]>(["jobs"], (current = []) => {
        const rest = current.filter((item) => item.id !== job.id);
        if (!active.has(job.state)) return rest;
        return [...rest, job];
      });
    });
    const offPort = window.pyxis.onPort(() => {
      void client.invalidateQueries({ queryKey: ["jobs"] });
    });
    return () => {
      offJob();
      offPort();
    };
  }, [client]);
  return null;
}
