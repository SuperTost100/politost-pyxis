import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import type { EngineProvider } from "@shared/limits";
import { invoke, onBroadcast } from "../../lib/ipc";
import {
  engineChoiceQuery,
  engineFeaturesQuery,
  enginesQuery,
} from "../../lib/queries";

/**
 * The engines Pyxis found, the ones the student lets it use and the model each task uses, for the screens that set them
 * up: first setup and Settings. The list is read again when the window comes back into focus (a CLI installed
 * meanwhile) and when a provider refuses a sign-in, and the choices when core recomputes them (startup, a sign-in, a
 * confirmed notice). `refresh` reads all of them again.
 */
export function useEngineSetup() {
  const client = useQueryClient();
  const overview = useQuery({ ...enginesQuery, refetchOnWindowFocus: true });
  const features = useQuery(engineFeaturesQuery);
  const choice = useQuery(engineChoiceQuery);
  useEffect(() => {
    const offAuto = onBroadcast("engine.auto", () => {
      void client.invalidateQueries({ queryKey: engineFeaturesQuery.queryKey });
    });
    const offStatus = onBroadcast("engine.status", () => {
      void client.invalidateQueries({ queryKey: enginesQuery.queryKey });
    });
    return () => {
      offAuto();
      offStatus();
    };
  }, [client]);
  function refresh() {
    for (const { queryKey } of [enginesQuery, engineFeaturesQuery, engineChoiceQuery])
      void client.invalidateQueries({ queryKey });
  }
  /** Saves which engines Pyxis may use, or null for automatic. Core then plans again without the others. */
  const choose = useMutation({
    mutationFn: (allowed: string[] | null) =>
      invoke("engines.choose", {
        allowed: allowed as EngineProvider[] | null,
      }),
    onMutate: (allowed) => {
      client.setQueryData(engineChoiceQuery.queryKey, { allowed });
    },
    onSettled: refresh,
  });
  return { overview, features, choice, choose, refresh };
}
