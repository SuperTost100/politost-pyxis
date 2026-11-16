import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { ControlList, SwitchRow } from "../../components/Controls";
import { invoke } from "../../lib/ipc";

/** Debug mode is read by Settings and by Attività, which shows each job's technical details while it is on. */
export const debugQuery = {
  queryKey: ["debug"],
  queryFn: () => invoke("debug.get", {}),
} as const;

/**
 * "Show technical details and debug", in AI tools, Advanced. While it is on, Pyxis keeps a log of each job's AI calls
 * on this computer, and Attività shows it under the job.
 */
export function DebugSwitch() {
  const { t } = useTranslation();
  const client = useQueryClient();
  const debug = useQuery(debugQuery);
  const save = useMutation({
    mutationFn: (on: boolean) => invoke("debug.set", { on }),
    onSuccess: (saved) => client.setQueryData(debugQuery.queryKey, saved),
  });
  const checked = save.isPending ? save.variables === true : debug.data?.on === true;
  return (
    <ControlList>
      <SwitchRow
        title={t("engines.debug")}
        description={t("engines.debugHint")}
        checked={checked}
        disabled={debug.isPending || save.isPending}
        onChange={(on) => save.mutate(on)}
        below={
          save.isError ? (
            <p className="small engines-warning engines-debug-failed" role="alert">
              {t("engines.debugFailed")}
            </p>
          ) : null
        }
      />
    </ControlList>
  );
}
