import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import type { InstallableProvider } from "@shared/installers";
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
 * confirmed notice). `refresh` reads all of them again. A tool that runs out of requests, or has them again, changes
 * its row the same way as a sign-in does (`engine.status`).
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
      client.setQueryData(engineChoiceQuery.queryKey, (old) => ({ order: old?.order ?? null, allowed }));
    },
    onSettled: refresh,
  });
  /**
   * Saves the order of the student's tools, or null to let Pyxis share the work among them again. The list shows the
   * new order at once; a save that fails reads the stored one back.
   */
  const reorder = useMutation({
    mutationFn: (order: string[] | null) =>
      invoke("engines.reorder", { order: order as InstallableProvider[] | null }),
    onMutate: (order) => {
      client.setQueryData(engineChoiceQuery.queryKey, (old) => ({ allowed: old?.allowed ?? null, order }));
    },
    onSettled: refresh,
  });
  return { overview, features, choice, choose, reorder, refresh };
}
