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

## Checks to run before a pull request

These are the commands of `.github/workflows/ci.yml`. All must pass.

```bash
pnpm install --frozen-lockfile
pnpm test
pnpm --dir extension test
pnpm --filter agent-lens run lint
pnpm --dir web exec tsc --noEmit
pnpm --dir web run lint:a11y
pnpm run test:a11y
```

If the change touches rendering, the canvas, CSS or accessibility, also run the browser suite (CI job `e2e-a11y`):

```bash
pnpm --dir web exec playwright install chromium     # once
NEXT_PUBLIC_DEMO=1 pnpm --dir web exec next dev -p 3000 &
E2E_BASE_URL=http://localhost:3000 pnpm --dir web run test:e2e
```

Write the test first, then the code. Keep commits to one logical step.

### Tip: isolated network namespace

Tests that open servers use fixed ports, and a dev server may already hold 3000 and 3001. On Linux, run a command in a private network namespace (its own loopback, no conflict with anything else):

```bash
unshare -rn sh -c 'ip link set lo up; pnpm test'
```

For the e2e suite, start `next dev` inside the same `unshare` so the server and the tests share the namespace.

## Accessibility baselines

Two files act as guard rails. They record known violations; they are not a place to hide new ones.

- `web/tests-a11y/lint-baseline.json`: the jsx-a11y violations that still exist, one entry per file and rule, with the issue that fixes it. `pnpm --dir web run lint:a11y` fails on any new violation and on any listed one that was fixed.
  - Fix the code. Never add a violation to the baseline to make the check pass, and never widen it.
  - `lint:a11y -- --write` rewrites the baseline. Use it only after you **fixed** violations, so the file shrinks; review the diff, and refuse any added entry or any entry without an issue number.
- `web/tests-a11y/known-violations.json`: axe-core findings (jsdom and `e2e:*` browser scenarios) tolerated for a tracked issue. The tests fail on a new violation and when a listed one disappears.
  - A new entry needs an existing issue and a `note`; it is a last resort, reviewed like code. When you fix a listed violation, remove its entry in the same pull request.

## Pull requests

- Target `j0hn-42/agent-lens`, base `develop`. Fill in the pull request template and tick the checklist.
- Keep the change focused; do not reformat or rename outside the scope of the issue.
- Use English identifiers; keep comments rare. Commit messages in French or English, matching the history.
- Do not close issues by hand: the pull request reference does it on merge.

## Compatibility with the Agent Flow heritage

Some Agent Flow names stay on purpose so that existing installs keep working: the extension `publisher`, the `agentVisualizer.*` settings and the legacy hook marker (`LEGACY_HOOK_COMMAND_MARKER`) that cleans up old hooks. Do not rename them without an alias and a migration. Credits in `README.md` and `NOTICE` must stay. The old/current name table is in [extension/CHANGELOG.md](extension/CHANGELOG.md).
