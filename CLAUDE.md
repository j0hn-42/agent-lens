# Agent Lens

Fork of [Agent Flow](https://github.com/patoles/agent-flow): a live canvas of Claude Code agent sessions. pnpm monorepo, TypeScript.

Principle: never display a state or a number that cannot be proven ([docs/reading-the-ui.md](docs/reading-the-ui.md)).

## Layout

- `web/`: Next.js 16 / React 19 / Tailwind 4 app and the Vite webview bundle. Canvas, panels, themes (`web/lib/theme-tokens.json`).
- `extension/`: VS Code extension (esbuild).
- `app/`: standalone app build.
- `scripts/`: the relay server (`relay.ts`), routes, telemetry and most unit tests (`scripts/*.test.ts`).
- `docs/`: user documentation. `scripts/docs.test.ts` and `ui-glossary.test.ts` check parts of it.

## Commands

```bash
pnpm install --frozen-lockfile
pnpm run dev:demo                      # web app with mock data, http://localhost:3000
pnpm test                              # scripts/ and app/ tests (node --test via tsx)
pnpm --dir extension test
pnpm --filter agent-lens run lint      # extension typecheck
pnpm --filter agent-lens run lint:test
pnpm run lint:scripts                  # scripts/*.ts and *.test.ts typecheck
pnpm --dir web exec tsc --noEmit
pnpm --dir web run lint:a11y
pnpm run test:a11y                     # axe-core and keyboard tests (jsdom)
pnpm --dir web run test:e2e            # real browser; only for rendering/CSS/a11y changes
```

The full CI list is in [CONTRIBUTING.md](CONTRIBUTING.md); the `run-checks` skill runs it in order.

Tests open fixed ports (3000, 3001). If a dev server is running, do not kill it: run tests in `unshare -rn sh -c 'ip link set lo up; <cmd>'`, and never run two suites in parallel.

## Git and PRs

- Contributions go to **`j0hn-42/agent-lens`**, never to the upstream `patoles/agent-flow`. Always pass `--repo j0hn-42/agent-lens` to `gh` (the default remote may point to the upstream).
- Branch from `develop` (`feat/...`, `fix/...`, `docs/...`, `chore/...`), open the PR against `develop`. `main` only receives releases. Never push to `main` or `develop`, never force-push, never merge yourself.
- `gh pr create --head <branch>` takes the bare branch name, without an owner prefix.
- Work starts from an issue. Each issue has an `agent:<role>` label (a11y-engineer, ui-designer, canvas-engineer, frontend-engineer, backend-engineer, product-designer, qa-engineer), a type label and a `severity:*` label. Copy `agent:<role>` onto the PR: the relay uses it to show a role's open PRs.
- Use `.github/pull_request_template.md`. `Closes #n` closes the issue on merge into `develop`, `Refs #n` leaves it open. Reference the issue in commit messages: `(#129)`.
- Write the test first, keep commits to one logical step. The `pr-fork` skill opens the PR.

## Generated and locked files (do not edit by hand)

A hook blocks these edits:

- `pnpm-lock.yaml`: use `pnpm install` / `pnpm add`.
- `web/app/themes.css`: edit `web/lib/theme-tokens.json`, then `pnpm run gen:themes` (`scripts/theme-tokens.test.ts` fails when it is stale).
- `extension/README.md`: copied from the root `README.md`.
- `scripts/.dev-relay.js`: built by `scripts/build-relay.js` from `scripts/relay.ts`.

## Accessibility

WCAG 2.1 AA is enforced by CI. Do not widen `web/tests-a11y/lint-baseline.json` or `known-violations.json`. New UI is keyboard-operable, has accessible names, takes colors from theme tokens and respects `prefers-reduced-motion`. The `a11y-reviewer` agent reviews UI diffs; `relay-hardening-reviewer` reviews relay and server changes.

## Automations in `.claude/`

- `settings.json`: hooks. Type-check the package of an edited `.ts`/`.tsx` file (PostToolUse), block generated files (PreToolUse).
- `skills/`: `run-checks`, `pr-fork`.
- `agents/`: `a11y-reviewer`, `relay-hardening-reviewer`.
- `.mcp.json` (root): context7 (current docs for Next 16, React 19, Tailwind 4, Vite 8) and Playwright.
- `settings.local.json` and `worktrees/` are personal and git-ignored.
