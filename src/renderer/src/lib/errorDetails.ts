/**
 * The technical text of a failure, for the Details of an error state. The core's errors reach the renderer as plain
 * bodies ({ code, messageKey, params, detail }), not Error objects; a thrown Error has a message.
 */
export function errorDetails(error: unknown): string | undefined {
  if (typeof error === "string") return error.trim() || undefined;
  if (error instanceof Error) return error.message.trim() || undefined;
  if (error && typeof error === "object") {
    const { detail, code } = error as { detail?: unknown; code?: unknown };
    if (typeof detail === "string" && detail.trim()) return detail.trim();
    // "internal" only says the core had no better word; it helps nobody.
    if (typeof code === "string" && code.trim() && code !== "internal")
      return code.trim();
  }
  return undefined;
}
