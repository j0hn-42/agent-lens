## Loops and health verdict

Agent Lens looks for two loop patterns in the tool calls it received (#230), per agent:

- **Repeated identical calls**: the same tool called 3 times or more in a row with the same input (same arguments, whatever their order).
- **Read → edit → failure cycles**: a file is read, edited (`Edit`, `MultiEdit`, `Write`, `NotebookEdit`), then the edit itself or the next call fails; 3 such cycles in a row on the same file. A call that succeeds after the edit, or whose end was never seen, breaks the streak.

The **Health** section of the inspector gives the verdict of the selected agent, the evidence of each loop (one line each; hover a cycle line for the full path) and the verdict of its session. The Sessions panel marks a session row with "⟳ loop observed" only when a loop is proven; it says nothing otherwise.

| Verdict | It means |
| --- | --- |
| **Loop observed** | At least one pattern above was seen in the events. It may be over: the verdict covers the kept history, not only the last minutes. |
| **No loop observed (N tool calls)** | Every call of the kept history was compared and nothing repeated. |
| **No loop in the observed part** | No loop seen, but the history is partial: calls without input data cannot be compared ("n of N comparable"), or older messages were dropped (the last 200 conversation messages per agent are kept), or earlier events of the session could not be replayed, by the relay or by the VS Code extension ("at least N earlier events of this session not replayed", see [Graph truncated](relay-and-losses.md#graph-truncated)). A count that may have started before the dropped part reads "at least". |
| **Not enough activity to judge** | No comparable tool call was received. |

Limits, on purpose: only what the events prove is counted, so a loop can be missed (calls without input data, another tool between two identical calls, an edit followed by a read of another file) but is not invented. A tool that polls on purpose (the same `Bash` status command three times) is reported as a repeat: read the evidence before acting. Only sessions whose events are in the current view have a verdict.

- **Badge on the canvas** (#377): a node whose verdict is **Loop observed** carries a circular arrow (⟳) on a dark disc on the upper-left rim of the hexagon (the crown holds the upper-right one), with the legend row *Circular arrow on a node: loop observed* under **Loops and repeats**. No badge is drawn for the other verdicts: there is no "healthy" mark. The screen-reader outline adds ", loop observed" to the agent button and a line with the evidence (at most two findings, the others counted, "at least" kept); a read, edit, failure finding names the base name of the file, and the outline is not masked by presentation mode). The badge is static (it never spins: the loop may be over), drawn at every zoom, faded with a stale or archived node, and not announced live. It is not clickable: select the node for the **Health** section.
