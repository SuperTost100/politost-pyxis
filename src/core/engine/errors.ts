import { FunnelError } from "./funnel";

export type EngineMessage = {
  messageKey: string;
  code: string;
};

/** Maps a funnel or vendor failure to a translated key. The raw text stays in `detail`. */
export function translateEngineError(err: unknown): EngineMessage {
  const message = err instanceof Error ? err.message : String(err);
  const rawCode =
    err && typeof err === "object" && "code" in err ? String(err.code) : "";
  if (/401|invalid api key|authentication/i.test(`${rawCode} ${message}`)) {
    return { code: "refused", messageKey: "engines.errors.refused" };
  }
  if (/429|rate limit|usage limit|spend limit|quota/i.test(`${rawCode} ${message}`)) {
    return { code: "quota", messageKey: "engines.errors.quota" };
  }
  const code = err instanceof FunnelError ? err.code : "cli-failed";
  return { code, messageKey: `engines.errors.${code}` };
}
