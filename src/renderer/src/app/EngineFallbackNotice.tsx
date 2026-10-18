import { App } from "antd";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { onBroadcast } from "../lib/ipc";

/** One line when the engine Pyxis chose hit its usage limit or was signed out and another engine answered instead. */
export function EngineFallbackNotice() {
  const { t } = useTranslation();
  const { message } = App.useApp();
  useEffect(
    () =>
      onBroadcast("engine.fallback", (event) => {
        void message.info({
          key: "engine-fallback",
          content: t(`engines.fallback.${event.reason}`, {
            from: event.from,
            to: event.to,
          }),
          duration: 6,
        });
      }),
    [message, t],
  );
  return null;
}
