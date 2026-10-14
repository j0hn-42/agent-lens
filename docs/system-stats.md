# System panel

Health of the machine that runs the relay, next to the agents that run on it (#357). Same principle as the rest of the UI ([reading-the-ui.md](reading-the-ui.md)): a figure that was not measured is not shown.

## Opening it

- Top bar: the **System** button.
- Keyboard: **Y** (a single-key shortcut, so it follows the single-key preference of the shortcuts dialog), or **System** in the command palette (Ctrl+K), which works even with single-key shortcuts off.
- The panel docks at the bottom left, just above the control bar, and opens at a size that shows everything it holds (the per-core detail scrolls). Drag its top edge to change its height and its right edge to change its width, or focus the two sliders ("Resize system panel height" / "Resize system panel width") and use the arrow keys, PageUp / PageDown, Home and End. The size is kept until the page is reloaded. It does not close the other panels. Closing it returns the focus to where it was.

## What is measured, and from where

All values describe the machine that runs the relay, sampled every 2 seconds.

| Row | Source |
|---|---|
| **CPU** | Delta between two readings of `os.cpus()` (share of non-idle time), aggregate and per core. The first sample has no delta, so CPU is not available until the second one. |
| **Memory** | Linux: `MemTotal - MemAvailable` from `/proc/meminfo` (the cache is not counted as used). Windows: `os.totalmem() - os.freemem()` (free memory there is the available physical memory). macOS: not available, because the free pages Node reports exclude the cache and would make a healthy Mac read 90-99 % used. Linux without `MemAvailable`: not available. |
| **Swap** | `SwapTotal` and `SwapFree` from `/proc/meminfo`. A swap of size 0 reads "No swap", not 0 %. Outside Linux (only `/proc/meminfo` is read): not available. |
| **Disk** | `fs.statfs` on the relay's working directory (used = blocks - blocks available to the user). |
| **Load 1 / 5 / 15** | `os.loadavg()`. Not available on Windows. |
| **Uptime** | `os.uptime()`. |

Any metric that cannot be read is **Not available**, with no meter. It is never shown as 0.

## Severity

Each row carries a severity, said in text and in an icon, never by colour alone:

| Severity | When |
|---|---|
| **Normal** | below 85 % |
| **Warm** | from 85 % |
| **Critical** | from 95 % |
| **Not available** | the metric is null |

The percentage is floored, so "85 %" is always Warm or worse and "95 %" always Critical. The bytes are shown next to the percentage. A polite announcement is made only when the severity of a metric changes while the panel is open; the 2-second updates themselves are silent.

## History

Each row has a sparkline of the last 60 points (about 2 minutes), with a text summary (current value and recent maximum). The history lives in the page's memory only: the relay keeps none, nothing is written to disk, and it is cleared when the connection to the relay is lost. A client that connects (or reconnects) shows its first value after about 2 seconds. A **Per-core detail** section, collapsed by default, lists each logical CPU ("256+ logical CPUs" when the list reaches the 256 cap).

## Limits

- **WSL2.** Inside WSL2 the values are those of the Linux VM, not of Windows. The panel says so in a note.
- **Loopback only.** The relay broadcasts the samples to local clients only. A tunnel Host client never receives them, and a tunnel alone does not start the sampling timer (the same rule as `/launch`, see [launch-security.md](launch-security.md)). The timer runs only while a local client is connected.
- **Not available inside VS Code and in demo mode.** The metrics come from the standalone relay; the panel says so instead of showing gauges.
- Not measured: per-process usage (`claude`, `node`), GPU, temperature, network.
