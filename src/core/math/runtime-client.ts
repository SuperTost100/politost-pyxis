import { uuidv7 } from "../../shared/ids";

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};
const pending = new Map<string, Pending>();
let sender: ((message: unknown) => void) | undefined;
export function setRuntimeSender(next: (message: unknown) => void): void {
  sender = next;
}
export function receiveRuntimeReply(data: {
  id: string;
  result?: unknown;
  error?: string;
}): void {
  const entry = pending.get(data.id);
  if (!entry) return;
  pending.delete(data.id);
  clearTimeout(entry.timer);
  if (data.error) entry.reject(new Error(data.error));
  else entry.resolve(data.result);
}
export function runtimeRequest(
  operation: string,
  payload: unknown,
): Promise<unknown> {
  if (!sender) return Promise.reject(new Error("runtime-unavailable"));
  const id = uuidv7();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("runtime-unavailable"));
    }, 120000);
    pending.set(id, { resolve, reject, timer });
    try {
      sender!({ type: "runtime-request", id, operation, payload });
    } catch (error) {
      pending.delete(id);
      clearTimeout(timer);
      reject(error instanceof Error ? error : new Error("runtime-unavailable"));
    }
  });
}
