import { App } from "antd";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { MAX_OPENED_PLAN_BYTES } from "@shared/bridge";
import { menuCommandAllowed } from "./menu-guard";
import { readMenuContext } from "./menu-state";
import { router } from "./router";
import { handOverWaitingPlan, offerPlanText } from "../features/plans/openedPlan";
import { useProfile } from "../lib/queries";

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
  const profile = useProfile();
  const ready = profile.isSuccess && profile.data != null;

  useEffect(() => {
    const take = () => {
      void window.pyxis.openedPlan
        .take()
        .then((opened) => {
          if (!opened) return;
          if (opened.ok) offerPlanText(opened.text, { name: opened.name, bytes: opened.bytes });
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
        .then((text) => offerPlanText(text, { name: plan.name, bytes: plan.size }))
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
    return handOverWaitingPlan(router, (pathname) => menuCommandAllowed("exams", readMenuContext(pathname)));
  }, [ready]);

  return null;
}
