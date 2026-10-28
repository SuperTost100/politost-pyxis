import { errorFields, type ErrorFields } from "../shared/error-fields";

type ErrorSource = {
  on(event: "uncaughtExceptionMonitor", listener: (error: unknown) => void): unknown;
  on(event: "unhandledRejection", listener: (reason: unknown) => void): unknown;
};

/**
 * Hands every uncaught exception and unhandled rejection of this process to `onError`, for the crash reporter in main.
 * The exception is watched through the monitor event, so the process still ends as it would without this. Electron
 * only warns about an unhandled rejection; listening for it silences that warning, so the rejection is logged here
 * instead, as the warning did.
 */
export function watchProcessErrors(
  label: string,
  onError: (fields: ErrorFields) => void,
  source: ErrorSource = process,
): void {
  const report = (value: unknown) => {
    try {
      onError(errorFields(value));
    } catch (error) {
      console.error(`${label}: error report failed`, error instanceof Error ? error.message : "unknown");
    }
  };
  source.on("uncaughtExceptionMonitor", report);
  source.on("unhandledRejection", (reason) => {
    console.error(`${label}: unhandled rejection`, reason);
    report(reason);
  });
}
