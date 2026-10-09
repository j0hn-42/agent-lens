# Reading the UI

Principle (epic #73): never display a state or a number that cannot be proven. When Agent Lens does not know, it says so instead of showing a plausible value.

## Views

- **Fleet / All**: the All view draws every watched session on one canvas. Each session is a dotted halo (its label gives runtime, workspace, status and cost; click it to zoom to the cluster). Sessions of the same project are grouped together.
- **Workflows and Teams**: a dashed halo groups agents. A *Team* is a Claude Code Agent Team; a *Workflow* is one run of the Workflow tool. The hierarchy is Session > Workflow or Team > Agent.
- **Comms**: message links between agents. Long dashes mean a message in flight, a solid line a recent one, a dotted red line an error. The badge is the message count; click a link (or its latest-message bubble) to read it in the link panel.
- **Context**: the project context of a session (`CLAUDE.md`, the memory index and the issue numbers they cite). It is loaded only when the panel opens or you refresh it, and a failure is shown as a failure.
- **Sessions, Timeline, Files, Conversation**: the panels listed in the README.

The graph legend (bottom left of the canvas) explains every colour, shape and line.

### See the legend in action

The guided tour (`pnpm run dev:demo:guided` or `?scenario=guided`, see [demo.md](demo.md), in French) walks through every section of the legend. Steps per section:

- **States**: steps *Meet your agent*, *Tool calls*, *Results come back*, *Waiting for you*, *When something fails* and *Agent Teams*. The `paused` state is described only, in step *Seen only in a real session*.
- **Shapes**: steps *Meet your agent*, *Tool calls*, *Sub-agents* and *Results come back*. The discovery card shape is described only (*Seen only in a real session*).
- **Edges and particles**: steps *Tool calls*, *Sub-agents* and *Results come back*. The dispatch and return particles are described only, in *Sub-agents* and *Results come back*: the tour pauses the scene at each step, and a paused scene draws no particle. The unverified parent link and the two folded-branch badges are described only (*Seen only in a real session*).
- **Teams**: step *Agent Teams* (and *Delivered messages and finished teammates* for a finished teammate, *Results come back* for an archived agent). The session halo is described only (*Seen only in a real session*).
- **Message links**: steps *Messages between agents*, *Delivered messages and finished teammates* and *Quiet links*. The error link is described only (*Seen only in a real session*).
- **Context usage**: step *Context usage*.
- **Discoveries**: none of these entries is shown in the demo; they are all described only (*Seen only in a real session*).
- **Runtime**: steps *Meet your agent* (Claude) and *Two runtimes* (Codex).

## Themes

The **Theme** selector in the top bar (View controls) offers nine themes, all dark:

| Theme | Pick it for | Look |
|---|---|---|
| **Catppuccin Macchiato** (default) | everyday use | the mid-dark Catppuccin flavor: soft slate-blue grounds, mauve accent |
| **Catppuccin Mocha** / **Catppuccin Frappe** | the Catppuccin palette you already use in your editor and terminal | the darkest and the lightest dark flavors (Latte, the light flavor, is not offered) |
| **Midnight** | long sessions, less eye strain | calm indigo and blue-violet, softer than Neon |
| **Graphite** | a neutral look | neutral grey, flat cards |
| **Neon** | the original look | cyan on deep blue-black, glass cards |
| **Ember** | the evening, reduced blue light | warm charcoal and brown, soft amber accent, almost no blue |
| **Anthropic** | a warm, neutral look | near-black warm greys, off-white text, orange accent. Inspired by the public colours of Anthropic; not an official theme, and it uses no logo |
| **High contrast** | low vision, bright rooms | pure black, white text (7:1 or more), yellow accent, strong white borders, a 3px focus ring |

The choice is stored in the browser (`agent-lens-theme`) and applied before the first paint. `?theme=catppuccin-macchiato|catppuccin-mocha|catppuccin-frappe|midnight|graphite|neon|ember|anthropic|contrast` picks a theme when nothing is stored. The system or VS Code light mode never switches the theme. The former light theme **Paper** was removed, and Catppuccin Macchiato is the default (it replaced Graphite): a stored `paper`, `light` or `dark` (and `?theme=` with one of these) now opens Catppuccin Macchiato, while a stored valid theme id, graphite included, is kept. In Midnight, Ember and High contrast the states (done, tool, error, delegate) also differ by lightness, not only by hue; the Catppuccin and Anthropic themes keep their own hues. In every theme a state is always paired with a word or an icon.

Catppuccin and the official palette: the colours are the ones of palette.json 1.8.0, mapped on the roles (void = crust, surface = mantle, surface-raised = base, edge = surface1, control-border and context-system = overlay1, ink = text, ink-muted = subtext0, accent = mauve, on-accent = crust, focus = blue, ok = green, warn = yellow, danger = red, delegate = lavender, info = teal). Every role value is the official one, unmodified. The only adjustments are in the Bash ANSI palette (the official normal and bright colours, 0 to 15), where a few entries are lightened toward white, just enough to keep 4.5:1 once dimmed: black and bright black (0 and 8) on the three flavors, bright red (9) on Macchiato, and red (1), blue (4), bright red (9) and bright blue (12) on Frappe. A few derived tints of the interface (error row, search highlight) are lighter-weight than before for the same reason.

Anthropic and the brand colours: Dark `#141413` is the surface, Light `#faf9f5` the text, mid grey `#b0aea5` the muted text, orange `#d97757` the accent (dark text on it), blue `#6a9bcc` the delegate colour. The brand green `#788c5d` is 4.48:1 on the raised surface, just under 4.5:1, so `ok` is lightened to `#8fa774`. The brand has no yellow, red or teal: warn, danger and info are warm derived colours, and the grounds (void, raised, edge, control border) are warm greys derived from Dark.

**The theme applies to the interface only.** The toolbar, menus, dialogs, side panels (Conversation, Context, Cost, Files, Timeline, Stats), the legend, the inspector, the UI cards and the focus rings follow the theme. The page background and everything drawn on the scene (nodes, links, halos, phase zones, particles, bloom, bubbles and tool cards drawn on the canvas, canvas labels, grid) keep the neon colours in every theme. Interface elements that sit above the dark scene stay readable: the top bar carries its own surface, the legend icons sit on a scene-coloured tile, and every focus ring keeps 3:1 or more against both the interface surfaces and the scene.

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
| **Loading history (n/N)** | A burst of received events (switching to All, a relay replay) is being applied a few milliseconds per frame: n of the N events are on the canvas, the rest are not drawn yet. Screen readers hear the start and "History loaded (N events)" at the end. |
| `actual` / `configured` / `requested` (model pill) | Where the model shown comes from, strongest first. `requested != actual` means the runtime used another model. |

## The `observations` action

Claude can read what Agent Lens observes through the typed action `observations` (`GET /observations` on the loopback relay). The output is whitelisted field by field and reports its own limits (`truncated`, `agentsTruncated`, `omittedSessions`). See [state-share.md](state-share.md).

## More

- [node-inspector.md](node-inspector.md): model, cost attribution, issue and PR links.
- [relay-sources.md](relay-sources.md): how hooks and JSONL transcripts are reconciled, and the local server.
- [state-share.md](state-share.md): validated snapshots and observations.
