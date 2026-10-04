import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Notice } from "../components/Notice";

export function CoreNotice() {
  const { t } = useTranslation();
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => window.pyxis.onCoreUnavailable(setUnavailable), []);

  useEffect(() => window.pyxis.onCoreRestarted(() => setOpen(true)), []);

  if (!open && !unavailable) return null;
  return (
    <div className="core-notice">
      <Notice
        tone="warning"
        action={{
          label: t("errors.retry"),
          onClick: () => {
            setOpen(false);
            if (unavailable)
              void window.pyxis
                .retryCore()
                .then(() => client.invalidateQueries());
            else void client.invalidateQueries();
          },
        }}
      >
        {t(unavailable ? "errors.coreUnavailable" : "errors.coreRestarted")}
      </Notice>
    </div>
  );
}
