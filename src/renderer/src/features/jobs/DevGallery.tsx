import { Button } from "antd";
import { useMutation } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Navigate } from "react-router";
import { invoke } from "../../lib/ipc";

export function DevGallery() {
  const { t } = useTranslation();
  if (!window.pyxis.dev) return <Navigate to="/exams" replace />;
  const start = useMutation({
    mutationFn: (failOnce: boolean) => invoke("jobs.startDemo", { failOnce }),
  });
  return (
    <div className="empty">
      <p className="label">{t("dev.kicker")}</p>
      <h1 className="title-2">{t("dev.title")}</h1>
      <p className="body">{t("dev.body")}</p>
      <div className="empty-actions">
        <Button
          type="primary"
          shape="round"
          onClick={() => start.mutate(false)}
        >
          {t("dev.start")}
        </Button>
        <Button shape="round" onClick={() => start.mutate(true)}>
          {t("dev.fail")}
        </Button>
        <Button shape="round" onClick={() => void window.pyxis.killCore()}>
          {t("dev.kill")}
        </Button>
      </div>
    </div>
  );
}
