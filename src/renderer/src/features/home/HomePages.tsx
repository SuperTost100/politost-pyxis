import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Button, Input, Modal, Segmented, Select } from "antd";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router";
import { EmptyState } from "../../app/layouts/TaskLayouts";
import { invoke } from "../../lib/ipc";
import { LibraryPanel } from "./LibraryPanel";
import { PlanCard } from "../../components/PlanCard";
import { Notice } from "../../components/Notice";
import type { PlanFile } from "@shared/plan-file";
import { ImportReview } from "../plans/ImportReview";
import { parsePlanText } from "../plans/importPreview";

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
  const subjects = [
    ...new Set(
      (plans.data ?? []).map((plan) => plan.subject).filter((name) => name),
    ),
  ];
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
            <Button
              type="primary"
              shape="round"
              onClick={() => navigate("/plans/new")}
            >
              {t("exams.newPlan")}
            </Button>
            <ImportPlan
              label={t("exams.importPlan")}
              onImported={() =>
                void client.invalidateQueries({ queryKey: ["plans"] })
              }
            />
            <Button
              type="text"
              shape="round"
              onClick={() => navigate("/exams/get")}
            >
              {t("exams.openShared")}
            </Button>
          </div>
          <div className="px-form-grid">
            <div className="px-form-field">
              <label className="label" htmlFor="plan-search">
                {t("exams.search")}
              </label>
              <Input
                id="plan-search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
            <div className="px-form-field">
              <label className="label" htmlFor="plan-subject-filter">
                {t("exams.subject")}
              </label>
              <Select
                id="plan-subject-filter"
                aria-label={t("exams.subject")}
                value={subject}
                onChange={setSubject}
                options={[
                  { value: "", label: t("exams.allSubjects") },
                  ...subjects.map((name) => ({
                    value: name ?? "",
                    label: name ?? "",
                  })),
                ]}
              />
            </div>
          </div>
          {shown.length === 0 ? (
            <p className="body">{t("exams.noMatch")}</p>
          ) : null}
          <ul className="px-plan-grid">
            {shown.map((plan) => (
              <li key={plan.id}>
                <PlanCard
                  title={plan.title}
                  subject={plan.subject ?? undefined}
                  mastery={plan.mastery * 100}
                  target={plan.target * 100}
                  importedLabel={
                    plan.imported ? t("exams.imported") : undefined
                  }
                  cta={t("onboarding.continue")}
                  continueLabel={t("exams.continuePlan", { title: plan.title })}
                  meta={[
                    plan.daysToExam == null
                      ? null
                      : plan.daysToExam < 0
                        ? t("exams.pastExam")
                        : t("exams.days", { count: plan.daysToExam }),
                    t("exams.aligned", {
                      count: plan.alignedTopics,
                      total: plan.totalTopics,
                    }),
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                  onContinue={() => navigate(`/plans/${plan.id}`)}
                />
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
  const { t } = useTranslation();
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [review, setReview] = useState<PlanFile | null>(null);
  return (
    <>
      <input
        ref={fileRef}
        type="file"
        accept="application/json,.json,.pyxis"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          // Reset so choosing the same file again still fires after an error or cancel.
          event.currentTarget.value = "";
          if (!file) return;
          setFailed(false);
          setReview(null);
          setBusy(true);
          void file
            .text()
            .then((text) => {
              const parsed = parsePlanText(text);
              if (parsed) setReview(parsed);
              else setFailed(true);
            })
            .catch(() => setFailed(true))
            .finally(() => setBusy(false));
        }}
      />
      <Button
        shape="round"
        disabled={busy}
        onClick={() => fileRef.current?.click()}
      >
        {props.label}
      </Button>
      {failed && <Notice tone="danger">{t("shared.importFailed")}</Notice>}
      <Modal
        open={review !== null}
        footer={null}
        width={720}
        maskClosable={false}
        destroyOnHidden
        title={t("shared.review.title")}
        onCancel={() => setReview(null)}
      >
        {review ? (
          <ImportReview
            file={review}
            onImport={async (request) => {
              await invoke("plans.import", request);
              setReview(null);
              props.onImported();
            }}
            onCancel={() => setReview(null)}
          />
        ) : null}
      </Modal>
    </>
  );
}
