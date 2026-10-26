## Repeated reads and calls

![The Files & repeats panel of the demo tour with the Repeated reads and calls section open: a command run again right after itself, a file read again and a Glob run again, each with the tokens of the repeats only, then the one file two agents edited, listed as a conflict](../media/repeats.png)

The picture is the demo tour (`pnpm run dev:demo`) at 1:06; its data is mock data.

The **Files & repeats** panel (*Fichiers et répétitions* in French, key F; [#518](https://github.com/j0hn-42/agent-lens/issues/518)) opens with a "Repeated reads and calls" section, computed from the tool events already received (nothing is read from disk). It reports facts, not verdicts: a repeat may be intended.

The section is a disclosure (Enter or Space on its summary opens or folds it; screen readers hear its state). It is folded when the panel opens with at least one file listed, so the file list starts near the top of the panel, and open when no file is listed; afterwards it stays as you left it until the panel is closed. Its summary keeps the count while it is folded, counted on the same list as the rows (the 20 drawn plus the ones counted as "more"), with the same qualifiers:

| Summary | It means |
| --- | --- |
| **Repeated reads and calls: N repeated targets observed** | N rows below, one per repeated target (a file read again, a Glob or a command run again): the unit is a target, not a call and not a repeat (a file read three times is one target). "observed", never "wasted". |
| **… at least N repeated targets observed** | The tracking limit was reached, or the relay could not replay some events: the list is a lower bound. |
| **… no repeated target observed** | No row. It proves only that none was seen among the calls compared. |
| **… no repeated target observed (incomplete)** | No row, and the list is a lower bound (tracking limit or events not replayed): never a bare 0. |
| **…, N calls not compared** | N calls arrived without the input needed to compare them; a repeat may hide among them. |

A heading *Repeated reads and calls*, read only by screen readers, stays before the disclosure, so heading navigation still finds the section. The panel title (*FILES & REPEATS*), its button, the shortcut F, the command palette, the legend, the tour, the Settings reset help and the name of its scroll region (*Files & repeats observed*, *Fichiers et répétitions observés*) all use the one name of the panel. Before #518 the panel was named *Files* (*Fichiers*), titled *FILE ATTENTION* (*ATTENTION AUX FICHIERS*), and its region was named *Files accessed by agents*, although it also held the repeats.

| Row | It means |
| --- | --- |
| **read again N times, no edit seen in between** | The same agent read the same file, with the same offset and limit, N more times, and no Edit, Write or patch on that file (or a patch of unknown path in that session) was seen between the reads. A read of another range, or by another agent, is not a repeat: each agent has its own context. Nor is a read after a context compaction of that agent, or after a read of the file that was seen to fail or be cancelled: the content was not in its context. |
| **same Glob run again N times, no edit seen in between** | The same pattern and path, with no write seen in the session, nor compaction of that agent, between the calls. |
| **same Bash command run again N times, right after itself** | The same command (Codex: `exec_command`) with nothing else called by that agent in between. A command can legitimately change its answer, for example when polling a log. |
| **at least X tokens** / **estimated** | Cost of the repeats only (the first call is not waste). "at least" because some repeat had no reported cost; **tokens not reported** when none had (never shown as 0). |
| **N calls had no input details and were not compared** | A Read, Glob or Bash call arrived without the input needed to compare it. It is counted apart, not guessed. |
| **Tracking limit reached: this list is a lower bound** | More distinct calls than the ledger holds (4000) were seen; later ones are not tracked, so the list may be missing repeats. |
| **N more not shown** | Only the 20 costliest rows are drawn. |

Only Read, Glob and Bash/`exec_command` are compared, because their input summary keeps every argument. Grep and the other tools are never compared: their summary drops options, so two equal summaries would not prove two equal calls. Edits made through Bash (for example `sed -i`) or outside the agent are not seen, so a re-read after one can be listed. Each row is a button that opens the file only when the path is absolute and the host can open files (VS Code); otherwise it is plain text.

- **Badge on the canvas** (#377): an agent with at least one row here (one repeat is enough, the rule above; no threshold is added) carries a double chevron (») on a dark disc on the upper-left rim of its node, with the legend row *Double chevron on a node: repeated reads or calls observed*. A loop badge takes its place when the same agent also has a loop: one badge per node. The outline adds ", repeated reads observed" (or "repeated calls observed", or "repeated reads and calls observed", following the evidence) to the agent button and a line naming the costliest row ("Repeated reads observed: read again 2 times, no edit seen in between"), without the path. The legend and the tour give the exact rules: a file read again with no edit seen in between, the same Glob run again with no write seen in between, or the same Bash command run again right after itself. A badge is proven; its absence proves nothing (tracking limit, calls not compared, events not replayed).
