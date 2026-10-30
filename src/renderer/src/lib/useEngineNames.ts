import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { engineLabel, engineModelsLine, engineName, modelName } from "./engineNames";
import { invoke, onBroadcast } from "./ipc";

/** The names core has read so far. Core answers from memory, so any screen may ask. */
export const engineNamesQuery = {
  queryKey: ["engine-names"],
  queryFn: () => invoke("engines.names", {}),
};

/**
 * The names for screens that show which engine and model did something. They are read again whenever core learns new
 * model names (`engine.names`, `engine.auto`), so a name replaces the readable id as soon as core knows it.
 */
export function useEngineNames() {
  const { t } = useTranslation();
  const client = useQueryClient();
  const names = useQuery(engineNamesQuery).data;
  useEffect(() => {
    const reload = () => {
      void client.invalidateQueries({ queryKey: engineNamesQuery.queryKey });
    };
    // `engine.names` comes after a test or a model listing; `engine.auto` after the automatic choice read the lists.
    const offNames = onBroadcast("engine.names", reload);
    const offAuto = onBroadcast("engine.auto", reload);
    return () => {
      offNames();
      offAuto();
    };
  }, [client]);
  return {
    engineName: (provider: string) => engineName(names, provider),
    modelName: (provider: string | null | undefined, model: string) =>
      modelName(names, provider, model),
    label: (provider: string | null | undefined, model: string | null | undefined) =>
      engineLabel(names, provider, model),
    /** The line under an engine's name in setup and Settings; see `engineModelsLine`. */
    modelsLine: (
      provider: string,
      features: Record<string, { provider: string; model: string }> | undefined,
      refused: readonly string[] = [],
      allowed = true,
    ) =>
      engineModelsLine({
        names,
        provider,
        features,
        refused,
        allowed,
        notIncluded: (count, models) => t("engines.notIncluded", { count, models }),
      }),
  };
}
