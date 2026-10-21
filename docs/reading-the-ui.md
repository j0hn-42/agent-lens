# Reading the UI

Principle (epic #73): never display a state or a number that cannot be proven. When Agent Lens does not know, it says so instead of showing a plausible value.

The guide is split by domain ([#612](https://github.com/j0hn-42/agent-lens/issues/612)), one file per domain, in this order:

- [Views: canvas, halos, zones, links and file conflicts](reading-the-ui/views.md)
- [Top bar](reading-the-ui/top-bar.md)
- [Panels: Sessions, Context, System and the names of things](reading-the-ui/panels.md)
- [Hide inactive and what it hides](reading-the-ui/filters.md)
- [Gear dialog and preferences](reading-the-ui/preferences.md)
- [Review and playback](reading-the-ui/playback.md)
- [Live announcements](reading-the-ui/announcements.md)
- [Narrow windows and phone width](reading-the-ui/small-screens.md)
- [Command palette](reading-the-ui/command-palette.md)
- [Graph legend and guided tour](reading-the-ui/legend-and-tour.md)
- [Why this tool, and the action cards](reading-the-ui/tool-calls.md)
- [Themes](reading-the-ui/themes.md)
- [Honest values](reading-the-ui/honest-values.md)
- [Repeated reads and calls](reading-the-ui/repeated-reads.md)
- [Delegation report](reading-the-ui/delegation-report.md)
- [Quota gauges, context window and cost](reading-the-ui/cost-and-usage.md)
- [Pi, Gemini CLI and OpenCode sessions](reading-the-ui/runtimes.md)
- [Project folders, skills and memory, resuming a session](reading-the-ui/project-context.md)
- [Graph truncated](reading-the-ui/relay-and-losses.md)
- [Presentation mode and notifications](reading-the-ui/presentation-and-notifications.md)
- [Loops and health verdict](reading-the-ui/loops-and-health.md)
- [Canvas controls and motion by layer](reading-the-ui/canvas-controls.md)
- [Language](reading-the-ui/language.md)
- [What Claude can read, and further reading](reading-the-ui/claude-access-and-more.md)

To document a change, add your bullet or paragraph to the file of its domain, next to the ones it belongs with. A newly translated surface is one bullet in the In your language section of the file of its domain, not in the Language file. A new domain file is linked here, in reading order. The tests read the whole guide: this index, then each file in the order of the list above (`scripts/reading-guide.ts`).
