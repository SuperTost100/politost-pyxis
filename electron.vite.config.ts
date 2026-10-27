import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";
import type { Plugin } from "vite";
import { rendererCsp } from "./src/main/csp";

const root = import.meta.dirname;
const parser = resolve(
  root,
  "node_modules/@politost/content-core/src/parser.ts",
);

function copySandboxPage(): Plugin {
  return {
    name: "copy-sandbox-page",
    apply: "build",
    generateBundle() {
      for (const [name, sourceName] of [
        ["sandbox.html", "index.html"],
        ["host.js", "host.js"],
        ["python-worker.js", "python-worker.js"],
        ["check-worker.js", "check-worker.js"],
        ["symbolic.py", "symbolic.py"],
      ] as const) {
        this.emitFile({
          type: "asset",
          fileName: `runtime/${name}`,
          source: readFileSync(resolve(root, "src/sandbox", sourceName)),
        });
      }
    },
  };
}

// pdf.js loads the decoders for scanned figures (fax, JBIG2, JPEG 2000) by file name from the `wasmUrl` folder. The
// window's CSP allows no WebAssembly, so the PDF viewer asks for their JavaScript builds at pdfjs/ (PdfSourcePage.tsx).
const pdfjsDecoders = ["jbig2_nowasm_fallback.js", "openjpeg_nowasm_fallback.js"];
function pdfjsImageDecoders(): Plugin {
  const folder = resolve(root, "node_modules/pdfjs-dist/wasm");
  return {
    name: "pdfjs-image-decoders",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const name = /^\/pdfjs\/([\w.-]+)$/.exec(request.url ?? "")?.[1];
        if (!name || !pdfjsDecoders.includes(name)) return next();
        response.setHeader("Content-Type", "text/javascript; charset=utf-8");
        response.end(readFileSync(resolve(folder, name)));
      });
    },
    generateBundle() {
      for (const name of pdfjsDecoders)
        this.emitFile({ type: "asset", fileName: `pdfjs/${name}`, source: readFileSync(resolve(folder, name)) });
    },
  };
}

// The built page carries the production CSP itself. The dev server page relies on main's header, which also
// allows the Vite origin and HMR.
function cspMeta(): Plugin {
  return {
    name: "csp-meta",
    apply: "build",
    transformIndexHtml: () => [
      {
        tag: "meta",
        attrs: {
          "http-equiv": "Content-Security-Policy",
          content: rendererCsp(),
        },
        injectTo: "head-prepend",
      },
    ],
  };
}

// katex.min.css lists every font as woff2, woff and ttf. Chromium always takes the woff2, so the other two only made
// the app bigger.
function katexWoff2Only(): Plugin {
  return {
    name: "katex-woff2-only",
    enforce: "pre",
    transform(code, id) {
      if (!/[\\/]katex[\\/]dist[\\/]katex\.min\.css$/.test(id)) return;
      const next = code.replace(/,url\([^)]*\.(?:woff|ttf)\) format\("(?:woff|truetype)"\)/g, "");
      if (next === code) this.warn("KaTeX's @font-face rules changed: the woff and ttf fonts ship again.");
      return { code: next, map: null };
    },
  };
}

export default defineConfig({
  main: {
    resolve: { alias: { "@politost/smartbook-parser": parser } },
    build: {
      rollupOptions: {
        input: {
          index: resolve(root, "src/main/index.ts"),
          core: resolve(root, "src/core/index.ts"),
          "archive-worker": resolve(root, "src/main/archive-worker.ts"),
          "extract-worker": resolve(root, "src/core/sources/extract-worker.ts"),
          "embed-worker": resolve(root, "src/core/sources/embed-worker.ts"),
        },
      },
    },
  },
  preload: {
    build: {
      rollupOptions: {
        input: {
          index: resolve(root, "src/preload/index.ts"),
        },
        output: {
          format: "cjs",
          entryFileNames: "[name].cjs",
        },
      },
    },
  },
  renderer: {
    resolve: {
      alias: {
        "@shared": resolve(root, "src/shared"),
      },
    },
    plugins: [react(), katexWoff2Only(), copySandboxPage(), pdfjsImageDecoders(), cspMeta()],
    // electron-vite leaves the renderer unminified; minifying it shrinks what the window parses at startup.
    build: { minify: "esbuild" },
  },
});
