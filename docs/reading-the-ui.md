# Reading the UI

Principle (epic #73): never display a state or a number that cannot be proven. When Agent Lens does not know, it says so instead of showing a plausible value.

## Views

- **Fleet / All**: the All view draws every watched session on one canvas. Each session is a dotted halo (its label gives runtime, workspace, status and cost; click it to zoom to the cluster). Sessions of the same project are grouped together.
- **Workflows and Teams**: a dashed halo groups agents. A *Team* is a Claude Code Agent Team; a *Workflow* is one run of the Workflow tool. The hierarchy is Session > Workflow or Team > Agent.
- **Comms**: message links between agents. Long dashes mean a message in flight, a solid line a recent one, a dotted red line an error. The badge is the message count; click a link (or its latest-message bubble) to read it in the link panel.
- **Context**: the project context of a session (`CLAUDE.md`, the memory index and the issue numbers they cite). It is loaded only when the panel opens or you refresh it, and a failure is shown as a failure.
- **Sessions, Timeline, Files, Conversation**: the panels listed in the README.

The graph legend (bottom left of the canvas) explains every colour, shape and line.

## Themes

The **Theme** selector in the top bar (View controls) offers three themes: **Graphite** (the default, neutral dark), **Neon** (the original cyan look) and **Paper** (neutral light). The choice is stored in the browser (`agent-lens-theme`) and applied before the first paint. `?theme=neon|graphite|paper` picks a theme when nothing is stored; the old values `dark` and `light` still work (graphite and paper).

**The theme applies to the interface only.** The toolbar, menus, dialogs, side panels (Conversation, Context, Cost, Files, Timeline, Stats), the legend, the inspector, the UI cards and the focus rings follow the theme. The page background and everything drawn on the scene (nodes, links, halos, phase zones, particles, bloom, bubbles and tool cards drawn on the canvas, canvas labels, grid) keep the neon colours in all three themes. Interface elements that sit above the dark scene stay readable: the top bar carries its own surface, the legend icons sit on a scene-coloured tile, and on Paper the focus ring has a white halo.

For contributors: the interface colours are defined by role in `web/lib/theme-tokens.json` (copy of the design tokens) and generated into `--lens-<role>` custom properties per `[data-theme]` in `web/app/themes.css` (`pnpm run gen:themes`). `COLORS` (`web/lib/colors.ts`) is the interface palette, rebuilt from the computed properties on every theme change: read `COLORS.<key>` when you render, never cache it at module load (use `themed(() => ...)` for a module-level table). `SCENE` is the frozen neon palette used by the canvas, the simulation and the page background: canvas code never reads `COLORS` (a test enforces it). Colour never carries a state alone: a word or an icon always goes with it.

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
