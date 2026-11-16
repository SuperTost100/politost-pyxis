import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "electron-vite";
import { build as viteBuild } from "vite";
import react from "@vitejs/plugin-react";
import type { Plugin } from "vite";
import { rendererCsp } from "./src/main/csp";

const root = import.meta.dirname;

/** The commit About names, so Tost can tell which test build he runs: CI's, else the checkout's, else none. */
function buildCommit(): string {
  const fromCi = process.env["PYXIS_COMMIT"] ?? process.env["GITHUB_SHA"];
  if (fromCi) return fromCi.slice(0, 7);
  try {
    return execFileSync("git", ["rev-parse", "--short=7", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}
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
        ["draw.html", "draw.html"],
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

/**
 * The drawing window runs two scripts of the app, each a bundle of its own. The page (src/sandbox/draw-host.ts) holds
 * DOMPurify and the code that turns a drawing into a picture. The worker (src/sandbox/draw-worker.ts) runs the
 * downloaded Graphviz, in a context that shares nothing with the page. Both ship with the app, never with the pack.
 */
function drawScripts(): Plugin {
  const scripts = [
    { entry: "src/sandbox/draw-host.ts", name: "PyxisDrawHost", file: "draw-host.js" },
    { entry: "src/sandbox/draw-worker.ts", name: "PyxisDrawWorker", file: "draw-worker.js" },
  ];
  return {
    name: "draw-scripts",
    apply: "build",
    async generateBundle() {
      for (const script of scripts) {
        const built = await viteBuild({
          configFile: false,
          logLevel: "silent",
          root,
          define: { "process.env.NODE_ENV": JSON.stringify("production") },
          build: {
            write: false,
            minify: "oxc",
            lib: {
              entry: resolve(root, script.entry),
              formats: ["iife"],
              name: script.name,
              fileName: () => script.file,
            },
          },
        });
        const outputs = (Array.isArray(built) ? built : [built]).flatMap((result) =>
          "output" in result ? result.output : [],
        );
        const chunks = outputs.filter((output) => output.type === "chunk");
        if (chunks.length !== 1) throw new Error(`${script.file} must be one file.`);
        this.emitFile({ type: "asset", fileName: `runtime/${script.file}`, source: chunks[0]!.code });
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
      rolldownOptions: {
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
      rolldownOptions: {
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
    plugins: [react(), katexWoff2Only(), copySandboxPage(), drawScripts(), pdfjsImageDecoders(), cspMeta()],
    define: { __PYXIS_COMMIT__: JSON.stringify(buildCommit()) },
    // electron-vite leaves the renderer unminified; minifying it shrinks what the window parses at startup.
    build: { minify: "oxc" },
  },
});
