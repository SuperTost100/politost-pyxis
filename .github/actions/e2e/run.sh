#!/usr/bin/env bash
# Runs Playwright with one worker, under Xvfb on Linux, where CI has no display. Arguments go to `playwright test`.
set -euo pipefail
if [ "${RUNNER_OS:-}" = Linux ]; then
  exec xvfb-run -a npx playwright test "$@" --workers=1
fi
exec npx playwright test "$@" --workers=1
