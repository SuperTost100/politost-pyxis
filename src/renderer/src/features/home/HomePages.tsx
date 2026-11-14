import { useQueryClient } from "@tanstack/react-query";
import { lazy, Suspense, useRef, useState, type ReactNode } from "react";
import { type MenuProps } from "antd";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router";
import { invoke } from "../../lib/ipc";
import { LibraryPanel } from "./LibraryPanel";
import { Notice } from "../../components/Notice";
import type { PlanFile } from "@shared/plan-file";
import { ImportReviewDialog } from "../plans/ImportReview";
import { parsePlanText } from "../plans/importPreview";
import { ExamsList } from "./ExamsList";
import "./HomePages.css";
import { SkeletonRows } from "../../components/Skeleton";
import { useSubPageBack } from "./subPageBack";

// The mistakes notebook renders Markdown and math, which load with its page rather than with the window.
const MistakesNotebook = lazy(() =>
  import("../study/MistakesNotebook").then((module) => ({
    default: module.MistakesNotebook,
  })),
);
// The subject list's drag and drop loads the first time the student opens it.
const SubjectManagerDialog = lazy(() =>
  import("../ask/SubjectPicker").then((module) => ({
    default: module.SubjectManagerDialog,
  })),
);

/**
 * Esami's routes: the exam list at /exams, and the pages that were its tabs, each now a page of its own: the Library
 * (which the sidebar opens) and the mistakes notebook (in the Esami menu). Every flashcard lives under Flashcard.
 */
export function ExamsHome() {
  const { pathname } = useLocation();
  if (pathname.startsWith("/exams/library")) return <LibraryHome />;
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
  // The Esami menu, for the dots in the head and a right-click on it.
  const menu: MenuProps = {
    items: [
      { key: "file", label: t("exams.importFileItem") },
      { key: "link", label: t("exams.importLinkItem") },
      { type: "divider" },
      { key: "mistakes", label: t("mistakes.title") },
      { type: "divider" },
      { key: "subjects", label: t("ask.manageSubjects") },
    ],
    onClick: ({ key }) => {
      if (key === "subjects") {
        setManaging(true);
        setManagerOpened(true);
      } else if (key === "mistakes") navigate("/exams/mistakes");
      else planImport.choose(key);
    },
  };
  return (
    <>
      {managerOpened ? (
        <Suspense fallback={null}>
          <SubjectManagerDialog
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
        menuDisabled={planImport.busy}
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

/** A page that was a tab of Esami: its way back and its title. */
function SubPage({ title, children }: { title: string; children: ReactNode }) {
  const back = useSubPageBack();
  return (
    <div>
      {back}
      <h1 className="title-1 px-subpage-title">{title}</h1>
      {children}
    </div>
  );
}

/** The Library draws its own head: its title, the folders Pyxis reads and "Aggiungi file". */
function LibraryHome() {
  return <LibraryPanel sortsSubjects />;
}

function MistakesHome() {
  const { t } = useTranslation();
  return (
    <SubPage title={t("mistakes.title")}>
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
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  // The file under review stays until its dialog has shrunk away; `reviewOpen` says whether the dialog is open.
  const [review, setReview] = useState<PlanFile | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
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
          setReviewOpen(false);
          setReview(null);
          setBusy(true);
          void file
            .text()
            .then((text) => {
              const parsed = parsePlanText(text);
              if (parsed) {
                setReview(parsed);
                setReviewOpen(true);
              }
              else onFailed(true);
            })
            .catch(() => onFailed(true))
            .finally(() => setBusy(false));
        }}
      />
      {review ? (
        <ImportReviewDialog
          open={reviewOpen}
          file={review}
          onImport={async (request) => {
            await invoke("plans.import", request);
            setReviewOpen(false);
            onImported();
          }}
          onClose={() => setReviewOpen(false)}
          onClosed={() => setReview(null)}
        />
      ) : null}
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
