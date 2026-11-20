/** The part of a chat row that says how its reply ended. */
type Ending = { role: "user" | "assistant"; stopped?: boolean; error?: unknown };

/**
 * Whether the composer offers Continua: the chat's last message is a reply that ended early, because the student stopped
 * it or the engine cut it off, and no reply is being written. Any message after it, or a finished reply, takes it away.
 */
export function canContinue(rows: readonly Ending[], busy: boolean): boolean {
  const last = rows.at(-1);
  return !busy && last?.role === "assistant" && Boolean(last.stopped || last.error);
}
