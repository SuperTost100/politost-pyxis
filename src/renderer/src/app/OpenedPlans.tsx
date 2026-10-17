import { useQuery } from "@tanstack/react-query";
import { App } from "antd";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { MAX_OPENED_PLAN_BYTES } from "@shared/bridge";
import { menuCommandAllowed } from "./menu-guard";
import { readMenuContext } from "./menu-state";
import { invoke } from "../lib/ipc";
import { router } from "./router";
import { offerPlanText, onPlanTextOffered, planTextWaiting } from "../features/plans/openedPlan";

const PLAN_NAME = /\.pyxis(\.json)?$/i;

/**
 * Brings a plan file that reaches the window from outside to the import review: one the system opened with Pyxis (main
 * hands over the text, never a path), or one dropped on the window. The review opens on the shared-plan page (the page takes the text when it is entered), unless the
 * student is in onboarding, holds a lock or has a dialog or draft open; the file then waits and opens once they are done.
 */
export function OpenedPlans() {
  const { t } = useTranslation();
  const { message } = App.useApp();
  // Until the profile is known the shell may still send a first-time student to onboarding, which would drop the review.
  const profile = useQuery({ queryKey: ["profile"], queryFn: () => invoke("profile.get", {}) });
  const ready = profile.isSuccess && profile.data != null;

  useEffect(() => {
    const take = () => {
      void window.pyxis.openedPlan
        .take()
        .then((opened) => {
          if (!opened) return;
          if (opened.ok) offerPlanText(opened.text);
          else void message.error(t(`shared.openFailed.${opened.reason}`));
        })
        .catch(() => void message.error(t("shared.openFailed.unreadable")));
    };
    // A file that opened Pyxis is waiting in main before this runs.
    take();
    return window.pyxis.openedPlan.onWaiting(take);
  }, [message, t]);

  useEffect(() => {
    const files = (event: DragEvent) => event.dataTransfer?.types.includes("Files") === true;
    // A drop zone that wants the files has already handled the event (and prevented the default) by the time it gets here.
    const over = (event: DragEvent) => {
      if (files(event) && !event.defaultPrevented) event.preventDefault();
    };
    const drop = (event: DragEvent) => {
      if (!files(event) || event.defaultPrevented) return;
      event.preventDefault();
      const plan = Array.from(event.dataTransfer?.files ?? []).find((file) => PLAN_NAME.test(file.name));
      if (!plan) return;
      if (plan.size > MAX_OPENED_PLAN_BYTES) return void message.error(t("shared.openFailed.too-big"));
      void plan
        .text()
        .then(offerPlanText)
        .catch(() => void message.error(t("shared.openFailed.unreadable")));
    };
    window.addEventListener("dragover", over);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragover", over);
      window.removeEventListener("drop", drop);
    };
  }, [message, t]);

  useEffect(() => {
    if (!ready) return;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const show = () => {
      clearTimeout(retry);
      if (!planTextWaiting()) return;
      const pathname = router.state.location.pathname;
      if (menuCommandAllowed("exams", readMenuContext(pathname))) {
        // On the page already, entering it again gives it a new location key, which is when it takes the text.
        void router.navigate("/exams/get", { replace: pathname === "/exams/get" });
      } else retry = setTimeout(show, 1000);
    };
    show();
    const off = onPlanTextOffered(show);
    return () => {
      clearTimeout(retry);
      off();
    };
  }, [ready]);

  return null;
}
