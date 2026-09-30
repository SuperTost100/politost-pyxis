import { Button } from "antd";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { CanvasLayout, FocusLayout } from "../../app/layouts/TaskLayouts";

export function WizardFrame() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  return (
    <FocusLayout
      title={t("wizard.title")}
      secondary={
        <Button type="text" shape="round" onClick={() => navigate("/exams")}>
          {t("nav.back")}
        </Button>
      }
    >
      <p className="body ink-muted">{t("wizard.body")}</p>
    </FocusLayout>
  );
}

export function SharedPlanPage() {
  const { t } = useTranslation();
  return (
    <div>
      <h1 className="title-1">{t("shared.title")}</h1>
      <p className="body ink-muted">{t("shared.body")}</p>
    </div>
  );
}

export function WhiteboardFrame() {
  const { t } = useTranslation();
  return (
    <CanvasLayout title={t("tools.whiteboardTitle")}>
      <p className="body ink-muted" style={{ padding: 24 }}>
        {t("tools.whiteboardBody")}
      </p>
    </CanvasLayout>
  );
}
