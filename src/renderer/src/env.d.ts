/// <reference types="vite/client" />

import type { PyxisBridge } from "@shared/bridge";

declare global {
  /** The commit the renderer was built from, seven characters, or empty when the build had no git checkout. */
  const __PYXIS_COMMIT__: string;
  interface Window {
    pyxis: PyxisBridge;
  }
}

export {};
