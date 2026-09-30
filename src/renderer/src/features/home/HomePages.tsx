import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef } from "react";
import { Button, Segmented } from "antd";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router";
import { EmptyState } from "../../app/layouts/TaskLayouts";
import { invoke } from "../../lib/ipc";
import { LibraryPanel } from "./LibraryPanel";
import { planFileSchema } from "@shared/plan-file";

export function ExamsHome() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const client = useQueryClient();
  const plans = useQuery({
    queryKey: ["plans"],
    queryFn: () => invoke("plans.list", {}),
  });
  const tab = location.pathname.startsWith("/exams/library")
    ? "sources"
    : "plans";
  return (
    <div>
      <h1 className="title-1">{t("doors.exams")}</h1>
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
      {tab === "sources" ? (
        <LibraryPanel />
      ) : (plans.data?.length ?? 0) > 0 ? (
        <div>
          <div className="gallery-row">
            <Button type="primary" shape="round" onClick={() => navigate("/plans/new")}>
              {t("exams.newPlan")}
            </Button>
            <ImportPlan
              label={t("exams.importPlan")}
              onImported={() => void client.invalidateQueries({ queryKey: ["plans"] })}
            />
            <Button type="text" shape="round" onClick={() => navigate("/exams/get")}>
              {t("exams.openShared")}
            </Button>
          </div>
          <ul className="choice-list">
            {(plans.data ?? []).map((plan) => (
              <li key={plan.id}>
                <button
                  type="button"
                  className="choice"
                  onClick={() => navigate(`/plans/${plan.id}`)}
                >
                  <span className="body-strong">{plan.title}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : (
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
      )}
    </div>
  );
}

function ImportPlan(props: { label: string; onImported: () => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={fileRef}
        type="file"
        accept="application/json,.json"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (!file) return;
          void file.text().then(async (text) => {
            try {
              const parsed = planFileSchema.safeParse(JSON.parse(text));
              if (!parsed.success) return;
              await invoke("plans.import", parsed.data);
              props.onImported();
            } catch {
              return;
            }
          });
        }}
      />
      <Button shape="round" onClick={() => fileRef.current?.click()}>
        {props.label}
      </Button>
    </>
  );
}
