import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Notice } from "../components/Notice";

export function CoreNotice() {
  const { t } = useTranslation();
  const client = useQueryClient();
  const [open, setOpen] = useState(false);

  useEffect(() => window.pyxis.onCoreRestarted(() => setOpen(true)), []);

  if (!open) return null;
  return (
    <div className="core-notice">
      <Notice
        tone="warning"
        action={{
          label: t("errors.retry"),
          onClick: () => {
            setOpen(false);
            void client.invalidateQueries();
          },
        }}
      >
        {t("errors.coreRestarted")}
      </Notice>
    </div>
  );
}
