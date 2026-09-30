import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
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
  const [query, setQuery] = useState("");
  const [subject, setSubject] = useState("");
  const tab = location.pathname.startsWith("/exams/library")
    ? "sources"
    : "plans";
  const subjects = [...new Set((plans.data ?? []).map((plan) => plan.subject).filter((name) => name))];
  const shown = (plans.data ?? []).filter((plan) => {
    const title = plan.title.toLocaleLowerCase();
    const needle = query.trim().toLocaleLowerCase();
    if (needle && !title.includes(needle)) return false;
    if (subject && plan.subject !== subject) return false;
    return true;
  });
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
          <label className="label" htmlFor="plan-search">
            {t("exams.search")}
          </label>
          <input
            id="plan-search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <label className="label" htmlFor="plan-subject-filter">
            {t("exams.subject")}
          </label>
          <select
            id="plan-subject-filter"
            value={subject}
            onChange={(event) => setSubject(event.target.value)}
          >
            <option value="">{t("exams.allSubjects")}</option>
            {subjects.map((name) => (
              <option key={name} value={name ?? ""}>
                {name}
              </option>
            ))}
          </select>
          {shown.length === 0 ? <p className="body">{t("exams.noMatch")}</p> : null}
          <ul className="choice-list">
            {shown.map((plan) => (
              <li key={plan.id}>
                <button
                  type="button"
                  className="choice"
                  onClick={() => navigate(`/plans/${plan.id}`)}
                >
                  <span className="body-strong">{plan.title}</span>
                  <span className="small">
                    {[
                      plan.subject,
                      plan.daysToExam == null ? null : t("exams.days", { days: plan.daysToExam }),
                      t("exams.mastery", { percent: Math.round(plan.mastery * 100) }),
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
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
