# Crash reports

Pyxis sends crash reports only while the student's crash-report switch is on (Settings > Privacy, or the setup screen), and the switch is off until the student turns it on. Reports go to a Cloudflare Worker, `pyxis-crash`, which stores them in the R2 bucket `pyxis-crash-reports` for 90 days. This page explains what is sent, how consent is enforced, and how to deploy the Worker and read the reports.

## What a report holds

There are two kinds of report.

| Kind             | Comes from                                                                                                                                                                                             | Contents                                                                                                                                                           |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| JavaScript error | Uncaught exceptions and unhandled rejections in main and core; `error` and `unhandledrejection` in the window, and pages that fail to render (the route fallback in `src/renderer/src/app/router.tsx`) | App version, Electron version, OS, CPU architecture, process (`main`, `core` or `renderer`), error name, message and stack frames, after scrubbing                 |
| Minidump         | A native crash of main, the window's renderer, core or another Chromium process, written by Crashpad                                                                                                   | The Crashpad minidump: thread stacks, loaded modules and some memory of the crashed process, plus the app and Electron versions, the platform and the process type |

Scrubbing happens in main (`src/main/crash-reports.ts`) before a JavaScript error is stored or sent:

- The home folder becomes `~`, the workspace `<workspace>` and `userData` `<userData>`, in any slash style and as `file://` URLs, and everything after them is cut, because it would name the student's files.
- Paths under the installed app keep their code path (`<app>/out/main/core.js`). Any other absolute path becomes `<path>`, a web address `<url>` and a `pyxis-blob:` address `<blob>`.
- Quoted text is kept only when it is clearly code, because library messages quote their input (`Unexpected token 'C', "Ciao Mario" is not valid JSON`). Clearly code means one character, `undefined`, `null`, `true`, `false` or `NaN`, or an identifier with an underscore, `$`, a dot, a digit, camelCase or all capitals. A plain word such as `'Mario'` or `'length'` is removed, because a name the student typed looks the same as a property name. A typed word that happens to carry one of those marks, such as `mario.rossi`, would still pass.
- API keys, bearer tokens, long tokens and e-mail addresses are removed.
- The message is cut to 300 characters on one line. The stack keeps up to 30 frames and drops the message lines at its top.
- A value thrown that is not an Error sends only its type, or the `code` of a Pyxis IPC error such as `core-restarted`.

The Worker accepts exactly the eight fields of a JavaScript error and, as a last check, replaces a home-folder account name it still finds with `~`.

Known limits:

- A minidump holds memory of the crashed process, which can include fragments of what was on screen: text of a chat or a lesson, a file name. The switch's copy says so.
- A minidump lists the modules the process loaded with their paths, and on Windows and macOS those paths can include the account name.
- Crashpad adds an installation id (`guid`) to the upload URL and to the form. The Worker reads neither and stores neither.
- A message without quotes or paths that carries student text by itself would pass the scrubbing. Pyxis's own errors are short codes, and the 300-character cut bounds what could slip through.

## Consent

The switch is the `crashReports` field of the profile, stored in the workspace database (`settings` row `privacy`). Core owns it. Main needs it before core has started, so it keeps a copy:

1. Core sends `crash-consent` with the stored value right after it opens the database, and again after every profile save (`src/core/index.ts`).
2. Main records it in `userData/crash-reports.json` and applies it at once: `crashReporter.setUploadToServer` for minidumps, and the JavaScript reporter reads the current value. No restart is needed.
3. At the next launch, main starts Crashpad with the copy's value before core is up, and core confirms or corrects it a few seconds later.

A report created while the switch was off is never sent:

- A JavaScript error raised while it is off is dropped before it is read. Nothing is written to disk.
- Turning the switch off empties the queue of JavaScript errors waiting to be sent.
- Each queued error records when it was created, and one older than the current consent period is dropped unsent.
- Crashpad skips the upload of a dump written while uploads are off. At every launch, before Crashpad starts, main deletes every dump in `userData/Crashpad` while the switch is off, and the dumps older than the moment it was last turned on while it is on (`discardUnconsentedDumps`).

## Sending

JavaScript errors are sent as soon as they are captured, one `POST /error` with a JSON body each. A report that cannot be sent waits in `userData/crash-reports.json` and goes at the next start, once core has confirmed the switch. The client keeps these limits (`CRASH_LIMITS`):

| Limit                                                                                      | Value                        |
| ------------------------------------------------------------------------------------------ | ---------------------------- |
| Same error (same fingerprint: process, name, message with numbers folded, top five frames) | Once a day                   |
| Different errors                                                                           | 10 a day                     |
| Errors looked at                                                                           | 20 a minute                  |
| Queue                                                                                      | 20 reports and 200,000 bytes |
| Failed starts before a queued report is dropped                                            | 5                            |
| Age at which a queued report is dropped unsent                                             | 14 days                      |

A `4xx` answer other than `408` or `429` drops the report, since sending it again would get the same answer.

Crashpad sends minidumps itself, gzip-compressed, as `POST /minidump` multipart uploads. On macOS and Windows it sends at most one an hour (`rateLimit`). Linux has no such limit, so the Worker's rate limit is the only one there.

Development builds send nothing. End-to-end tests send only to a server on `127.0.0.1` named in `PYXIS_E2E_CRASH_ENDPOINT` (with `PYXIS_E2E=1`), and nothing when it is unset; `tests/e2e/crash-reports.spec.ts` uses it.

## The Worker

The Worker lives in [`crash-worker/`](../crash-worker), with its own `package.json`, kept out of the app's build, typecheck and installers. It answers:

| Request                                                                                                                                                                   | Answer                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `POST /error`, `application/json`, at most 64 KiB, exactly the eight fields                                                                                               | `204`, stored as `<day>/error/<uuid>.json`                      |
| `POST /minidump`, `multipart/form-data`, at most 8 MiB as sent and 16 MiB inflated, one `upload_file_minidump` file starting with `MDMP`, `_productName` `PoliTost Pyxis` | `200` with the report id, stored as `<day>/minidump/<uuid>.dmp` |
| Any other path                                                                                                                                                            | `404`                                                           |
| Another method on the two routes                                                                                                                                          | `405`                                                           |
| Wrong content type or encoding                                                                                                                                            | `415`                                                           |
| Bad JSON, bad fields, not a minidump                                                                                                                                      | `400`                                                           |
| Too large                                                                                                                                                                 | `413`                                                           |
| Over the rate limit                                                                                                                                                       | `429`                                                           |

`<day>` is the UTC date (`2026-10-28`), so one day lists with one prefix. A minidump keeps four fields as R2 custom metadata (`appVersion`, `electronVersion`, `platform`, `processType`) and every other form field is dropped. An error report is stored with the time it arrived and its fingerprint.

The Worker stores no IP address and no request headers. It uses the client address only as a rate-limit key, which Cloudflare counts in memory at each location: 10 reports a minute per address on each route (`CLIENT_LIMIT`), and 300 a minute per route for everyone together (`ROUTE_LIMIT`), which caps what a flood can write. Workers Logs are off in `wrangler.jsonc`, because they would keep request headers.

## Deploy and maintain the Worker

These commands need a Cloudflare account with R2 enabled and `wrangler login` done once. Run them from `crash-worker/`.

1. Install the Worker's packages and run its checks:

   ```bash
   npm ci
   npm run typecheck
   npm test
   ```

2. Create the bucket:

   ```bash
   npx wrangler r2 bucket create pyxis-crash-reports
   ```

3. Delete reports after 90 days with a lifecycle rule on the whole bucket:

   ```bash
   npx wrangler r2 bucket lifecycle add pyxis-crash-reports delete-after-90-days --expire-days 90
   ```

4. Check the rule:

   ```bash
   npx wrangler r2 bucket lifecycle list pyxis-crash-reports
   ```

5. Deploy. The Worker answers at `https://pyxis-crash.tost100bar.workers.dev`, the address `CRASH_ENDPOINT` in `src/main/crash-reports.ts` names:

   ```bash
   npx wrangler deploy
   ```

After a change to `wrangler.jsonc`, run `npm run types` and commit the new `worker-configuration.d.ts`; `npm run typecheck` fails until then.

## Read reports

Wrangler has no command to list objects, so list a day through the Cloudflare API with a token that can read R2:

```bash
curl -s "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/r2/buckets/pyxis-crash-reports/objects?prefix=2026-10-28/" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN"
```

Download one report by its key:

```bash
npx wrangler r2 object get pyxis-crash-reports/2026-10-28/error/<uuid>.json --remote --pipe
```

```bash
npx wrangler r2 object get pyxis-crash-reports/2026-10-28/minidump/<uuid>.dmp --remote --file crash.dmp
```

The dashboard's R2 page lists a bucket by prefix too. Read a minidump with `minidump_stackwalk` from Breakpad or Crashpad, using the Electron symbols for the version in its metadata; `scripts/minidump-fault.mjs` names the faulting module without symbols. Treat downloaded minidumps as private student data: keep them off public issues and delete them when the crash is understood.
