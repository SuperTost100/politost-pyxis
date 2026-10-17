import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import "./locales/i18n";
import "./lib/focusSource";
import "./design-system/tokens/tokens.css";
import "./styles/global.css";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
});
// The exam list, a plan and its Progress tab are costly to compute. They stay fresh for 30 s unless a change marks
// them stale: a finished job, a study write (the `plans.evidence` broadcast) or an explicit invalidation.
for (const key of ["plans", "plan", "series"])
  queryClient.setQueryDefaults([key], { staleTime: 30_000 });
// A long chat or lesson is a lot of text and math. Its data goes 30 s after leaving it, not after the default 5 minutes.
for (const key of ["chat", "lesson"])
  queryClient.setQueryDefaults([key], { gcTime: 30_000 });

const root = document.getElementById("root");
if (!root) throw new Error("missing-root");

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
