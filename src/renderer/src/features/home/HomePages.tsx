import { useQuery, useQueryClient } from "@tanstack/react-query";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { Button, Modal, Segmented, Select } from "antd";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router";
import { EmptyState } from "../../app/layouts/TaskLayouts";
import { invoke } from "../../lib/ipc";
import { searchMatcher } from "../../lib/search";
import { LibraryPanel } from "./LibraryPanel";
import { PlanCard } from "../../components/PlanCard";
import { Notice } from "../../components/Notice";
import {
  ListToolbar,
  ToolbarMenu,
  ToolbarSearch,
} from "../../components/ListToolbar";
import type { PlanFile } from "@shared/plan-file";
import { ImportReview } from "../plans/ImportReview";
import { parsePlanText } from "../plans/importPreview";
import { examDaysLabel } from "../plans/examDays";
import { OggiBlock } from "./OggiBlock";
import "./HomePages.css";

// Cards and mistakes render Markdown and math, which load with their tab rather than with the window.
const CardBrowser = lazy(() =>
  import("./CardBrowser").then((module) => ({ default: module.CardBrowser })),
);
const MistakesNotebook = lazy(() =>
  import("../study/MistakesNotebook").then((module) => ({
    default: module.MistakesNotebook,
  })),
);
// The subject list's drag and drop loads the first time the student opens it.
const SubjectManagerModal = lazy(() =>
  import("../ask/SubjectPicker").then((module) => ({
    default: module.SubjectManagerModal,
  })),
);

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
  const [picked, setSubject] = useState("");
  const [shownStatus, setStatus] = useState<"active" | "archived">("active");
  const [managing, setManaging] = useState(false);
  // Stays mounted after the first open, so the dialog can animate closed.
  const [managerOpened, setManagerOpened] = useState(false);
  const [failed, setFailed] = useState(false);
  const tab = location.pathname.startsWith("/exams/library")
    ? "sources"
    : location.pathname.startsWith("/exams/cards")
      ? "cards"
      : location.pathname.startsWith("/exams/mistakes")
        ? "mistakes"
        : "plans";
  // The notice belongs to the tab the import ran on; it is gone once the student moves to another.
  useEffect(() => setFailed(false), [tab]);
  const subjects = [
    ...new Set(
      (plans.data ?? []).map((plan) => plan.subject).filter((name) => name),
    ),
  ];
  // A renamed or removed subject can no longer filter.
  const subject = subjects.includes(picked) ? picked : "";
  // The filter appears with the first archived exam, and falls back to Active when the last one is restored.
  const hasArchived = (plans.data ?? []).some((plan) => plan.archived);
  const status = hasArchived ? shownStatus : "active";
  const queryMatches = searchMatcher(query);
  const shown = (plans.data ?? []).filter((plan) => {
    if (plan.archived !== (status === "archived")) return false;
    if (!queryMatches(`${plan.title} ${plan.subject ?? ""}`)) return false;
    if (subject && plan.subject !== subject) return false;
    return true;
  });
  const planImport = usePlanImport(
    setFailed,
    () => void client.invalidateQueries({ queryKey: ["plans"] }),
  );
  // Importing and the subject list sit in one secondary menu, the same with plans and without.
  const moreMenu = (
    <ToolbarMenu
      label={t("listToolbar.more")}
      disabled={planImport.busy}
      items={[
        { key: "file", label: t("exams.importFileItem") },
        { key: "link", label: t("exams.importLinkItem") },
        { type: "divider" },
        { key: "subjects", label: t("ask.manageSubjects") },
      ]}
      onSelect={(key) => {
        if (key === "subjects") {
          setManaging(true);
          setManagerOpened(true);
        } else planImport.choose(key);
      }}
    />
  );
  const importFailed = failed ? (
    <Notice tone="danger">{t("shared.importFailed")}</Notice>
  ) : null;
  return (
    <div>
      <h1 className="title-1">{t("doors.exams")}</h1>
      <div className="tabs-row">
        <Segmented
          shape="round"
          className="px-doors"
          aria-label={t("exams.view")}
          value={tab}
          onChange={(value) =>
            navigate(
              value === "sources"
                ? "/exams/library"
                : value === "cards"
                  ? "/exams/cards"
                  : value === "mistakes"
                    ? "/exams/mistakes"
                    : "/exams",
            )
          }
          options={[
            { value: "plans", label: t("exams.plans") },
            { value: "sources", label: t("exams.sources") },
            { value: "cards", label: t("exams.cards") },
            { value: "mistakes", label: t("mistakes.title") },
          ]}
        />
      </div>
      {managerOpened ? (
        <Suspense fallback={null}>
          <SubjectManagerModal
            open={managing}
            onClose={() => setManaging(false)}
            value=""
            onChange={() => undefined}
          />
        </Suspense>
      ) : null}
      {tab === "plans" ? planImport.element : null}
      {/* Plans show nothing until the list arrives, so "No plans yet" never flashes first. */}
      {tab === "sources" ? (
        <LibraryPanel />
      ) : tab === "cards" ? (
        <Suspense fallback={null}>
          <CardBrowser />
        </Suspense>
      ) : tab === "mistakes" ? (
        <Suspense fallback={null}>
          <MistakesNotebook />
        </Suspense>
      ) : plans.isPending ? null : (plans.data?.length ?? 0) > 0 ? (
        <div className="px-exams-plans">
          <OggiBlock />
          <ListToolbar
            search={
              <ToolbarSearch
                id="plan-search"
                label={t("exams.search")}
                placeholder={t("exams.searchPlaceholder")}
                value={query}
                onChange={setQuery}
              />
            }
            filters={
              <>
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
                {/* Appears with the first archived exam; Archived is the only way back to one. */}
                {hasArchived ? (
                  <Select
                    id="plan-status-filter"
                    aria-label={t("exams.status")}
                    value={status}
                    onChange={setStatus}
                    options={[
                      { value: "active", label: t("exams.statusActive") },
                      { value: "archived", label: t("exams.statusArchived") },
                    ]}
                  />
                ) : null}
              </>
            }
            menu={moreMenu}
            primary={
              <Button
                type="primary"
                shape="round"
                onClick={() => navigate("/plans/new")}
              >
                {t("exams.newPlan")}
              </Button>
            }
          />
          {importFailed}
          {shown.length === 0 ? (
            <p className="body">
              {t(
                query.trim() || subject
                  ? "exams.noMatch"
                  : status === "archived"
                    ? "exams.noArchived"
                    : "exams.allArchived",
              )}
            </p>
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
                      : examDaysLabel(t, plan.daysToExam),
                    t("exams.aligned", {
                      ready: plan.alignedTopics,
                      count: plan.totalTopics,
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
        <>
          <EmptyState
            title={t("exams.emptyTitle")}
            body={t("exams.emptyBody")}
            action={
              <Button
                type="primary"
                shape="round"
                onClick={() => navigate("/plans/new")}
              >
                {t("exams.newPlan")}
              </Button>
            }
            secondary={moreMenu}
          />
          {importFailed}
        </>
      )}
    </div>
  );
}

/**
 * The secondary ways to add a plan: a .pyxis file picked here and reviewed before it comes in, or the
 * shared-plan page for a link. `element` holds the hidden file field and the review dialog.
 */
function usePlanImport(
  onFailed: (failed: boolean) => void,
  onImported: () => void,
) {
  const fileRef = useRef<HTMLInputElement>(null);
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [review, setReview] = useState<PlanFile | null>(null);
  const element = (
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
          onFailed(false);
          setReview(null);
          setBusy(true);
          void file
            .text()
            .then((text) => {
              const parsed = parsePlanText(text);
              if (parsed) setReview(parsed);
              else onFailed(true);
            })
            .catch(() => onFailed(true))
            .finally(() => setBusy(false));
        }}
      />
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
              onImported();
            }}
            onCancel={() => setReview(null)}
          />
        ) : null}
      </Modal>
    </>
  );
  return {
    busy,
    element,
    choose: (key: string) => {
      if (key === "file") fileRef.current?.click();
      else navigate("/exams/get");
    },
  };
}
