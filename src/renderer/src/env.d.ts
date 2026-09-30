/// <reference types="vite/client" />

import type { PyxisBridge } from "@shared/bridge";

declare global {
  interface Window {
    pyxis: PyxisBridge;
  }
}

export {};
