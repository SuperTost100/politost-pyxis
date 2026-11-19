import { QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import { watchWindowErrors } from "./lib/errorReports";
import { createQueryClient } from "./lib/queryClient";
import "./locales/i18n";
import "./lib/focusSource";
import "./lib/spinLabels";
import "./design-system/tokens/tokens.css";
import "./styles/global.css";

// Before the first render, so an error while the app starts is reported too (only while the crash-report switch is on).
watchWindowErrors();

const queryClient = createQueryClient();

const root = document.getElementById("root");
if (!root) throw new Error("missing-root");

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
