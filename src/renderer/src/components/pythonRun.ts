/** Largest program `tools.python` accepts. */
export const pythonMaxChars = 8000;

type PythonResult = {
  stdout: string;
  stderr: string;
  images?: string[];
  timedOut: boolean;
  truncated: boolean;
};

export type PythonOutcome = {
  stdout: string;
  stderr: string;
  images: string[];
  /** Why the run is incomplete or could not start; null for a normal run. */
  notice: "timeout" | "truncated" | "setup" | "unavailable" | null;
};

/** Turns a sandbox result into what an inline block shows; the runtime's internal codes never reach the student. */
export function pythonOutcome(result: PythonResult): PythonOutcome {
  const base = {
    stdout: result.stdout,
    stderr: result.stderr,
    images: result.images ?? [],
  };
  if (result.stderr === "runtime-missing")
    return { ...base, stderr: "", notice: "setup" };
  if (
    result.stderr === "runtime-unavailable" ||
    result.stderr === "runtime-timeout"
  )
    return { ...base, stderr: "", notice: "unavailable" };
  if (result.timedOut) return { ...base, notice: "timeout" };
  if (result.truncated) return { ...base, notice: "truncated" };
  return { ...base, notice: null };
}
