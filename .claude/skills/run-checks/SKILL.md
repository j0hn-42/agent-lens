---
name: run-checks
description: Run the same checks as CI (release check, tests, typechecks, a11y lint and tests) in the right order and report failures. Use before opening a PR or when asked whether the tree is green.
---

# Run the CI checks locally

These are the commands of `.github/workflows/ci.yml`. Run them in order from the repo root and **stop at the first failure**: report the failing command and its output, do not skip ahead.

Tests open fixed ports (3000, 3001). If a dev server may be running, wrap each command in a private network namespace instead of killing it:

```bash
unshare -rn sh -c 'ip link set lo up; <command>'
```

Never run two test suites in parallel.

## Order

```bash
pnpm install --frozen-lockfile
node scripts/release-check.js
pnpm test
pnpm --dir extension test
pnpm --filter agent-lens run lint
pnpm --filter agent-lens run lint:test
pnpm run lint:scripts
pnpm --dir web exec tsc --noEmit
pnpm --dir web run lint:a11y
pnpm run test:a11y
```

## Browser suite (CI job `e2e-a11y`)

Run it only when the change touches rendering, the canvas, CSS or accessibility:

```bash
pnpm --dir web exec playwright install chromium   # once
pnpm --dir web run test:e2e                       # starts the demo app itself
```

## Report

State which commands passed, which failed (with the relevant output), and which were skipped and why. Do not claim the tree is green unless every command above ran and passed.
