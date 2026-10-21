---
name: issue-waves
description: Run several open issues of the Agent Lens fork in parallel without merge conflicts, by grouping them into waves of disjoint files, one worktree and one draft PR per issue, then read-only review. Use when the user asks to launch, batch, parallelize or "lancer" several or all remaining issues, a sprint, or a wave ("vague"), or asks how to avoid merge conflicts between issues.
---

# Issue waves

Goal: run many issues at once, and make the conflicts impossible or trivial. Contributions go to **`j0hn-42/agent-lens`**: every `gh` command passes `--repo j0hn-42/agent-lens`.

## 1. Inventory (read-only)

```bash
gh issue list --repo j0hn-42/agent-lens --state open --limit 100 \
  --json number,title,labels --jq '.[] | "#\(.number) [\([.labels[].name]|join(","))] \(.title)"'
gh pr list --repo j0hn-42/agent-lens --state open
```

- Skip epics (`epic` label) and issues too broad for one agent (e.g. "Runtimes supplémentaires", "Accès distant"). Propose splitting them into sub-issues first.
- Skip issues that already have an open PR.

## 2. Predict the files each issue touches

Issue bodies rarely cite paths. Do not guess from titles alone: run one read-only `Explore` agent per batch of issues, asking for the likely files (with `grep` evidence), not for a fix.

Hot files that cause most conflicts here. Issues touching the same one go in **different waves**, never the same one:

- `scripts/relay.ts` and `scripts/routes*`
- `web/lib/theme-tokens.json` (regenerates `web/app/themes.css`)
- `web/lib/ui-glossary.ts`
- The message catalog and the UI guide are split by domain since #612: `web/lib/messages/<domain>.ts` (both languages of a domain in one file; `web/lib/messages.ts` only assembles them) and `docs/reading-the-ui/<domain>.md` (`docs/reading-the-ui.md` is the index). Two issues on the same domain file go in different waves; different domains no longer conflict. A translated surface is listed under `### In your language` in the file of its domain (`docs/reading-the-ui/language.md` only links those sections), so a translation issue touches its domain file, not `language.md`. Adding a domain file touches the shared lists (`web/lib/messages/domains.ts` and `web/lib/messages.ts`, or the index `docs/reading-the-ui.md`).
- `web/hooks/simulation/process-event.ts`
- `package.json` (an issue that adds a dependency goes first and alone)

## 3. Form the waves and get the user's go

- **Wave 1**: issues with disjoint file sets, in parallel. Cap at about 6 agents.
- **Later waves**: issues that share a hot file, in the order of dependency (vocabulary/glossary before the issues that use it; design-system debt last).
- Show the table (issue, zone, role, model) and ask which wave to launch. Never launch a wave the user has not named.

## 4. Launch a wave

Use a `Workflow` (or `Agent` calls with `isolation: "worktree"`, `run_in_background`) with one implementer per issue, then one read-only reviewer per PR:

- Model: Sonnet for mechanical work, Opus for audits and reviews. Never Fable in sub-agents.
- Implementer prompt: read the issue; `git fetch origin`; branch `feat|fix/<n>-slug` from `origin/develop`; test first (red before, green after); one commit per logical step with `(#<n>)` and the session's `Co-Authored-By` line; stay in the zone; never edit generated or locked files; push; open a **draft** PR with the `pr-fork` rules (`--head` bare branch name, `agent:<role>` label copied from the issue, `Closes #n` only if the issue is fully done, else `Refs #n`).
- Tests open ports 3000 and 3001: run them in `unshare -rn sh -c 'ip link set lo up; <cmd>'`, one suite at a time per environment. `pnpm install --frozen-lockfile` if `node_modules` is missing, so typechecks really run.
- Tell agents to take the most conservative reading of an ambiguous issue and to report partial coverage as `Refs`, not `Closes`.
- Reviewer: `relay-hardening-reviewer` for relay/watcher/app code, `a11y-reviewer` for `web/`. Read-only, cites file and line, does not comment on the PR.
- Nobody merges, force-pushes, or pushes to `main`/`develop`.

## 5. Fix review findings

Fixes go as **new commits on the PR branch** (`git checkout -B tmp origin/<branch>` then `git push origin HEAD:<branch>`; the branch may be checked out in another worktree). Never force-push. Red test first, then the fix, then a summary comment on the PR.

## 6. Hand back to the user

Report a table: PR, issue, status (done or partial), review verdict, open findings, unverified items (CI not read, checks not run). Give the merge order: small and structural PRs first; update the next branch on `develop` (`git rebase origin/develop`, or "Update branch") and rerun its tests before each merge. The user merges.

## When a conflict happens anyway

- `pnpm-lock.yaml`: take `develop`'s version, then `pnpm install`.
- `web/app/themes.css`: resolve `theme-tokens.json`, then `pnpm run gen:themes`.
- `scripts/.dev-relay.js`: rebuild with `scripts/build-relay.js`.
- Anything else: use the `resolving-merge-conflicts` skill.
