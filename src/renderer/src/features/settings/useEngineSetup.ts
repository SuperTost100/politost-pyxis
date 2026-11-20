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
 * meanwhile), when a provider refuses a sign-in, when core recomputes the choices (startup, a sign-in, a confirmed
 * notice) and every `OVERVIEW_REFRESH_MS` while the screen is open and visible: a student who signs a tool in or out in a
 * terminal, or whose read overlapped a change, sees the new state without a click or a reload, because core sends no
 * broadcast for a change it was not asked to look at. `refresh` reads all of them again. A tool that runs out of
 * requests, or has them again, changes its row the same way as a sign-in does (`engine.status`).
 */
export const OVERVIEW_REFRESH_MS = 15_000;

export function useEngineSetup() {
  const client = useQueryClient();
  const overview = useQuery({ ...enginesQuery, refetchOnWindowFocus: true, refetchInterval: OVERVIEW_REFRESH_MS });
  const features = useQuery(engineFeaturesQuery);
  const choice = useQuery(engineChoiceQuery);
  useEffect(() => {
    // The plan was made again, which a scan that found another set of tools does: the list and the choices follow.
    const offAuto = onBroadcast("engine.auto", () => {
      for (const { queryKey } of [enginesQuery, engineFeaturesQuery, engineChoiceQuery])
        void client.invalidateQueries({ queryKey });
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
