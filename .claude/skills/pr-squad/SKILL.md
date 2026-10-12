---
name: pr-squad
description: Report on the open PRs of the fork, sorted by what they wait on (you, author, squad, CI). Read-only. Use when the user asks for the state of the PRs or wants a recurring PR check.
disable-model-invocation: true
---

# PR squad report (read-only)

Stage 1 of the PR squad: look, never write. Inspired by a Copilot "PR squad" that earned write access in steps (watch-only, one item, all, scheduled).

## Steps

1. Delegate to the `pr-coordinator` agent: "Report on the open PRs." It runs `scripts/pr-squad-triage.ts` and answers with the sections and questions for the user.
2. Relay its report as is. Do not add PRs or states it did not list.
3. For a recurring check, suggest `/loop 1h /pr-squad` (the user starts it; nothing is scheduled by this skill).

## Do not

- Post, approve, label, mark ready or merge anything on the user's behalf.
- Widen this skill to write actions without a new issue: the next stages (review a draft against its issue, post one fact-checked comment) each need their own tests and the `relay-hardening-reviewer` style of review.
