# Reading the UI

Principle (epic #73): never display a state or a number that cannot be proven. When Agent Lens does not know, it says so instead of showing a plausible value.

## Views

- **Fleet / All**: the All view draws every watched session on one canvas. Each session is a dotted halo (its label gives runtime, workspace, status and cost; click it to zoom to the cluster). Sessions of the same project are grouped together.
- **Workflows and Teams**: a dashed halo groups agents. A *Team* is a Claude Code Agent Team; a *Workflow* is one run of the Workflow tool. The hierarchy is Session > Workflow or Team > Agent.
- **Comms**: message links between agents. Long dashes mean a message in flight, a solid line a recent one, a dotted red line an error. The badge is the message count; click a link (or its latest-message bubble) to read it in the link panel.
- **Context**: the project context of a session (`CLAUDE.md`, the memory index and the issue numbers they cite). It is loaded only when the panel opens or you refresh it, and a failure is shown as a failure.
- **Sessions, Timeline, Files, Conversation**: the panels listed in the README.

The graph legend (bottom left of the canvas) explains every colour, shape and line.

## Honest values

| You see | It means |
| --- | --- |
| **Observed** | Agent Lens received events for it. |
| **Not observed** / "listed - activity not observed" | The session or agent is known (for example listed on disk) but no event was ever received. No state or activity is invented for it. |
| "Not observed yet" (agent card) | The agent was announced but nothing has been seen from it. |
| "fin non observée" (tool card) | The tool call started but its end was never seen. It is not shown as success or failure. |
| **at least X** ("au moins") | The total is partial: some part is absent, so the real value is X or more. It is never shown as a complete number. |
| **estimated** ("estimé") | The token count was computed locally, not reported by the runtime. |
| **non renseigné** | The value is unavailable. It is not shown as 0. |
| **unattributed** | A cost that cannot be tied to exactly one agent (unknown name, or several agents share it). It is listed apart, priced at the default rate, and included in the session total. See [node-inspector.md](node-inspector.md). |
| `actual` / `configured` / `requested` (model pill) | Where the model shown comes from, strongest first. `requested != actual` means the runtime used another model. |

## The `observations` action

Claude can read what Agent Lens observes through the typed action `observations` (`GET /observations` on the loopback relay). The output is whitelisted field by field and reports its own limits (`truncated`, `agentsTruncated`, `omittedSessions`). See [state-share.md](state-share.md).

## More

- [node-inspector.md](node-inspector.md): model, cost attribution, issue and PR links.
- [relay-sources.md](relay-sources.md): how hooks and JSONL transcripts are reconciled, and the local server.
- [state-share.md](state-share.md): validated snapshots and observations.
