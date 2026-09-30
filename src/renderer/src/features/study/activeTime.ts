import { useEffect } from "react";
import { invoke } from "../../lib/ipc";

export function useActiveTime(planId: string | undefined, topicId: string | null) {
  useEffect(() => {
    if (!planId) return;
    let lastInput = Date.now();
    let seconds = 0;
    const mark = () => {
      lastInput = Date.now();
    };
    const flush = () => {
      if (seconds < 1) return;
      const sent = Math.min(120, seconds);
      seconds = 0;
      void invoke("study.active", { planId, topicId, seconds: sent });
    };
    const timer = window.setInterval(() => {
      if (document.hasFocus() && Date.now() - lastInput < 60_000) seconds += 1;
      if (seconds >= 15) flush();
    }, 1000);
    window.addEventListener("pointerdown", mark);
    window.addEventListener("keydown", mark);
    window.addEventListener("wheel", mark);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("pointerdown", mark);
      window.removeEventListener("keydown", mark);
      window.removeEventListener("wheel", mark);
      flush();
    };
  }, [planId, topicId]);
}
