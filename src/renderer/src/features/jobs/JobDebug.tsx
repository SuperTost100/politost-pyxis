import { useQuery } from "@tanstack/react-query";
import { App } from "antd";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/Button";
import { invoke } from "../../lib/ipc";
import { useEngineNames } from "../../lib/useEngineNames";
import { debugQuery } from "../settings/DebugSwitch";

/**
 * Debug mode's details under a job in Attività: each AI call with its AI, model, access and time, then the request, the
 * reply and the engine's events. "Copy log" copies the masked log, "Open log" shows its file. Hidden while debug mode
 * is off. The log is read only once the details are opened, and again every second while the job runs.
 */
export function JobDebug({ jobId, running }: { jobId: string; running: boolean }) {
  const { t, i18n } = useTranslation();
  const { message } = App.useApp();
  const names = useEngineNames();
  const debug = useQuery(debugQuery);
  const [open, setOpen] = useState(false);
  const log = useQuery({
    queryKey: ["jobs", "log", jobId],
    queryFn: () => invoke("jobs.log", { jobId }),
    enabled: open && debug.data?.on === true,
    refetchInterval: running ? 1000 : false,
  });
  if (debug.data?.on !== true) return null;
  const seconds = new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 1 });
  const data = log.data;
  return (
    <details className="px-jobs-debug" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>{t("jobs.debug.title")}</summary>
      {log.isPending && open ? <p className="px-jobs-sub">{t("jobs.debug.loading")}</p> : null}
      {log.isError ? <p className="px-jobs-sub">{t("jobs.debug.failed")}</p> : null}
      {log.isSuccess && !data ? <p className="px-jobs-sub">{t("jobs.debug.none")}</p> : null}
      {data ? (
        <>
          <ol className="px-jobs-calls">
            {data.calls.map((call) => (
              <li key={call.id}>
                <p className="px-jobs-call-head">
                  <span className="body-strong">{names.label(call.provider, call.model)}</span>
                  {" · "}
                  {t(`jobs.debug.access.${call.access}`)}
                  {" · "}
                  {call.ms === null
                    ? t("jobs.debug.running")
                    : t("jobs.debug.seconds", { value: seconds.format(call.ms / 1000) })}
                </p>
                {call.error ? <p className="px-jobs-call-error">{call.error}</p> : null}
                <details>
                  <summary>{t("jobs.debug.request")}</summary>
                  <pre className="code" tabIndex={0}>
                    {call.system ? `${call.system}\n\n---\n\n${call.prompt}` : call.prompt}
                  </pre>
                </details>
                {call.text !== null ? (
                  <details>
                    <summary>{t("jobs.debug.reply")}</summary>
                    <pre className="code" tabIndex={0}>
                      {call.text}
                    </pre>
                  </details>
                ) : null}
                {call.eventCount > 0 ? (
                  <details>
                    <summary>{t("jobs.debug.events", { count: call.eventCount })}</summary>
                    <pre className="code" tabIndex={0}>
                      {call.events.map((item) => JSON.stringify(item.event)).join("\n")}
                      {call.eventCount > call.events.length
                        ? `\n${t("jobs.debug.moreEvents", { count: call.eventCount - call.events.length })}`
                        : ""}
                    </pre>
                  </details>
                ) : null}
              </li>
            ))}
          </ol>
          {data.capped ? <p className="px-jobs-sub">{t("jobs.debug.capped")}</p> : null}
          <div className="px-jobs-acts">
            <Button
              size="sm"
              variant="secondary"
              onClick={() =>
                void navigator.clipboard.writeText(data.text).then(
                  () => void message.success(t("jobs.debug.copied")),
                  () => void message.error(t("jobs.debug.copyFailed")),
                )
              }
            >
              {t("jobs.debug.copy")}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void window.pyxis.revealJobLog(jobId)}>
              {t("jobs.debug.open")}
            </Button>
          </div>
        </>
      ) : null}
    </details>
  );
}
