import { Button, Segmented } from "antd";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router";
import { EmptyState } from "../../app/layouts/TaskLayouts";

export function AskHome() {
  const { t } = useTranslation();
  return (
    <div className="ask-home">
      <div className="ask-greeting">
        <h1 className="display">{t("ask.greeting")}</h1>
        <p className="body">{t("ask.scopeEmpty")}</p>
      </div>
      <form
        className="composer"
        onSubmit={(event) => {
          event.preventDefault();
        }}
      >
        <label className="visually-hidden" htmlFor="ask-composer">
          {t("ask.placeholder")}
        </label>
        <textarea
          id="ask-composer"
          rows={2}
          placeholder={t("ask.placeholder")}
        />
      </form>
    </div>
  );
}

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
        <EmptyState
          title={t("exams.sourcesEmptyTitle")}
          body={t("exams.sourcesEmptyBody")}
        />
      )}
    </div>
  );
}
