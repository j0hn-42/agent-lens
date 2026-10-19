# Contributing to Agent Lens

Agent Lens is a fork of [Agent Flow](https://github.com/patoles/agent-flow). Contributions go to **this fork**, [j0hn-42/agent-lens](https://github.com/j0hn-42/agent-lens), never to the upstream project. With `gh`, always pass `--repo j0hn-42/agent-lens`: the default remote may point to the upstream.

Project principle: never display a state or a number that cannot be proven. See [docs/reading-the-ui.md](docs/reading-the-ui.md).

## Branches

- `main` is the released line; `develop` is the integration branch.
- Branch from `develop` (`git fetch origin && git checkout -b feat/<topic>-<issue> origin/develop`) and open the pull request against `develop`.
- Never push to `main` or `develop`, never force-push a shared branch. Merges happen through reviewed pull requests.
- Name branches `feat/...`, `fix/...`, `docs/...`; refer to the issue in commit messages (`(#129)`).

## Issues and labels

- Work starts from an issue. Each issue carries a role label `agent:<role>` (for example `agent:product-designer`), a type label and a `severity:*` label.
- The relay uses the `agent:<role>` label to show the open issues and PRs of an agent's role in the node inspector (see [docs/node-inspector.md](docs/node-inspector.md)). Keep the label when you open a pull request for that work.
- Issue text gives `file:line` evidence and acceptance criteria. Cover every criterion, tests included.

## Setup

```bash
pnpm install --frozen-lockfile
pnpm run setup          # one-time Claude Code hooks (only to see live sessions)
pnpm run dev:demo       # web app with mock data on http://localhost:3000
```

### Extension against the dev server (F5)

`agentVisualizer.devServerPort` is a machine-scoped setting (a workspace cannot set it: a hostile repository could point the panel at its own server). The repository therefore no longer carries it in `.vscode/settings.json`. To run the "Run Extension" launch config (F5) against `pnpm run dev:web`, set it once in your **User Settings** (`"agentVisualizer.devServerPort": 3000`). Without it the panel silently uses the production bundle.

## Checks to run before a pull request

These are the commands of `.github/workflows/ci.yml`, which runs on every push and pull request to `main` and `develop` — run these commands locally before opening the pull request. All must pass; a failing step no longer hides the following ones. The release workflow reruns this same CI (reusable workflow) before building the `.vsix`.

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

If the change touches rendering, the canvas, CSS or accessibility, also run the browser suite (CI job `e2e-a11y`):

```bash
pnpm --dir web exec playwright install chromium     # once
pnpm --dir web run test:e2e                        # starts the demo app itself on a free port
# or, against a server you already started: E2E_BASE_URL=http://localhost:3000 pnpm --dir web run test:e2e
```

In CI the suite runs as 4 parallel shards (#611): the job `e2e-a11y-shard` (shown as `e2e-a11y (shard n/4)`) runs `pnpm --dir web run test:e2e:shard` with `E2E_SHARD=n/4`, and the job `e2e-a11y`, the check branch protection requires, fails unless all 4 shards succeeded. To rerun one shard locally:

```bash
E2E_SHARD=2/4 pnpm --dir web run test:e2e:shard     # prints the shard's files, runs them, then its totals
```

- The split comes from `web/tests-a11y/e2e/shards.ts`: every `*.e2e.ts` file runs in exactly one shard (a new file not yet in the table gets a default weight), balanced by the median duration per file measured in CI before the split (`web/tests-a11y/e2e/shard-weights.json`, with the runs it comes from). `web/tests-a11y/e2e-shards.test.tsx` checks that no file is lost or run twice.
- Inside a shard, files still run one at a time, each with its own demo server and its own log (`web/test-results/demo-server-<file>.log`). On failure, each shard uploads `web/test-results/` as the artifact `e2e-demo-server-log-shard-<n>`, with the shard's TAP report (`e2e-shard-<n>.tap`). Each shard writes its totals (tests, pass, fail...) to the job summary: their sum is the number of tests the whole suite ran.
- The shards restore two caches: the Playwright Chromium (`~/.cache/ms-playwright`, keyed on `pnpm-lock.yaml`) and the Turbopack dev cache of the demo server (`web/.next-e2e/dev/cache`, keyed on the lockfile and the app sources `web/app`, `components`, `lib`, `hooks`, `public` and the `web/*.json` / `*.mjs` configs, with older caches as fallback). Only shard 1 saves them. A missing cache only makes the run slower.
- After a change of test durations, update `shard-weights.json` from the per-file times of recent runs; it only affects the balance.

`web/tests-a11y/e2e/label-boxes.e2e.ts` (#593) checks the agent labels of a team of 10 (`?scenario=team10`) at the fit zoom in real Chromium: it records every text the canvas paints with its real `measureText` and the transform in force, then compares the boxes of the visible labels two by two. What it proves, and what it does not:

- It proves, for the platform's `monospace` (the font the canvas asks for; the machine that runs it decides which one, for example DejaVu Sans Mono or Liberation Mono on Linux; the test does not record which), that no two visible text boxes share a pixel at 1280 x 800 and 1920 x 1080, and that the measured glyph width of the agent names stays within the 0.6 to 1 em per glyph the plan models (both bounds are asserted).
- It does not prove the same on macOS (Menlo) or Windows (Consolas), nor for glyphs the monospace lacks (CJK, emoji: the browser falls back to another, wider font). It measures the advance width and the font ascent and descent, not the ink of each glyph, and one team, two window sizes, one frame. It records `fillText` only: a text painted with `strokeText`, or through an offscreen canvas and `drawImage`, would escape it. It counts a label as visible when it is inside the viewport and not transparent; a label under a side panel or the control bar still counts, so the minimum of visible names is a little weaker than it reads.
- The plan hides the labels that would collide, so not every name is shown at fit (the number depends on the plan, the window and the font; no figure is asserted here). The test requires the orchestrator and at least 3 names to stay visible so that an empty canvas cannot pass, but it does not require the other labels to be shown.

Write the test first, then the code. Keep commits to one logical step.

### Tip: isolated network namespace

Tests that open servers use fixed ports, and a dev server may already hold 3000 and 3001. On Linux, run a command in a private network namespace (its own loopback, no conflict with anything else):

```bash
unshare -rn sh -c 'ip link set lo up; pnpm test'
```

For the e2e suite, run `pnpm --dir web run test:e2e` inside the `unshare` too (the demo server it starts then shares the namespace).

## Accessibility baselines

Two files act as guard rails. They record known violations; they are not a place to hide new ones.

- `web/tests-a11y/lint-baseline.json`: the jsx-a11y violations that still exist, one entry per file and rule, with the issue that fixes it. `pnpm --dir web run lint:a11y` fails on any new violation and on any listed one that was fixed.
  - Fix the code. Never add a violation to the baseline to make the check pass, and never widen it.
  - `lint:a11y -- --write` rewrites the baseline. Use it only after you **fixed** violations, so the file shrinks; review the diff, and refuse any added entry or any entry without an issue number.
- `web/tests-a11y/known-violations.json`: axe-core findings (jsdom and `e2e:*` browser scenarios) tolerated for a tracked issue. The tests fail on a new violation and when a listed one disappears.
  - A new entry needs an existing issue and a `note`; it is a last resort, reviewed like code. When you fix a listed violation, remove its entry in the same pull request.
- **The issue must be open.** An entry that cites a closed issue is a bug: a closed issue means the violation was declared fixed. `web/tests-a11y/open-baseline-issues.json` is the hand-maintained list of open issues the two baselines may cite (kept offline, so the tests need no network). Add the issue number there when you file the tracking issue, remove it when the issue is closed; `pnpm --dir web run test:a11y` and `lint:a11y` fail on any baseline entry whose issue is not listed. If the violation survives a closed issue, reopen it or file a new one.
- A deliberate design choice is not a baseline entry. Scrollable regions that take `tabIndex={0}` (WCAG 2.1.1) are exempted by name in `web/eslint.config.mjs` (`region`, `group`, `log` roles and `<section>`); inline `eslint-disable` comments are disabled on purpose.

## Branch protection (owner)

The merge gate lives in the repository settings, not in the workflows. Once, as repository admin, require the CI checks `test` and `e2e-a11y`. Read the current protection first (`gh api repos/j0hn-42/agent-lens/branches/<branch>/protection`): a `PUT` on `/protection` replaces every setting, so it must repeat the existing ones.

If the branch already requires some checks, only change those (this keeps the rest of the protection):

```bash
gh api -X PATCH "repos/j0hn-42/agent-lens/branches/main/protection/required_status_checks" \
  -F strict=false -f 'contexts[]=test' -f 'contexts[]=e2e-a11y'
```

If the branch requires no check yet (the endpoint above answers 404), send a `PUT` that repeats the existing settings and adds the checks. Example for `main` as it was configured (no required review, conversation resolution required, no force push):

```bash
gh api -X PUT "repos/j0hn-42/agent-lens/branches/main/protection" --input - <<'JSON'
{
  "required_status_checks": { "strict": false, "contexts": ["test", "e2e-a11y"] },
  "enforce_admins": false,
  "required_pull_request_reviews": { "required_approving_review_count": 0 },
  "restrictions": null,
  "required_linear_history": false,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "block_creations": false,
  "required_conversation_resolution": true,
  "lock_branch": false,
  "allow_fork_syncing": false
}
JSON
```

Apply it to `develop` only once the CI runs on pull requests to `develop` (it does since #182, after that change is merged): before, no check would ever report there and nothing could be merged. Verify by reading the protection back.

## Pull requests

- Target `j0hn-42/agent-lens`, base `develop`. Fill in the pull request template and tick the checklist.
- Keep the change focused; do not reformat or rename outside the scope of the issue.
- Use English identifiers; keep comments rare. Commit messages in French or English, matching the history.
- Do not close issues by hand: the pull request reference does it on merge.

## Compatibility with the Agent Flow heritage

Some Agent Flow names stay on purpose so that existing installs keep working: the extension `publisher`, the `agentVisualizer.*` settings and the legacy hook marker (`LEGACY_HOOK_COMMAND_MARKER`) that cleans up old hooks. Do not rename them without an alias and a migration. Credits in `README.md` and `NOTICE` must stay. The old/current name table is in [extension/CHANGELOG.md](extension/CHANGELOG.md).
