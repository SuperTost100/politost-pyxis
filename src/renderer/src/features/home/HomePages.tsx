import { useQueryClient } from "@tanstack/react-query";
import { lazy, Suspense, useRef, useState, type ReactNode } from "react";
import { Modal } from "antd";
import { useTranslation } from "react-i18next";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router";
import { invoke } from "../../lib/ipc";
import { LibraryPanel } from "./LibraryPanel";
import { Icon } from "../../components/Icon";
import { Notice } from "../../components/Notice";
import { ToolbarMenu } from "../../components/ListToolbar";
import type { PlanFile } from "@shared/plan-file";
import { ImportReview } from "../plans/ImportReview";
import { parsePlanText } from "../plans/importPreview";
import { ExamsList } from "./ExamsList";
import "./HomePages.css";
import { SkeletonRows } from "../../components/Skeleton";
import { usePlan } from "../../lib/queries";

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

/**
 * Esami's routes: the exam list at /exams, and the pages that were its tabs, each now a page of its own: the Library
 * (which the sidebar opens), every flashcard and the mistakes notebook (both in the Esami menu).
 */
export function ExamsHome() {
  const { pathname } = useLocation();
  if (pathname.startsWith("/exams/library")) return <LibraryHome />;
  if (pathname.startsWith("/exams/cards")) return <CardsHome />;
  if (pathname.startsWith("/exams/mistakes")) return <MistakesHome />;
  return <ExamsListPage />;
}

function ExamsListPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const client = useQueryClient();
  const [managing, setManaging] = useState(false);
  // Stays mounted after the first open, so the dialog can animate closed.
  const [managerOpened, setManagerOpened] = useState(false);
  const [failed, setFailed] = useState(false);
  const planImport = usePlanImport(
    setFailed,
    () => void client.invalidateQueries({ queryKey: ["plans"] }),
  );
  // The Esami menu: importing an exam, the subject list, and every flashcard and mistake across exams.
  const menu = (
    <ToolbarMenu
      label={t("listToolbar.more")}
      disabled={planImport.busy}
      items={[
        { key: "file", label: t("exams.importFileItem") },
        { key: "link", label: t("exams.importLinkItem") },
        { type: "divider" },
        { key: "cards", label: t("exams.allCards") },
        { key: "mistakes", label: t("mistakes.title") },
        { type: "divider" },
        { key: "subjects", label: t("ask.manageSubjects") },
      ]}
      onSelect={(key) => {
        if (key === "subjects") {
          setManaging(true);
          setManagerOpened(true);
        } else if (key === "cards") navigate("/exams/cards");
        else if (key === "mistakes") navigate("/exams/mistakes");
        else planImport.choose(key);
      }}
    />
  );
  return (
    <>
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
      {planImport.element}
      <ExamsList
        menu={menu}
        notice={
          failed ? (
            <div className="px-exams-error">
              <Notice tone="danger">{t("shared.importFailed")}</Notice>
            </div>
          ) : null
        }
      />
    </>
  );
}

/**
 * A page that was a tab of Esami: its title, and the way back when it is not a sidebar section: to the exams, or to the
 * page that opened it (`back` names it).
 */
function SubPage({
  title,
  back,
  children,
}: {
  title: string;
  back?: boolean | { to: string; text: string };
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const to = typeof back === "object" ? back : { to: "/exams", text: t("doors.exams") };
  return (
    <div>
      {back ? (
        <Link to={to.to} className="px-subpage-back">
          <Icon name="arrow-left" size={16} />
          {to.text}
        </Link>
      ) : null}
      <h1 className="title-1 px-subpage-title">{title}</h1>
      {children}
    </div>
  );
}

function LibraryHome() {
  const { t } = useTranslation();
  return (
    <SubPage title={t("nav.library")}>
      <LibraryPanel sortsSubjects />
    </SubPage>
  );
}

function CardsHome() {
  const { t } = useTranslation();
  // Opened from an exam's page (`?exam=<id>`): filtered to that exam, and the way back returns to it.
  const exam = useSearchParams()[0].get("exam") ?? undefined;
  const plan = usePlan(exam);
  return (
    <SubPage
      title={t("exams.allCards")}
      back={exam ? { to: `/plans/${exam}`, text: plan.data?.title ?? t("lesson.back") } : true}
    >
      <Suspense fallback={<SkeletonRows label={t("components.loading")} />}>
        <CardBrowser planId={exam} />
      </Suspense>
    </SubPage>
  );
}

function MistakesHome() {
  const { t } = useTranslation();
  return (
    <SubPage title={t("mistakes.title")} back>
      <Suspense fallback={<SkeletonRows label={t("components.loading")} />}>
        <MistakesNotebook />
      </Suspense>
    </SubPage>
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
