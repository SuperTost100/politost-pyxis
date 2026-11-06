import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Switch } from "antd";
import { useId } from "react";
import { useTranslation } from "react-i18next";
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
  const id = useId();
  const client = useQueryClient();
  const debug = useQuery(debugQuery);
  const save = useMutation({
    mutationFn: (on: boolean) => invoke("debug.set", { on }),
    onSuccess: (saved) => client.setQueryData(debugQuery.queryKey, saved),
  });
  const checked = save.isPending ? save.variables === true : debug.data?.on === true;
  return (
    <div className="px-card px-crash-row engines-debug">
      <div className="px-crash-text">
        <label className="body-strong" htmlFor={id}>
          {t("engines.debug")}
        </label>
        <p className="small" id={`${id}-hint`}>
          {t("engines.debugHint")}
        </p>
        {save.isError ? (
          <p className="small engines-warning" role="alert">
            {t("engines.debugFailed")}
          </p>
        ) : null}
      </div>
      <Switch
        id={id}
        checked={checked}
        disabled={debug.isPending || save.isPending}
        aria-describedby={`${id}-hint`}
        onChange={(on) => save.mutate(on)}
      />
    </div>
  );
}
