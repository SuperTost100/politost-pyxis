import type { PyxisBridge } from "../../src/shared/bridge";
import type {
  RequestInput,
  RequestName,
  RequestOutput,
} from "../../src/shared/ipc";

// The preload's bridge as specs reach it through page.evaluate, with invoke typed by the IPC contract like the
// renderer's own wrapper, so a renamed request or a changed result shape fails the typecheck.
declare global {
  interface Window {
    pyxis: Omit<PyxisBridge, "invoke"> & {
      invoke<N extends RequestName>(
        name: N,
        input: RequestInput<N>,
      ): Promise<RequestOutput<N>>;
    };
  }
}

export {};
