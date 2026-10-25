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

If the change touches `app-tray/native/` (the Go module of the tray protocol, see [docs/tray.md](docs/tray.md)), CI also runs, from that directory, with the Go version of its `go.mod`:

```bash
test -z "$(gofmt -l .)"
go vet ./...
go test ./...      # includes an end-to-end run with the real Node driver: run pnpm install first
# cross-compilation (#511): pure Go, no binary written
for target in linux/amd64 darwin/arm64 windows/amd64; do
  CGO_ENABLED=0 GOOS="${target%/*}" GOARCH="${target#*/}" go build ./...
  CGO_ENABLED=0 GOOS="${target%/*}" GOARCH="${target#*/}" go vet ./...
done
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
- The shards restore the Playwright Chromium from a cache (`~/.cache/ms-playwright`, keyed on `pnpm-lock.yaml`; `playwright install-deps` runs only when `ldd` finds a missing library or fails, #440; `ldd` only checks the linked libraries, so the font packages and xvfb that `--with-deps` also installed (fonts-freefont-ttf, fonts-ipafont-gothic, fonts-tlwg-loma-otf, fonts-unifont, fonts-wqy-zenhei, xfonts-*) are no longer installed: no e2e file compares a reference capture or types CJK, Thai or Cyrillic text, but the effect of the missing fonts on a text width is not proven). Only shard 1 saves it. A missing cache only makes the run slower. The Turbopack dev cache of the demo server (`web/.next-e2e/dev/cache`) is not cached: measured in #611, it saved at most about 5 s per shard, within the noise.
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

## Design tokens in the web UI

Four rules, enforced by `scripts/design-tokens.test.ts` (#509):

- **Type size**: the 11 px step is the `text-2xs` utility (`--text-2xs` in `web/app/globals.css`), never `text-[11px]`. It stays in px, like the value it replaces.
- **Alpha on a colour**: `withHexAlpha(color, '80')` from `web/lib/color-alpha.ts`, never `color + '80'`. (`withAlpha` in `web/lib/colors.ts` is the other helper: an `rgba(r, g, b,` prefix and a 0-1 number.)
- **Stacking**: a named level of `Z` in `web/lib/agent-types.ts`, never a number, a `Z.x + 1` or a `z-10` class (`z-(--z-info)` for the info level).
- **Scrim**: `var(--lens-scrim)`, a theme token (`web/lib/theme-tokens.json`), never a black `rgba()` literal.

## Shared Button in the web UI

The buttons of the canvas chrome (canvas controls, motion-layer toggles, guided tour card, control bar, permission requests) all use `Button` from `web/components/ui/button.tsx` (#508). A new button of the same kind uses it too, instead of spelling its classes by hand. `Button` takes a required `variant`, renders `type="button"`, and gives every variant the same guarantees: a 24 px minimum target and the theme focus ring (`FOCUS_RING`). `control`, `tour` and `decision` also take their colours from `COLORS` (theme tokens, read when the button renders so a theme change applies); `bar` has no base colours, each use draws its own through `style`. The 44 px target below 768 px (`TOUCH_TARGET`) is not shared by all four variants.

- **Mobile target**: `control`, `bar` and `decision` grow to 44 px below 768 px; `tour` stays at 24 px (its class has no `TOUCH_TARGET`). Giving `tour` the 44 px target changes how the tour card renders, so it is a separate issue.

| Variant | Used for |
| --- | --- |
| `control` | Canvas controls and motion-layer toggles. `active` fills it with the toggle colour; the pressed or open state itself stays on `aria-pressed` / `aria-expanded`. |
| `tour` | The guided tour card. A disabled step is `aria-disabled`, not `disabled`, so focus does not drop to `<body>`. |
| `bar` | The playback bar. Box only: each use draws its own fill, border and colour through `style`. |
| `decision` | Permission request actions. Transparent; a use adds its own border shape through `style`. |

- **Accessible name**: pass `aria-label` or visible text, as for any `<button>`. `Button` does not add one and the refactor changed none.
- **Not a button**: an element that must look like one without being one (a label) takes `buttonClass(variant)` and `buttonStyle(variant)`.
- **A new look** is a new variant in `BASE_CLASS` and `ButtonVariant`, not a one-off class string at the call site.
- **Tests**: `web/tests-a11y/button-pins.test.tsx` fingerprints every button of the five surfaces (names, roles, states, classes) against `web/tests-a11y/fixtures/button-pins.json`; regenerate that file only on purpose (`UPDATE_BUTTON_PINS=1`). `web/tests-a11y/button-theme.test.tsx` checks the colours follow the theme. `scripts/docs.test.ts` checks that this section lists every variant.

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
- Interface strings: add your key to the file of your domain in `web/lib/messages/` (top bar, canvas, sessions, conversation…), with its two languages, fr and en, side by side. `web/lib/messages.ts` only assembles the domains and keeps the imports unchanged; a new domain file is imported in `messages/domains.ts` and in `messages/locales/fr.ts` and `en.ts` (`scripts/lazy-bundle.test.ts` fails otherwise); `scripts/messages.test.ts` fails on a key missing in one language or defined in two domain files (#612).
- UI guide: [docs/reading-the-ui.md](docs/reading-the-ui.md) is an index; add your bullet or paragraph to the file of your domain in `docs/reading-the-ui/`. A new domain file is linked from the index; the tests read the index and the files in its order (`scripts/reading-guide.ts`, #612). A newly translated surface is one bullet under `### In your language` in the file of its domain (top bar, panels, settings and so on); `docs/reading-the-ui/language.md` only links those sections, so translating a surface touches one domain file. Two exceptions touch `language.md`: a surface that was listed there as still English (in its « Still English for now » paragraph) is removed from that paragraph when you translate it, and the first translated surface of a domain without an `### In your language` section adds one link to it.
- Do not close issues by hand: the pull request reference does it on merge.

## Compatibility with the Agent Flow heritage

Some Agent Flow names stay on purpose so that existing installs keep working: the extension `publisher`, the `agentVisualizer.*` settings and the legacy hook marker (`LEGACY_HOOK_COMMAND_MARKER`) that cleans up old hooks. Do not rename them without an alias and a migration. Credits in `README.md` and `NOTICE` must stay. The old/current name table is in [extension/CHANGELOG.md](extension/CHANGELOG.md).
