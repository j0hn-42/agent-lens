---
name: pr-fork
description: Open a pull request for the current branch against the Agent Lens fork (j0hn-42/agent-lens), never the upstream. Use when the user asks to open or create a PR.
disable-model-invocation: true
---

# Open a PR on the fork

Contributions go to **`j0hn-42/agent-lens`**, never to `patoles/agent-flow`. Plain `gh` without `--repo` targets the upstream, so every command below passes it explicitly.

## Steps

1. **Check the branch.** `git branch --show-current` must not be `main` or `develop`. Stop otherwise.
2. **Check the base.** `git ls-remote --heads origin develop`: if it exists, the base is `develop`; otherwise `main`.
3. **Check the checks.** Run the `run-checks` skill (or confirm it just passed). Do not open the PR on a red tree.
4. **Push.** `git push -u origin <branch>`. Never force-push a shared branch.
5. **Find the issue.** Ask for it if the branch name and commits do not give a number. Read its labels with `gh issue view <n> --repo j0hn-42/agent-lens --json labels`.
6. **Create the PR** as a draft unless the user says otherwise:
   ```bash
   gh pr create --repo j0hn-42/agent-lens --base <base> --head <branch> \
     --draft --title "<type>(<scope>): <summary> (#<n>)" \
     --label "agent:<role>" --body-file <body.md>
   ```
   - `--head` takes the bare branch name, without an owner prefix (a `jobailla:` prefix fails with "Head sha can't be blank").
   - Copy the `agent:<role>` label from the issue: the relay uses it to show a role's open PRs.
   - Build the body from `.github/pull_request_template.md`. Put `Closes #<n>` in the description to close the issue on merge, or `Refs #<n>` to leave it open.
   - End the body with the attribution line required by the session.
7. **Report** the PR URL.

## Do not

- Open a PR to `patoles/agent-flow`.
- Push to `main` or `develop`, or merge the PR yourself.
