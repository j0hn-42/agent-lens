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
- if `gh` is missing, unauthenticated, slow or fails, the relay answers an empty list and the inspector shows nothing;
- the web client tells "no link" (a successful answer, even empty, cached 60 s) from "unavailable" (a 503 "Busy", a network error, a timeout or an unreadable answer, #149): the latter is never cached, the inspector says "Issue and PR links unavailable for now." and the request is retried with a short backoff (1 s doubling up to 30 s, longer if `Retry-After` asks for it, at most 4 retries).

Only relay mode (dev relay, standalone app) serves links; the VS Code webview has no relay and shows none. In
`--all-workspaces` mode the repository is that of the relay's own workspace.
