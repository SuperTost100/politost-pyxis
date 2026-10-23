import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "../../lib/ipc";
import { cacheShare, formatTokens } from "../../lib/tokens";
import { startOfWeek } from "../../../../shared/local-day";
import "./EngineUsage.css";

/** Tokens each engine used this week, so a student on a capped plan can see what Pyxis costs them. */
export function EngineUsage() {
  const { t, i18n } = useTranslation();
  const [since] = useState(() => startOfWeek(Date.now()));
  const usage = useQuery({
    queryKey: ["engines", "usage", since],
    queryFn: () => invoke("engines.usage", { since }),
  });
  if (!usage.data) return null;
  const rows = usage.data;
  const number = (count: number) => formatTokens(count, i18n.language);
  const total = rows.reduce(
    (sum, row) => ({
      inputTokens: sum.inputTokens + row.inputTokens,
      cacheReadTokens: sum.cacheReadTokens + row.cacheReadTokens,
    }),
    { inputTokens: 0, cacheReadTokens: 0 },
  );
  const saved = cacheShare(total);
  return (
    <section className="engines-usage" aria-labelledby="engines-usage-title">
      <h2 className="title-3" id="engines-usage-title">
        {t("engines.usage.title")}
      </h2>
      <p className="small engines-hint">{t("engines.usage.hint")}</p>
      {rows.length === 0 ? (
        <p className="small engines-usage-empty">{t("engines.usage.empty")}</p>
      ) : (
        <div className="engines-usage-scroll">
          <table className="engines-usage-table">
            <thead>
              <tr>
                <th scope="col">{t("engines.usage.engine")}</th>
                <th scope="col">{t("engines.usage.sent")}</th>
                <th scope="col">{t("engines.usage.received")}</th>
                <th scope="col">{t("engines.usage.cached")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const share = cacheShare(row);
                return (
                  <tr key={row.provider}>
                    <th scope="row">{row.name}</th>
                    <td>{number(row.inputTokens)}</td>
                    <td>{number(row.outputTokens)}</td>
                    <td>
                      {share === null
                        ? number(row.cacheReadTokens)
                        : t("engines.usage.cachedValue", {
                            count: number(row.cacheReadTokens),
                            percent: share,
                          })}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {saved !== null ? (
        <p className="small engines-hint">
          {t("engines.usage.cacheSaving", { percent: saved })}
        </p>
      ) : null}
    </section>
  );
}
