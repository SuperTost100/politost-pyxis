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
      void client.invalidateQueries({ queryKey: ["plan-build"] });
      void client.invalidateQueries({ queryKey: ["sources"] });
      void client.invalidateQueries({ queryKey: ["source-chapters"] });
      void client.invalidateQueries({ queryKey: ["source-meta"] });
      void client.invalidateQueries({ queryKey: ["embedding"] });
      void client.invalidateQueries({ queryKey: ["jobs"] });
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
