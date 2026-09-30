import { runPython } from "./python";

export function toolHandlers() {
  return {
    python(input: { code: string }) {
      return runPython(input.code);
    },
  };
}
