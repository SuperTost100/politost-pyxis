/**
 * An error as it travels to main's crash reporter: still raw, never sent anywhere in this form. Main scrubs it
 * (`src/main/crash-reports.ts`) before it is stored or sent.
 */
export type ErrorFields = { name: string; message: string; stack: string };

/** Raw fields are cut here first, so a huge message costs little to carry and to scrub. */
export const RAW_ERROR_CHARS = 16_000;

const ERROR_CODE = /^[a-z0-9][a-z0-9-]{0,63}$/;

function field(value: unknown): string {
  return typeof value === "string" ? value.slice(0, RAW_ERROR_CHARS) : "";
}

/**
 * The name, message and stack of a thrown value. A value that is not an Error keeps only its type, or the `code` of a
 * Pyxis IPC error such as `core-restarted`: a thrown string or object could hold anything, student text included.
 */
export function errorFields(value: unknown): ErrorFields {
  try {
    return readFields(value);
  } catch {
    // A getter that throws, or a revoked proxy.
    return { name: "Error", message: "unreadable", stack: "" };
  }
}

function readFields(value: unknown): ErrorFields {
  if (value instanceof Error || (value && typeof value === "object" && "stack" in value && "message" in value)) {
    const error = value as { name?: unknown; message?: unknown; stack?: unknown };
    return { name: field(error.name) || "Error", message: field(error.message), stack: field(error.stack) };
  }
  const code = value && typeof value === "object" ? (value as { code?: unknown }).code : undefined;
  return {
    name: "NonError",
    message: typeof code === "string" && ERROR_CODE.test(code) ? code : value === null ? "null" : typeof value,
    stack: "",
  };
}
