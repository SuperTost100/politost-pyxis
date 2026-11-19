import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useConfirm } from "../components/Dialog";
import { invoke } from "./ipc";
import { outbound } from "./queryClient";

/**
 * The free books list, with each book's library source and whether a newer version can update it. Under "sources",
 * so a change to the library (an import, a removal, an update) reads it again; core keeps the catalog for a few
 * minutes, so that does not ask books.politost.it each time. Only enabled while the list or the Library is open.
 */
export function useFreeBooks(enabled: boolean) {
  return useQuery({
    queryKey: ["sources", "free-books"],
    queryFn: () => invoke("sources.books", {}),
    ...outbound,
    enabled,
    retry: false,
    staleTime: 5 * 60_000,
  });
}

/**
 * Updates a free book in place. A book that plans use asks first, as Replace does. Resolves with the version being
 * installed, or null when the student declined. Errors are thrown to the caller, which shows them where it acted.
 */
export function useBookUpdate() {
  const { t } = useTranslation();
  const client = useQueryClient();
  const confirm = useConfirm();
  const [busy, setBusy] = useState<string | null>(null);
  async function update(sourceId: string): Promise<string | null> {
    setBusy(sourceId);
    try {
      let result = await invoke("sources.updateBook", {
        sourceId,
        confirmed: false,
      });
      if (!result.started && result.inUse > 0) {
        const inUse = result.inUse;
        const answer = await confirm({
          title: t("books.updateTitle"),
          body: t("books.updateInUse", { count: inUse }),
          confirm: t("books.updateConfirm"),
          // The dialog stays, busy, until the update has started.
          run: async () => {
            result = await invoke("sources.updateBook", {
              sourceId,
              confirmed: true,
            });
          },
        });
        if (answer !== "confirm") return null;
      }
      void client.invalidateQueries({ queryKey: ["sources"] });
      return result.started ? (result.version ?? null) : null;
    } finally {
      setBusy(null);
    }
  }
  return { update, busy };
}
