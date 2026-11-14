import type { ReactNode } from "react";
import { useSearchParams } from "react-router";
import { BackControl } from "../../components/BackControl";
import { usePlace } from "../../app/usePlace";
import { usePlan } from "../../lib/queries";

/**
 * The way back of a page that opens from an exam or from its section: to the page that opened it or to its parent.
 * With `?exam=<id>` the parent is that exam, named by its title.
 */
export function useSubPageBack(): ReactNode {
  const exam = useSearchParams()[0].get("exam") ?? undefined;
  const plan = usePlan(exam);
  const back = usePlace({ parent: plan.data ? { name: { text: plan.data.title } } : undefined });
  return <BackControl target={back} variant="page" />;
}
