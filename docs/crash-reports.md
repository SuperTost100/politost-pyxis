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

The switch is the `crashReports` field of the profile, stored in the workspace database (`settings` row `privacy`). Core owns it, and nothing leaves the computer until core has reported it for the workspace that is open now:

1. Core sends `crash-consent` with the stored value right after it opens the database, and again after every profile save (`src/core/index.ts`).
2. Main records it in `userData/crash-reports.json` and applies it at once: `crashReporter.setUploadToServer` for minidumps, and the JavaScript reporter reads the current value. No restart is needed.
3. At launch, main starts Crashpad early, so that a crash before core is up is still written, but always with uploads off. Uploads go on only when core reports the switch on.
4. Until core has reported the switch, a JavaScript error is kept in memory only, and only if the saved copy says on: nothing is sent and nothing new is written to disk. Core's answer then decides. On, and the held errors go through the same once-a-day, daily-cap and queue-size checks as any other error, so the ones that pass join the queue and the queue is sent. Off, and the held errors and the queue are dropped.
5. Before a workspace is replaced while Pyxis runs, main goes back to the state of step 4 (`CrashReports.suspend`), and only a core started on the new workspace can confirm the switch again. See [When the workspace is replaced](#when-the-workspace-is-replaced).

The copy can be out of date after a restore or with a workspace from another computer, which is why it never decides a send on its own. Crashpad marks a dump it finds while uploads are off as done without sending it, so a dump still waiting from an earlier session can be lost at launch. That is accepted: losing a report is better than sending one before core has confirmed the switch.

A report created while the switch was off is never sent:

- A JavaScript error raised while it is off is dropped before it is read. Nothing is written to disk.
- Turning the switch off empties the queue of JavaScript errors waiting to be sent.
- Each queued error records when it was created, and one older than the current consent period is dropped unsent.
- Crashpad skips the upload of a dump written while uploads are off, including every dump written at launch before core has answered. At every launch, before Crashpad starts, main deletes every dump in `userData/Crashpad` while the switch is off, and the dumps older than the moment it was last turned on while it is on (`discardUnconsentedDumps`).

### When the workspace is replaced

A restore or a wipe swaps the workspace while Pyxis runs, and the workspace that comes back can have the switch off while main still holds on from the old one. Main closes that gap in `src/main/index.ts`. Before core stops for one of these paths (`pauseCoreToReplace`), sending stops:

| Path                                                                          | What comes back                                           |
| ----------------------------------------------------------------------------- | --------------------------------------------------------- |
| Restore from a file or from the list of automatic backups                     | The restored copy                                         |
| A restore that fails before or during the start of core on the restored copy  | The old workspace, put back by `runArchive("recover")`    |
| A restore whose commit fails (`commitRestore`), stopping core again           | The restored copy, or the old workspace after a rollback  |
| A restore that can be neither kept nor rolled back (`holdForRestoreRecovery`) | Nothing until the next launch: core stays stopped         |
| Delete all data (`workspaceWipe`)                                             | An empty workspace, or the old one if the wipe was undone |

While sending is stopped:

- Crashpad's uploads are off (`setUploadToServer(false)`).
- The JavaScript report on its way is aborted. It stays queued and does not count as a failed send.
- New JavaScript errors follow the rules of step 4: held in memory while the saved copy says on, dropped while it says off.
- Main ignores `crash-consent` from the core being stopped, so a profile save that lands during the stop cannot turn sending back on. Only the next core it starts counts (`CoreConsent`).

The first core that reports the switch on the new workspace decides. On, and sending resumes with the queue and the held errors. Off, and the queue and the held errors are dropped and uploads stay off.

The queue belongs to the consent that created it. A report created under one workspace's switch goes out under another only if that switch is on too. Across a rollback that means the restored copy and the old workspace each confirm in turn. If the restored copy says off, the queue is dropped at that moment and does not come back when the old workspace returns with the switch on, which starts a new consent period. If both say on, the queue goes once the old workspace's core confirms.

A move and a manual backup also stop core, but they reopen the same data, so they leave sending as it is. Neither do the launch paths need this: at launch main always waits for core, after `ensureWorkspace`, the recovery of an interrupted restore or wipe, and any failed bootstrap and its restarts. If core does not stop when asked, nothing is replaced, so that core counts again at once with the switch it last reported, including a change it reported while it was being stopped (`CoreConsent.reinstate`).

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

Development builds send nothing. End-to-end tests send only to a server on `127.0.0.1` named in `PYXIS_E2E_CRASH_ENDPOINT` (with `PYXIS_E2E=1`), and nothing when it is unset; `tests/e2e/crash-reports.spec.ts` uses it. That spec also sets `PYXIS_E2E_CONSENT_HOLD=1`, which lets it hold core's `crash-consent` in main during a restore and raise errors before the restored workspace's switch applies.

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
| The day's or month's storage budget is spent                                                                                                                              | `503` with `Retry-After` set to the next UTC midnight           |

`<day>` is the UTC date (`2026-10-28`), so one day lists with one prefix. A minidump keeps four fields as R2 custom metadata (`appVersion`, `electronVersion`, `platform`, `processType`) and every other form field is dropped. An error report is stored with the time it arrived and its fingerprint.

The Worker stores no IP address and no request headers. It uses the client address only as a rate-limit key, which Cloudflare counts in memory at each location: 10 reports a minute per address on each route (`CLIENT_LIMIT`), and 300 a minute per route at each location (`ROUTE_LIMIT`). Workers Logs are off in `wrangler.jsonc`, because they would keep request headers.

### Cost limits

The endpoint is public and its address is in this repository, so anyone can send to it. The rate limits count per Cloudflare location, so a sender spread over many locations could still write a lot. What bounds the bill is a storage budget kept in one Durable Object (`Budget` in `src/budget.ts`), a single counter for every location. Every report takes room in it before it is written, and once it is spent the Worker answers `503` until the next UTC day without writing anything:

| Budget          | Value   | Why                                                              |
| --------------- | ------- | ---------------------------------------------------------------- |
| Reports a day   | 300     | About 9,000 R2 writes a month, against 1 million free            |
| Minidumps a day | 50      | Inside the 300                                                   |
| Bytes a day     | 100 MiB |                                                                  |
| Bytes a month   | 3 GiB   | Kept 90 days, at most about 9 GiB, against 10 GB of free storage |

Within these numbers R2 stays inside its free tier. A flood can spend the day's budget, which stops real reports until midnight UTC, but it can't raise the bill. Each isolate also remembers for ten minutes that it found the day full, so the requests in that time cost neither a Durable Object call nor a body read, and room given back by a failed write elsewhere is seen at the next check. A report that was only too big for the bytes left isn't remembered, so smaller ones still get in.

What the budget doesn't bound is the number of requests. Every request is a Worker request, and every valid report that passes the rate limits also makes one Durable Object request (`Budget.reserve`) until its isolate has seen the day full. On the Workers Free plan both are capped by Cloudflare (100,000 Worker requests a day, and a daily Durable Object allowance) and nothing is ever charged: past the cap requests are refused. On Workers Paid, 10 million Worker requests and 1 million Durable Object requests a month are included, and more cost extra (see [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)), so a flood big enough to matter would need millions of requests. Set a billing notification in the Cloudflare dashboard to hear about one early.

Reports are kept 90 days. Two things delete them. The bucket's lifecycle rule (step 3 below) is the first line of defence. The Worker also runs once a day at 03:17 UTC (the cron trigger in `wrangler.jsonc`) and deletes every object under a `<day>/` prefix more than 90 days old (`src/retention.ts`), so reports still go if the rule is missing or was changed. A report from exactly 90 days ago goes at the next day's run, and keys that don't start with a real date are left alone.

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

3. Delete reports after 90 days with a lifecycle rule on the whole bucket. The Worker's daily sweep deletes them too, but the rule is the first line of defence:

   ```bash
   npx wrangler r2 bucket lifecycle add pyxis-crash-reports delete-after-90-days --expire-days 90
   ```

4. Check the rule:

   ```bash
   npx wrangler r2 bucket lifecycle list pyxis-crash-reports
   ```

5. Deploy. The Worker answers at `https://pyxis-crash.tost100bar.workers.dev`, the address `CRASH_ENDPOINT` in `src/main/crash-reports.ts` names, and the deploy also registers the daily cron trigger:

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
