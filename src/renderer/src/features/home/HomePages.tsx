import { Button, Segmented } from "antd";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router";
import { EmptyState } from "../../app/layouts/TaskLayouts";
import { LibraryPanel } from "./LibraryPanel";

export function ExamsHome() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const tab = location.pathname.startsWith("/exams/library")
    ? "sources"
    : "plans";
  return (
    <div>
      <div className="tabs-row">
        <Segmented
          shape="round"
          className="px-doors"
          value={tab}
          onChange={(value) =>
            navigate(value === "sources" ? "/exams/library" : "/exams")
          }
          options={[
            { value: "plans", label: t("exams.plans") },
            { value: "sources", label: t("exams.sources") },
          ]}
        />
      </div>
      {tab === "plans" ? (
        <EmptyState
          title={t("exams.emptyTitle")}
          body={t("exams.emptyBody")}
          action={
            <Button
              type="primary"
              shape="round"
              size="large"
              onClick={() => navigate("/plans/new")}
            >
              {t("exams.newPlan")}
            </Button>
          }
          secondary={
            <Button
              type="text"
              shape="round"
              className="linkish"
              onClick={() => navigate("/exams/get")}
            >
              {t("exams.openShared")}
            </Button>
          }
        />
      ) : (
        <LibraryPanel />
      )}
    </div>
  );
}
