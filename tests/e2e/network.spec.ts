import { expect, test } from "@playwright/test";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchPyxis } from "./app-under-test";
import { removeTestFolder } from "./cleanup";
import { misspellingMenu, SUGGESTED } from "./spelling";

/** Hosts a test may reach: the loopback servers that some seams start. */
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);

/**
 * Every host in a Chromium net-log (`--log-net-log`) that is not loopback: the hosts of the URLs Chromium loaded or
 * tried to load, and of the names it resolved. Schemes the app serves itself (app:, pyxis-blob:, file:, data:) have no
 * host and are left out.
 */
function remoteHosts(netLog: string): string[] {
  const log = JSON.parse(netLog) as { events?: { params?: { url?: unknown; host?: unknown } }[] };
  const hosts = new Set<string>();
  for (const { params } of log.events ?? []) {
    for (const value of [params?.url, params?.host]) {
      if (typeof value !== "string" || !value) continue;
      // A resolver event names "host:port" or "https://host:443", and a request names a whole URL.
      let host: string;
      try {
        const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `http://${value}`);
        if (!/^(https?|wss?|ftp):$/.test(url.protocol)) continue;
        host = url.hostname.replace(/^\[|\]$/g, "");
      } catch {
        host = value;
      }
      if (!LOOPBACK.has(host)) hosts.add(host);
    }
  }
  return [...hosts].sort();
}

// The net-log records Chromium's network stack: the window, the session (the spell checker's downloads among them) and
// Electron's `net`. Requests that main, core or a worker make with Node's own fetch (the release check, downloads,
// imports) are not in it; SECURITY.md lists those.
test("a new profile makes no request to a remote host at start or when the student types, and has its own dictionaries", async () => {
  test.setTimeout(120_000);
  const root = mkdtempSync(join(tmpdir(), "pyxis-network-"));
  const userData = join(root, "profile");
  const netLog = join(root, "net-log.json");
  const app = await launchPyxis({ userData, args: [`--log-net-log=${netLog}`] });
  let quit = false;
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: /^(Salta|Skip)$/ }).click();
    if (process.platform !== "darwin") {
      // macOS uses the system's checker, whose languages the runner chooses. Elsewhere the checker uses the two
      // dictionaries Pyxis ships: an Italian misspelling gets the Italian word.
      const labels = await misspellingMenu(app, page);
      expect(labels).toContain(SUGGESTED);
    }
    await app.close();
    quit = true;
    // Chromium writes the end of the log when it quits. A log cut short would not parse, and the test fails.
    expect(remoteHosts(readFileSync(netLog, "utf8"))).toEqual([]);
    const dictionaries = join(userData, "Dictionaries");
    const present = existsSync(dictionaries) ? readdirSync(dictionaries).sort() : [];
    expect(present).toEqual(process.platform === "darwin" ? [] : ["en-US-10-2.bdic", "it-IT-3-0.bdic"]);
  } finally {
    if (!quit) await app.close();
    removeTestFolder(root);
  }
});
