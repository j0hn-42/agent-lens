# Node inspector: model, cost attribution, issue links

Principle (epic #73): never display a state or a number that cannot be proven.

## Model and reasoning effort (#60)

Each agent shows one model and where it comes from. Three sources, strongest first
(`web/lib/model-provenance.ts`):

| Priority | Source | Where it comes from | Pill |
| --- | --- | --- | --- |
| 3 | `runtime` | `model_detected`: the model an assistant message in the transcript reports | `actual` |
| 2 | `configured` | the agent's own configuration (teammate / team definition), `modelSource: 'configured'` on `agent_spawn` | `configured` |
| 1 | `requested` | the `model` of the dispatching Agent/Task call, carried as `requestedModel` on `agent_spawn` | `requested` |

A source replaces the shown model only when its priority is equal or higher: a late "requested" never hides
what ran, and a `/model` switch (runtime again) always updates. A model with no valid source is treated as
`requested`. The requested model is kept apart; when the runtime model does not match it (an alias such as
`opus` matches any id containing it) the pill reads `requested != actual` and the inspector lists both.
The inspector also lists every model the runtime really reported for the agent (`modelsUsed`, bounded to 8).

Reasoning effort is shown only when a source configured one and its value is a known level
(`minimal`, `low`, `medium`, `high`, `xhigh`, `max`). Today that is the `effort` of a Codex `turn_context`
(carried on `model_detected`) or an `effort` on `agent_spawn`; it is never inferred.

## Cost attribution (#61)

One rule: a usage is attributed to an agent only if the name it addresses resolves to exactly one instance
of the session (`web/lib/attribution.ts`).

- `attributed`: exactly one instance holds the local id;
- `orphan`: no instance holds it (yet). The usage is handed to the agent if it appears later;
- `ambiguous`: several instances share the name (the later ones live under `name@toolUseId`). Neither receives it.

Orphan and ambiguous usages go to a bounded remainder (64 names, then one overflow entry). The session total is
the attributed total plus the remainder; the remainder is shown apart (top bar "incl. $x unattributed", and an
`Unattributed` row in the cost panel). It is priced at the default rate because its model is unknown.

## Issue / PR links (#63)

The relay serves `GET /issue-links?role=<role>` (loopback only, rate-limited, cached 60 s). It runs, without a
shell and with a timeout, `gh pr list` and `gh issue list` on the workspace's `origin` remote with
`--label agent:<role> --state open --limit 50`.

- the role comes from the node's dispatch subagent type (else its team role) and must match `[a-z0-9][a-z0-9_-]{0,39}`;
- the repository must be a plain `github.com/<owner>/<name>` remote; any other URL disables the feature;
- every returned URL must be exactly `<repo>/issues/<n>` or `<repo>/pull/<n>`, and the web client checks it again;
- if `gh` or `git` is missing, unauthenticated, rate-limited, slow or fails (or prints something other than a list), the relay answers `502` with `Retry-After` and caches nothing (#205); a workspace without repository, without `origin` or with a non-GitHub remote is a true empty list. A failed repository lookup is not kept: the next request looks again;
- the web client tells "no link" (a successful answer, even empty, cached 60 s) from "unavailable" (a 502 or 503, a network error, a timeout or an unreadable answer, #149): the latter is never cached, the inspector says "Issue and PR links unavailable for now." and the request is retried with a short backoff (1 s doubling up to 30 s, longer if `Retry-After` asks for it, at most 4 retries).

## Pull requests and issues of a session (#228)

The **Context** panel of a single selected session ends with two sections, read from the relay's
`GET /issue-links?scope=session&session=<id>` (same guards, 60 s cache and `gh` process budget as the role query; the
panel asks only while it is open):

- **Pull requests by branch**: a table of the open PRs of the session's repository (`gh pr list --state open --limit 50`,
  fields `number,title,url,isDraft,headRefName,statusCheckRollup`), sorted by branch. A row reads "(this session)" only
  when the session recorded its branch (transcript header) and it is exactly the PR's head branch; a session without a
  recorded branch matches nothing and the panel says so.
- **Issues without an agent**: open issues (`gh issue list --state open --limit 100`, fields `number,title,url,labels`)
  that carry no `agent:<role>` label. An issue whose labels cannot be read is left out, not claimed to be unassigned.

The repository is the `origin` of the session's own working directory. A session of an unknown project (relay in
`--all-workspaces` mode, no known cwd) answers `404` and the panel says the project is unknown rather than showing the
relay's own repository.

Checks come from `statusCheckRollup`, in words and never by colour alone:

| Checks column | It means |
| --- | --- |
| `N of N passing` | every check run / status succeeded, was neutral or skipped |
| `X failing[, Y pending] of N` | at least one failed, timed out, was cancelled or errored |
| `Y pending of N` | none failed, some are queued, running or expected |
| `no checks reported` | gh listed no check for the PR (it does not mean they passed) |
| `checks unknown` | the rollup was missing, or an entry has a state Agent Lens does not know; never shown as passing |

A full page from gh (50 PRs, 100 issues scanned, 50 issues kept) is shown as "At least N ... shown; more may exist".
As for the role links: a failure of `gh` or `git` is `502` and "Pull requests and issues unavailable for now." (not cached,
retried with a backoff), a project without a github.com `origin` says so, and a true empty list says "No open pull
request." Every URL must be exactly `<repo>/pull/<n>` or `<repo>/issues/<n>`, checked again by the web client. Relay
mode only; the VS Code webview and the demo show no section.

Only relay mode (dev relay, standalone app) serves links; the VS Code webview has no relay and shows none. In
`--all-workspaces` mode the repository is that of the relay's own workspace.

## Launch an agent on an issue (#229)

**Not yet enabled.** No button, route or process exists yet: only the validation rules below are in the code
(`extension/src/launch-policy.ts`, pure functions, tested in `scripts/launch-policy.test.ts`). The process
supervisor and the opt-in route (`--allow-launch`, off by default) come next, then the button. Until then, nothing
in Agent Lens can start a `claude` process.

When it is enabled, a launch will be refused unless every check passes:

- the request body is exactly `{"repo": "<owner>/<name>", "issue": <positive integer>, "role": "<role>"}`; the role
  has the same shape as for the issue links above and is not silently lower-cased;
- the repository is in the allow-list given when the relay starts, and is the workspace's `origin` remote;
- the issue, read again with `gh api repos/<owner>/<name>/issues/<n>`, is that issue of that repository (not a pull
  request), is open, carries `agent:<role>`, and was opened by an `OWNER`, `MEMBER` or `COLLABORATOR`.

The command is built without a shell, from a fixed prompt holding only the issue number, the repository and the
role. The issue title and body never enter the command, the prompt or the worktree name (`issue-<n>-<role>`); the
title is kept, without control or bidi characters, only for display in the confirmation dialog. The agent reads
the issue itself with `gh issue view`, and that text stays untrusted:

```
claude -p --worktree issue-<n>-<role> --session-id <uuid> --output-format stream-json --verbose
       --max-budget-usd <amount> --permission-mode default --setting-sources project --strict-mcp-config
       --allowedTools <tools...> --disallowedTools <tools...> -- "<fixed prompt>"
```

- headless (`-p`), `--permission-mode default`, never `bypassPermissions` or `acceptEdits`. No one can answer a
  permission prompt in this mode, so a tool that no loaded rule allows is denied;
- `--allowedTools` only adds to what the loaded settings allow. So the user and local settings are not loaded
  (`--setting-sources project`), no MCP server is started (`--strict-mcp-config` without `--mcp-config`), and an
  explicit deny list wins over any allow rule left;
- allowed tools: `Read`, `Glob`, `Grep`, `Edit`, `Write`, `Bash(git status)`, `Bash(git add:*)`,
  `Bash(git commit:*)`, plus exactly `Bash(gh issue view <n> --repo <owner>/<name>)` for this issue. No
  `git diff` or `git log` (their `--output` and `--no-index` options reach files outside the worktree);
- denied tools: `WebFetch`, `WebSearch`, `Bash(git push:*)`, `Bash(git remote:*)`, `Bash(git config:*)`,
  `Bash(git -c:*)`, `Bash(gh pr:*)`, `Bash(gh api:*)`, `Bash(gh issue comment:*)`, `Bash(gh issue view:* --comments*)`,
  `Bash(gh issue view:* --web*)`, `Bash(curl:*)`, `Bash(wget:*)`, and `Edit` / `Write` on `.git`, `.git/**`,
  `**/.git/**`, `.gitattributes`, `**/.gitattributes`, `.gitmodules`, `.claude/**`, `.mcp.json`, `.husky/**`
  (writing those would let the next `git` command or Claude Code run code the agent chose). The agent commits
  in its worktree; a human pushes;
- the `--session-id` is a v4 UUID generated by the relay, so the canvas can prove which session a launch started.

These rules are permission rules, not a sandbox: they reduce what a prompt injection in the issue can do, they do
not make it impossible. Running the agent under an OS-level sandbox and with a neutral git configuration is left
to the process supervisor (next step). The issue author is checked, not the authors of its comments: the comments
are not part of the allowed `gh issue view` command.

Proposed caps (still open for discussion on #229): 1 simultaneous launch by default (2 at most), 1 per issue,
60 min of wall-clock time, a budget of $5 by default and $20 at most (whole cents from $0.01; a larger amount is
refused, never lowered silently), and the last 256 KB of output kept.

## Health: loop verdict (#230)

The inspector shows the loop verdict of the selected node (its own tool calls only, never its session's), the evidence of each loop found, then the verdict of the whole session. The rules and the wording are in [reading-the-ui.md](reading-the-ui.md#loops-and-health-verdict).
