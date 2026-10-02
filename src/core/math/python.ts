import { runtimeRequest } from "./runtime-client";
export type PythonRun = {
  stdout: string;
  stderr: string;
  images: string[];
  timedOut: boolean;
  truncated: boolean;
};
export async function runPython(
  code: string,
  timeoutMs = 10000,
): Promise<PythonRun> {
  try {
    return (await runtimeRequest("python", { code, timeoutMs })) as PythonRun;
  } catch (error) {
    return {
      stdout: "",
      stderr: error instanceof Error ? error.message : "runtime-unavailable",
      images: [],
      timedOut: false,
      truncated: false,
    };
  }
}
