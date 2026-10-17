import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Button, Dropdown, Input, Modal, Segmented, Select } from "antd";
import { useTranslation } from "react-i18next";
import { ChevronDown, Search, Settings2 } from "lucide-react";
import { useLocation, useNavigate } from "react-router";
import { EmptyState } from "../../app/layouts/TaskLayouts";
import { invoke } from "../../lib/ipc";
import { CardBrowser } from "./CardBrowser";
import { LibraryPanel } from "./LibraryPanel";
import { PlanCard } from "../../components/PlanCard";
import { Notice } from "../../components/Notice";
import type { PlanFile } from "@shared/plan-file";
import { SubjectManagerModal } from "../ask/SubjectPicker";
import { ImportReview } from "../plans/ImportReview";
import { parsePlanText } from "../plans/importPreview";
import { examDaysLabel } from "../plans/examDays";
import "./HomePages.css";

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
  const [failed, setFailed] = useState(false);
  const tab = location.pathname.startsWith("/exams/library")
    ? "sources"
    : location.pathname.startsWith("/exams/cards")
      ? "cards"
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
  const shown = (plans.data ?? []).filter((plan) => {
    if (plan.archived !== (status === "archived")) return false;
    const needle = query.trim().toLocaleLowerCase();
    const haystack = `${plan.title} ${plan.subject ?? ""}`.toLocaleLowerCase();
    if (needle && !haystack.includes(needle)) return false;
    if (subject && plan.subject !== subject) return false;
    return true;
  });
  const empty = (plans.data?.length ?? 0) === 0;
  const importMenu = (
    <ImportMenu
      large={empty}
      onFailed={setFailed}
      onImported={() => void client.invalidateQueries({ queryKey: ["plans"] })}
    />
  );
  const importFailed = failed ? (
    <Notice tone="danger">{t("shared.importFailed")}</Notice>
  ) : null;
  return (
    <div>
      <h1 className="title-1">{t("doors.exams")}</h1>
      <div className="tabs-row tabs-row-split px-exams-tabs">
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
                  : "/exams",
            )
          }
          options={[
            { value: "plans", label: t("exams.plans") },
            { value: "sources", label: t("exams.sources") },
            { value: "cards", label: t("exams.cards") },
          ]}
        />
        {tab === "plans" ? (
          <div className="px-exams-tab-actions">
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
            <Button
              type="text"
              shape="round"
              icon={<Settings2 size={16} aria-hidden />}
              onClick={() => setManaging(true)}
            >
              {t("ask.manageSubjects")}
            </Button>
          </div>
        ) : null}
      </div>
      <SubjectManagerModal
        open={managing}
        onClose={() => setManaging(false)}
        value=""
        onChange={() => undefined}
      />
      {/* Plans show nothing until the list arrives, so "No plans yet" never flashes first. */}
      {tab === "sources" ? (
        <LibraryPanel />
      ) : tab === "cards" ? (
        <CardBrowser />
      ) : plans.isPending ? null : (plans.data?.length ?? 0) > 0 ? (
        <div>
          <div className="px-exams-toolbar">
            <Input
              id="plan-search"
              aria-label={t("exams.search")}
              prefix={<Search size={16} strokeWidth={1.75} aria-hidden />}
              placeholder={t("exams.searchPlaceholder")}
              allowClear
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
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
            {importMenu}
            <Button
              type="primary"
              shape="round"
              onClick={() => navigate("/plans/new")}
            >
              {t("exams.newPlan")}
            </Button>
          </div>
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
                size="large"
                onClick={() => navigate("/plans/new")}
              >
                {t("exams.newPlan")}
              </Button>
            }
            secondary={importMenu}
          />
          {importFailed}
        </>
      )}
    </div>
  );
}

/**
 * The secondary ways to add a plan, under one "Import" menu: a .pyxis file
 * picked here, or the shared-plan page for a link.
 */
function ImportMenu(props: {
  large?: boolean;
  onFailed: (failed: boolean) => void;
  onImported: () => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [review, setReview] = useState<PlanFile | null>(null);
  const { onFailed } = props;
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
      <Dropdown
        trigger={["click"]}
        open={open}
        onOpenChange={setOpen}
        disabled={busy}
        autoFocus
        // The menu opens outside the page's landmarks; a named region keeps it in one.
        popupRender={(menu) => (
          <div role="region" aria-label={t("exams.importMenu")}>
            {menu}
          </div>
        )}
        menu={{
          items: [
            { key: "file", label: t("exams.importFile") },
            { key: "link", label: t("exams.importLink") },
          ],
          onClick: ({ key }) => {
            setOpen(false);
            if (key === "file") fileRef.current?.click();
            else navigate("/exams/get");
          },
        }}
      >
        <Button
          shape="round"
          size={props.large ? "large" : "middle"}
          disabled={busy}
          aria-haspopup="menu"
          aria-expanded={open}
        >
          <span className="px-exams-import">
            {t("exams.importMenu")}
            <ChevronDown
              size={16}
              strokeWidth={1.75}
              aria-hidden
              className={open ? "is-open" : ""}
            />
          </span>
        </Button>
      </Dropdown>
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
