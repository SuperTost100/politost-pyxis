import { expect, test } from "vitest";
import { rendererCsp } from "./csp";

test("production CSP allows only the app's own scripts and local images", () => {
  expect(rendererCsp()).toBe(
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: pyxis-blob:; font-src 'self' data:; connect-src 'self' pyxis-blob:; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-src 'none'",
  );
});

test("development CSP adds the Vite origin and the HMR WebSocket", () => {
  const origin = "http://localhost:5173";
  expect(rendererCsp(origin)).toBe(
    `default-src 'self' ${origin}; script-src 'self' ${origin}; style-src 'self' 'unsafe-inline' ${origin}; img-src 'self' data: blob: pyxis-blob: ${origin}; font-src 'self' data: ${origin}; connect-src 'self' pyxis-blob: ${origin} ws: wss:; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-src 'none'`,
  );
});
