import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { onBroadcast } from "../../lib/ipc";
import { engineFeaturesQuery, enginesQuery } from "../../lib/queries";

/**
 * The engines Pyxis found and the model each task uses, for the screens that set them up: first setup and Settings.
 * The list is read again when the window comes back into focus (a CLI installed meanwhile), and the choices when core
 * recomputes them (startup, a sign-in, a confirmed notice). `refresh` reads both again.
 */
export function useEngineSetup() {
  const client = useQueryClient();
  const overview = useQuery({ ...enginesQuery, refetchOnWindowFocus: true });
  const features = useQuery(engineFeaturesQuery);
  useEffect(
    () =>
      onBroadcast("engine.auto", () => {
        void client.invalidateQueries({ queryKey: engineFeaturesQuery.queryKey });
      }),
    [client],
  );
  function refresh() {
    for (const { queryKey } of [enginesQuery, engineFeaturesQuery])
      void client.invalidateQueries({ queryKey });
  }
  return { overview, features, refresh };
}
