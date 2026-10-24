## Presentation mode

For demos and streaming. Start it with `V` (or Settings > Presentation); stop it with `V`, `Esc` or the "Presentation mode - V to stop" button under the top bar. It is announced ("Presentation mode on/off") and never starts by itself: only the three options below are remembered in this browser (`agent-lens:presentation`), the mode is not. Each option can be turned off in Settings > Presentation.

- **Subtitles of transitions**: a caption at the bottom of the canvas for each state change of an agent, for example "Main agent: Thinking -> Calling tool Read". Only proof counts: a subtitle is written when this page saw the change happen live. An agent idle between two steps of its turn gets no subtitle: the next observed step is reported from the last one ("Calling tool Read -> Calling tool Edit"). Nothing is said about the state that was already there when the mode started, and nothing about replayed history, imported transcripts or an agent never heard from live. A caption stays 7 seconds; when several changes arrive together, the most recent one is shown. It is for the audience: it is not a live region, so a screen reader is not interrupted.
- **Mask sensitive data** (on by default): free text is hidden, never replaced by a plausible value.
  - On the canvas, tool-call arguments and results, message bubbles, discovery cards, link messages, particle labels, agent names, session and team names (halo labels, the cost panel) are drawn as bullets of the same length. Counts, costs, states, tool names and context gauges stay, because they come from the events and carry no prompt or path.
  - In the panels, Conversation, Files, Context, Timeline, the link panel, the tool and discovery popups, the Sessions and agents list, the selected-session label in the top bar, the agent name in its card and the canvas hover tooltip are blurred and cannot be selected.
  - Subtitles name an agent by its role ("Main agent", "Sub-agent", "Teammate") instead of its name or prompt.
  - Not covered: the text read by screen readers (the graph outline, announcements), the browser tab title, notifications, and anything you copy from a panel before starting the mode. Masking is a screen filter for the audience, not a privacy boundary; check a scene before you share it.
- **Follow the active agent**: the camera centres on the agent that worked last (thinking, calling a tool, waiting for a permission or idle between two steps of its turn, seen live), keeping your zoom. With no such agent it stays where it is. Panning or zooming yourself pauses the follow until another agent takes over; the automatic fit is off while the option is on.

## Notifications

The **Notifications** button in the top bar turns notifications on or off; **Settings > Notifications** chooses what triggers them. Nothing is asked of the browser until you turn them on, and the choice stays in this browser (local storage).

| Trigger | Fires when | Default |
|---|---|---|
| **Agent waiting for a permission** | an agent starts waiting for you to allow a tool | on |
| **Agent in error** | an agent itself is reported in error (no event observed by Agent Lens sets this state yet, so it cannot fire today; a failed tool call does not count: the agent usually handles it and goes on; it shows in the tool error count of the inspector) | on |
| **Session finished** | a session you were watching goes from active to completed: its end was observed (Claude Code's `SessionEnd` hook), a silence never fires it | off |
| **Cost threshold reached** | the context cost estimate of the view (the total of the Cost panel) crosses the amount you set (USD, above 0, up to 10 000), once | off |

- **Where it shows.** In a browser, a system notification appears only while the tab is hidden (the tab title also carries the number of blocked agents). In VS Code, the webview asks the extension, which shows a native message unless the Agent Lens panel is the focused view. The extension checks and caps every message and shows at most one per trigger every 2 seconds.
- **Language.** The text of a notification (*2 agents waiting / 1 agent in error*, *Session finished: api*, *Context cost estimate reached ~$5.20 (threshold $5.00)*) is composed by the page in the interface language (*2 agents en attente / 1 agent en erreur*, *Session terminée : api*), with the same facts and the same qualifiers (*at least*, *estimated*, *incomplete* become *au moins*, *estimé*, *incomplet*). In VS Code the extension does not know the language: it shows the title and the text exactly as the page sends them, so the native message follows the language of the interface too. The title *Agent Lens* is a product name. A session name is data and is quoted as it is.
- **Only what is new.** A trigger fires on a change, never for what was already there: the first state after loading is a baseline, a session already finished in the history is not announced as finished, and nothing is sent while the history is replaying.
- **Only what is proven.** A permission or error is counted only while the app can prove it (see the states above). A cost that is unknown never triggers; a lower bound triggers once it has proven the threshold is reached and the message says *at least*; an estimate says *estimated*. The wording is the one of the top bar.
- **Keyboard.** Every switch and the amount field are reachable with Tab; Space toggles a switch. An invalid amount is refused with a message and the previous threshold stays in force.
