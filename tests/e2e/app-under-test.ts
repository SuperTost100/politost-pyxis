import { join } from "node:path";

/**
 * Launch options for the app under test: the packaged executable named in PYXIS_DIST_APP (CI's packaging job), or the
 * unpackaged build in out/ (PYXIS_OUT overrides the folder).
 */
export function appUnderTest(env: Record<string, string | undefined>) {
  const packaged = process.env.PYXIS_DIST_APP;
  return packaged
    ? { executablePath: packaged, args: ["--use-mock-keychain"], env }
    : {
        args: [
          join(process.cwd(), process.env.PYXIS_OUT ?? "out", "main/index.js"),
        ],
        env,
      };
}
