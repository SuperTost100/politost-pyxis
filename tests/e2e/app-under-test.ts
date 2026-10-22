import { join } from "node:path";

/**
 * Launch options for the app under test: the packaged executable named in PYXIS_DIST_APP (CI's packaging job), or the
 * unpackaged build in out/ (PYXIS_OUT overrides the folder). Unset variables are left out, as Node's spawn does.
 */
export function appUnderTest(env: Record<string, string | undefined>): {
  executablePath?: string;
  args: string[];
  env: Record<string, string>;
} {
  const set = Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  const packaged = process.env.PYXIS_DIST_APP;
  return packaged
    ? { executablePath: packaged, args: ["--use-mock-keychain"], env: set }
    : {
        args: [
          join(process.cwd(), process.env.PYXIS_OUT ?? "out", "main/index.js"),
        ],
        env: set,
      };
}
