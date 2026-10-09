/**
 * Shared constants for the extension.
 * Centralizes magic numbers and strings scattered across modules.
 */

// ─── Timing ──────────────────────────────────────────────────────────────────

/** How long to wait before declaring a session inactive (ms).
 *  Claude can think for several minutes with extended thinking,
 *  so this needs to be generous to avoid false "completed" state. */
export const INACTIVITY_TIMEOUT_MS = 5 * 60 * 1000 // 5 minutes

/** Interval between active-session directory scans (ms) */
export const SCAN_INTERVAL_MS = 1000

/** Plafond de sessions Codex suivies en même temps (watcher + timer chacune), comme RELAY_MAX_WATCHED_SESSIONS côté Claude */
export const CODEX_MAX_WATCHED_SESSIONS = 25

/** Un transcript ancien sans sous-agent actif n'est réexaminé (stat) que tous les N scans (soit N x SCAN_INTERVAL_MS) ;
 *  une écriture sur son fichier est vue tout de suite par le watcher de dossier. */
export const COLD_RESCAN_CYCLES = 30

/** Fallback poll interval when fs.watch might miss events (ms) */
export const POLL_FALLBACK_MS = 3000

/** Delay before assuming a pending tool is waiting for permission (ms).
 *  Must be long enough that normal tool execution won't trigger it. */
export const PERMISSION_DETECT_MS = 5000

/** JSONL files modified within this many seconds are considered active
 *  at discovery time. Must be longer than INACTIVITY_TIMEOUT_MS to avoid
 *  dropping sessions during long thinking pauses.
 *
 *  Filter is discovery-time only — stale sessions that receive new writes
 *  refresh their mtime and are picked up by the next scan tick
 *  (SCAN_INTERVAL_MS). A user resuming a long-idle session should see it
 *  attach within ~1s of their next message. */
export const ACTIVE_SESSION_AGE_S = 10 * 60 // 10 minutes

/** Duration of VS Code status bar messages (ms) */
export const STATUS_MESSAGE_DURATION_MS = 5000

/** Max retries for iframe bridge initialization */
export const BRIDGE_INIT_MAX_RETRIES = 50

/** Interval between bridge init retries (ms) */
export const BRIDGE_INIT_RETRY_MS = 100

/** Default dev server port */
export const DEFAULT_DEV_PORT = 3002

/** Default SSE relay port (used by dev relay, standalone app, and webview build) */
export const DEFAULT_RELAY_PORT = 3001

/** Accept CORS requests from any localhost origin during dev — Next.js falls
 *  back to a higher port when 3000 is taken, so a single hard-coded value
 *  would silently break dev. The relay binds to 127.0.0.1 already, so this
 *  pattern is safe (no external origin can reach it). */
export const DEV_WEB_ORIGIN_PATTERN = /^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/

/** Returned by HookServer.start() when the port is already in use by another instance */
export const HOOK_SERVER_NOT_STARTED = -1

/** Maximum HTTP request body size for hook server (bytes) */
export const HOOK_MAX_BODY_SIZE = 1024 * 1024 // 1 MB

/** Hook timeout value written to settings.json (seconds) */
export const HOOK_TIMEOUT_S = 2

/** Safety margin subtracted from hook timeout to guarantee exit before kill (ms) */
export const HOOK_SAFETY_MARGIN_MS = 500

/** Timeout for HTTP requests in hook forwarding script (ms) */
export const HOOK_FORWARD_TIMEOUT_MS = 1000

/** Length of workspace hash prefix used in discovery file names */
export const WORKSPACE_HASH_LENGTH = 16

/** Nonce length for CSP nonce generation */
export const NONCE_LENGTH = 32

/** Characters used for CSP nonce generation */
export const NONCE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

// ─── Webview Colors ─────────────────────────────────────────────────────────

/** Void background color — matches the web COLORS.void value */
export const WEBVIEW_BG_COLOR = '#050510'

/** Loading screen text color (dev mode only) */
export const WEBVIEW_LOADING_TEXT = '#66ccff80'

/** Loading screen dim text color (dev mode only) */
export const WEBVIEW_LOADING_TEXT_DIM = '#66ccff40'

// ─── Text Truncation Limits ──────────────────────────────────────────────────

/** Tool call preview (tool_call_start preview field) */
export const PREVIEW_MAX = 60

/** Tool args / command summaries */
export const ARGS_MAX = 80

/** Tool result summaries */
export const RESULT_MAX = 200

/** Message content sent to the webview */
export const MESSAGE_MAX = 2000

/** Session tab label */
export const SESSION_LABEL_MAX = 14

/** Truncated label text (label - ellipsis) */
export const SESSION_LABEL_TRUNCATED = SESSION_LABEL_MAX - 2

/** Max length of a session name (custom-title / ai-title) used as label */
export const SESSION_TITLE_MAX = 40

/** File path in discovery labels */
export const DISCOVERY_LABEL_MAX = 40

/** File path tail when truncated (DISCOVERY_LABEL_MAX - 3 for '...') */
export const DISCOVERY_LABEL_TAIL = DISCOVERY_LABEL_MAX - 3

/** Discovery result preview */
export const DISCOVERY_CONTENT_MAX = 100

/** Task description preview */
export const TASK_MAX = 60

/** Edit content preview (old_string/new_string) */
export const EDIT_CONTENT_MAX = 500

/** WebFetch prompt preview */
export const WEB_FETCH_PROMPT_MAX = 200

/** Subagent child name max */
export const CHILD_NAME_MAX = 30

/** Skill name max */
export const SKILL_NAME_MAX = 40

/** WebFetch URL path max */
export const URL_PATH_MAX = 40

/** Session ID display truncation */
export const SESSION_ID_DISPLAY = 8

/** Failed tool result prefix max */
export const FAILED_RESULT_MAX = 100

// ─── Token Estimation ────────────────────────────────────────────────────────

/** Rough chars-per-token ratio for estimation */
export const CHARS_PER_TOKEN = 4

/** Minimum token estimate for any tool result */
export const MIN_TOKEN_ESTIMATE = 10

/** Fallback token estimate when content type is unknown */
export const FALLBACK_TOKEN_ESTIMATE = 200

/** Token multiplier for Grep/Glob results (partial content) */
export const GREP_TOKEN_MULTIPLIER = 0.5

/** Token multiplier for other tool results */
export const DEFAULT_TOKEN_MULTIPLIER = 0.3

/** Base system prompt token estimate */
export const SYSTEM_PROMPT_BASE_TOKENS = 5000

/** Message hash prefix max (for dedup hashing) */
export const HASH_PREFIX_MAX = 200

// ─── Strings ─────────────────────────────────────────────────────────────────

/** Hook server listen address */
export const HOOK_SERVER_HOST = '127.0.0.1'

/** URL prefix for hook server on localhost */
export const HOOK_URL_PREFIX = `http://${HOOK_SERVER_HOST}:`

/** Default agent name for the main orchestrator */
export const ORCHESTRATOR_NAME = 'orchestrator'

/** File-related tools that generate discovery events */
export const FILE_TOOLS = ['Read', 'Edit', 'Write', 'Glob', 'Grep'] as const

/** Pattern-based tools (discovery type = 'pattern' instead of 'file') */
export const PATTERN_TOOLS = ['Glob', 'Grep'] as const

// ─── Utilities ───────────────────────────────────────────────────────────────

/** Suffix length used when building subagent names from IDs */
export const SUBAGENT_ID_SUFFIX_LENGTH = 6

/** Generate a consistent fallback name for a subagent when no explicit name is available.
 *  @param id  An identifier string (e.g. agent_id or a timestamp) — the last chars are used.
 *  @param index  A 1-based index for sequential numbering. */
export function generateSubagentFallbackName(id: string, index: number): string {
  return `subagent-${id.length > SUBAGENT_ID_SUFFIX_LENGTH ? id.slice(-SUBAGENT_ID_SUFFIX_LENGTH) : index}`
}

/** Extract a child agent name from a tool_use input block (Agent or Task tool).
 *  Used by both live processing and prescan to avoid duplicating the extraction logic. */
export function resolveSubagentChildName(input: Record<string, unknown>): string {
  // A named Agent call (Agent Team teammates are spawned with `name`; team_name only shows up in the
  // result): the member name is its identity, the description is just a task label.
  if (typeof input.name === 'string' && input.name.trim()) {
    return input.name.trim().slice(0, CHILD_NAME_MAX)
  }
  return String(input.description || input.subagent_type || 'subagent').slice(0, CHILD_NAME_MAX)
}

/** Prefixes that identify system-injected content (not real user messages).
 *  Used by both Claude Code (transcript-parser.ts) and Codex
 *  (codex-rollout-parser.ts extractCodexUserText), so additions here
 *  widen filtering for both runtimes.
 *  Codex also has its own extraction logic because the injection format
 *  is structurally different (e.g. real prompts wrapped inside a
 *  "# Context from my IDE setup:" block, reachable via the
 *  "## My request for Codex:" marker). */
export const SYSTEM_CONTENT_PREFIXES = [
  'This session is being continued',
  '<ide_',
  '<system-reminder',
  '<available-deferred-tools',
  '<command-name',
  '<system_instruction',
  '<task-notification',
  '<teammate-message',
  '<local-command-stdout',
  '<local-command-caveat',
] as const

// ─── Resource limits (hook server + relay) ───────────────────────────────────
// All of these bound memory/CPU for untrusted local input (hook POSTs, SSE
// clients, transcript files). See hook-guards.ts and relay-guards.ts.

/** Max bytes of request headers accepted by the hook server */
export const HOOK_MAX_HEADER_BYTES = 8 * 1024
/** Max simultaneous TCP connections to the hook server */
export const HOOK_MAX_CONNECTIONS = 64
/** Max requests served over one keep-alive hook connection */
export const HOOK_MAX_REQUESTS_PER_SOCKET = 100
/** Time allowed to receive a full hook request (headers + body) */
export const HOOK_REQUEST_TIMEOUT_MS = 5000
/** Interval of Node's expired-connection sweep (default 30s) — bounds how long a stalled request holds a socket.
 *  Applies to the hook server, the standalone app server and the dev relay. */
export const HTTP_CONNECTIONS_CHECK_INTERVAL_MS = 1000
/** Token bucket per client address: burst capacity and sustained refill (tokens/s) */
export const HOOK_RATE_IP_BURST = 200
export const HOOK_RATE_IP_PER_S = 100
/** Token bucket per session_id */
export const HOOK_RATE_SESSION_BURST = 100
export const HOOK_RATE_SESSION_PER_S = 50
/** Max distinct rate-limit buckets tracked (oldest evicted) */
export const HOOK_RATE_MAX_BUCKETS = 512
/** Max length of session_id / tool_use_id and of agent_id / agent_type in hook payloads */
export const HOOK_ID_MAX_LENGTH = 128
export const HOOK_AGENT_FIELD_MAX_LENGTH = 64
/** Max length of free-text hook fields (message, title, tool_name, paths) */
export const HOOK_TEXT_MAX_LENGTH = 4096
/** Max sessions / per-session agents + dispatches tracked by the hook server */
export const HOOK_MAX_SESSIONS = 256
export const HOOK_MAX_TRACKED_PER_SESSION = 256

/** SubagentStop transcript read: tail bytes, timeout, concurrency and queue bound */
export const SUBAGENT_TRANSCRIPT_TAIL_BYTES = 128 * 1024
export const SUBAGENT_TRANSCRIPT_TIMEOUT_MS = 750
export const SUBAGENT_TRANSCRIPT_CONCURRENCY = 1
export const SUBAGENT_TRANSCRIPT_MAX_QUEUE = 16

/** Max simultaneous SSE clients on the relay (extra clients get 503) */
export const RELAY_MAX_SSE_CLIENTS = 32
/** The relay writes a keep-alive to every SSE client this often (ms); the web client mirrors it (a test compares them) */
export const RELAY_SSE_HEARTBEAT_MS = 15_000
/** Drop an SSE client whose unsent backlog (res.writableLength) exceeds this many bytes */
export const RELAY_MAX_CLIENT_BACKLOG_BYTES = 1024 * 1024
/** Max events replayed to a client per session, and in total, on connect */
export const RELAY_MAX_REPLAY_PER_SESSION = 2000
export const RELAY_MAX_REPLAY_TOTAL = 10000
/** Events per replay batch message */
export const RELAY_REPLAY_BATCH_SIZE = 500
/** In-memory event buffer bounds: per session, number of sessions, total events */
export const RELAY_MAX_EVENTS_PER_SESSION = 5000
export const RELAY_MAX_BUFFERED_SESSIONS = 50
export const RELAY_MAX_BUFFERED_EVENTS_TOTAL = 50000
/** Max sessions with live file watchers / timers */
export const RELAY_MAX_WATCHED_SESSIONS = 25
/** Max length of the ?session= query parameter */
export const RELAY_SESSION_PARAM_MAX_LENGTH = 128
/** Discovery caps (--all-workspaces): project dirs scanned, files per dir, max transcript size */
export const RELAY_MAX_PROJECT_DIRS = 200
export const RELAY_MAX_FILES_PER_DIR = 500
export const RELAY_MAX_SESSION_FILE_BYTES = 256 * 1024 * 1024

// ─── Teammates / inter-agent messages (agent_link, message_sent) ─────────────
// Content comes from transcripts (untrusted): it is stripped of control chars and capped.

/** Max chars of a message_sent content field (same cap as MESSAGE_MAX) */
export const TEAM_MESSAGE_MAX = 2000
/** Max chars of an agent name taken from teammate data (to, teammate_id, task id) */
export const TEAM_NAME_MAX = 64
/** Max length of a generated linkId */
export const TEAM_LINK_ID_MAX = 160
/** Max chars of a user-turn text scanned for <teammate-message>/<task-notification> tags */
export const TEAM_NOTIFICATION_SCAN_MAX = 64 * 1024
/** Max notifications extracted from a single user turn */
export const TEAM_NOTIFICATIONS_PER_TURN_MAX = 20
/** Max distinct links remembered per session for agent_link dedup (oldest evicted) */
export const TEAM_MAX_LINKS_PER_SESSION = 256

// ─── Agent Teams (teammates, team config, inboxes) ───────────────────────────
// Everything under ~/.claude/teams and the teammate sidechains is untrusted local input.
// Every limit below is covered by extension/test/teams-limits.test.ts.

/** In-process teammates: a file written less than this many ms ago still counts as 'working' */
export const TEAMMATE_RECENT_WRITE_MS = 15_000
/** A teammate whose turn did not end but that has no pending tool and no write for this long is shown 'idle' */
export const TEAMMATE_STALE_WORKING_MS = 90_000
/** History replay on first discovery of a teammate: the last N user/assistant entries only */
export const TEAMMATE_REPLAY_MAX_MESSAGES = 40
/** History replay reads at most this many bytes from the END of the teammate transcript */
export const TEAMMATE_REPLAY_MAX_BYTES = 1024 * 1024
/** Max teammates announced per session (extra sidechains behave like ordinary subagents) */
export const TEAMMATE_MAX_PER_SESSION = 64
/** Max size of a subagent .meta.json sidecar that is read */
export const TEAMMATE_META_MAX_BYTES = 64 * 1024
/** Max chars of model / agent type / team name fields copied from sidecars and configs */
export const TEAM_FIELD_MAX = 64

/** Team config scan: poll interval, debounce of team_info and bounds */
export const TEAM_SCAN_INTERVAL_MS = 2000
export const TEAM_INFO_DEBOUNCE_MS = 750
export const TEAM_MAX_TEAMS = 50
export const TEAM_MAX_MEMBERS = 64
export const TEAM_CONFIG_MAX_BYTES = 256 * 1024
/** Inbox watching: files per team, bytes per file, messages kept per file, remembered keys per inbox */
export const TEAM_INBOX_MAX_FILES = 64
export const TEAM_INBOX_MAX_BYTES = 512 * 1024
export const TEAM_INBOX_MAX_MESSAGES = 200
export const TEAM_INBOX_SEEN_MAX = 1024
/** Historical messages replayed from an inbox the first time it is seen (the rest is only remembered) */
export const TEAM_INBOX_FIRST_SCAN_MAX = 20
/** Lifecycle events (agent_spawn, team_info...) a replay buffer keeps even when it overflows with chatter */
export const RELAY_REPLAY_LIFECYCLE_RESERVE = 400
/** The same text on the same link seen again within this window is one message (transcript + inbox echo) */
export const TEAM_DEDUPE_WINDOW_MS = 60_000
/** Max remembered (link, text) keys per session for that dedupe */
export const TEAM_DEDUPE_MAX_ENTRIES = 512
/** A tmux member session is matched to a config member when it started within this window after joinedAt */
export const TEAM_JOIN_MATCH_WINDOW_MS = 120_000
// ─── Workflow groups (Workflow tool runs, #79) ───────────────────────────────
// subagents/workflows/<wf_id>/ is untrusted local input like everything else under ~/.claude.
// Every limit below is covered by extension/test/workflow-group.test.ts.

/** Workflow agents: a transcript written less than this many ms ago is 'working' */
export const WORKFLOW_RECENT_WRITE_MS = 15_000
/** Workflow agents: a finished turn (final text, no pending tool) with no write for this long is 'done' */
export const WORKFLOW_DONE_QUIET_MS = 60_000
/** Max agents announced per workflow (the most recently written transcripts win) */
export const WORKFLOW_MAX_AGENTS = 200
/** Max workflows followed per session (the most recently written folders win) */
export const WORKFLOW_MAX_PER_SESSION = 20
/** Max bytes read from the END of a workflow journal.jsonl */
export const WORKFLOW_JOURNAL_MAX_BYTES = 1024 * 1024
/** Max agent ids remembered from one journal */
export const WORKFLOW_JOURNAL_MAX_IDS = 1000
/** Max chars of a workflow phase label */
export const WORKFLOW_PHASE_MAX = 40
/** Max entries read from workflows/scripts to find the workflow name */
export const WORKFLOW_SCRIPTS_MAX_ENTRIES = 500
/** Agent type reported for every workflow agent */
export const WORKFLOW_AGENT_TYPE = 'workflow-subagent'

/** Bytes read from the head of a session transcript to learn its cwd / start time */
export const SESSION_HEADER_MAX_BYTES = 16 * 1024
/** Max chars of team/member/runtime/workspace tags on session list entries */
export const SESSION_TAG_MAX = 256

// ─── Optional session index (read-only adapter) ─────────────────────────────

/** Rows read from the index when the configuration gives no bound */
export const SESSION_INDEX_DEFAULT_MAX_ROWS = 200
/** Upper bound of the configurable row limit */
export const SESSION_INDEX_HARD_MAX_ROWS = 5000
/** Busy timeout when opening / reading the index (ms) */
export const SESSION_INDEX_TIMEOUT_MS = 1000

// ─── Relay /status endpoint ──────────────────────────────────────────────────

/** Token bucket per client address for GET /status: burst and sustained refill (tokens/s) */
export const RELAY_STATUS_RATE_BURST = 20
/** GET /issue-links (#63): each call may run gh, so it is limited harder than /status, and answers are cached */
export const RELAY_ISSUE_LINKS_RATE_BURST = 30
export const RELAY_ISSUE_LINKS_RATE_PER_S = 2
export const RELAY_ISSUE_LINKS_CACHE_TTL_MS = 60_000
export const RELAY_ISSUE_LINKS_CACHE_MAX_ROLES = 64
/** Max `gh` processes running at once for /issue-links (a cache miss beyond it is refused with 503) */
export const RELAY_ISSUE_LINKS_MAX_GH_IN_FLIGHT = 2
/** Max new `gh` runs (cache misses) started per window, whatever the rate-limiter key */
export const RELAY_ISSUE_LINKS_MAX_PROBES_PER_WINDOW = 20
export const RELAY_ISSUE_LINKS_PROBE_WINDOW_MS = 60_000
/** Default freshness of the session index cache (ms) */
export const RELAY_SESSION_INDEX_CACHE_MS = 30_000
export const RELAY_STATUS_RATE_PER_S = 5
/** Max distinct clients tracked by the /status rate limiter */
export const RELAY_STATUS_RATE_MAX_KEYS = 64

// ─── Settings files ──────────────────────────────────────────────────────────

/** Max size of a Claude settings.json read to detect configured hooks (bigger files are ignored) */
export const SETTINGS_FILE_MAX_BYTES = 1024 * 1024

// ─── Source reconciliation (hooks vs JSONL) and hardened local server ────────
// Block owned by the relay-sources package (issues #53, #68).

/** Time bucket (seconds) used to derive a stable id for lifecycle events that carry no tool_use_id / explicit id */
export const EVENT_ID_TIME_BUCKET_S = 2
/** Max chars of a payload fed to the content hash of a derived event id */
export const EVENT_ID_HASH_INPUT_MAX = 2000
/** Max length of an explicit event id taken from a payload */
export const EVENT_ID_EXPLICIT_MAX = 128
/** Delivered event ids remembered per session for cross-source deduplication (oldest forgotten first) */
export const EVENT_DEDUP_MAX_PER_SESSION = 4096
/** Max sessions whose delivered ids are remembered */
export const EVENT_DEDUP_MAX_SESSIONS = 64
/** Max events held while a history load is in progress (the hold is flushed early beyond this) */
export const EVENT_HOLD_MAX = 50000

/** Env var selecting the relay/app port: "0" asks the OS for an ephemeral port */
export const ENV_AGENT_LENS_PORT = 'AGENT_LENS_PORT'
/** Port value that asks the OS for an ephemeral port */
export const EPHEMERAL_PORT = 0
/** Loopback address every local server binds to */
export const LOOPBACK_HOST = '127.0.0.1'
/** HTTP methods the local servers accept (anything else gets 405) */
export const SERVER_ALLOWED_METHODS = ['GET', 'HEAD', 'OPTIONS'] as const
/** Content-Security-Policy of API / SSE / error responses: nothing may load or run */
export const CSP_API = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
/** Content-Security-Policy of the static app shell: same-origin assets only, no framing, no forms */
export const CSP_STATIC_APP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"

// ─── Input normalization caps (event-normalize.ts, mirrored by web/lib/event-normalize.ts) ──

/** Longest free-text field (message, result, task, ...) kept after normalization. */
export const NORM_TEXT_MAX = 4096
/** Longest identifier-like field (agent name, tool_use id, link id, ...). */
export const NORM_ID_MAX = 160
/** Largest absolute value kept for a number (tokens, cost, ...); beyond it the value is clamped. */
export const NORM_NUM_MAX = 1e12
/** Largest event time kept (seconds since session start): about ten years. */
export const NORM_EVENT_TIME_MAX_S = 10 * 365 * 24 * 3600
/** Largest epoch-ms timestamp considered plausible (2100-01-01). */
export const NORM_TS_MAX_MS = 4_102_444_800_000
/** Deepest nesting kept inside a payload; deeper values are dropped. */
export const NORM_MAX_DEPTH = 6
/** Longest array kept inside a payload. */
export const NORM_MAX_ARRAY = 256
/** Most keys kept per object inside a payload. */
export const NORM_MAX_KEYS = 128
/** Children one agent may have per session; further spawns are dropped. */
export const NORM_MAX_CHILDREN_PER_AGENT = 256
/** Nodes (agents) one session may have; further spawns are dropped. */
export const NORM_MAX_NODES_PER_SESSION = 512
/** Events accepted from one batch; the rest of the batch is ignored. */
export const NORM_MAX_EVENTS_PER_BATCH = 1000
/** Longest JSONL line parsed (UTF-16 units); longer lines count as malformed. */
export const NORM_MAX_LINE_CHARS = 4 * 1024 * 1024
/** Remembered keys for duplicate detection, per session (oldest forgotten first). */
export const NORM_MAX_SEEN_KEYS = 4096
/** Dropped node names remembered per session so their later events are ignored too. */
export const NORM_MAX_DROPPED_NAMES = 1024
/** Minimum delay between two normalization_stats events of one session (ms). */
export const NORM_STATS_MIN_INTERVAL_MS = 1000
/** Longest object key kept inside a payload; entries with a longer key are dropped (counted). */
export const NORM_KEY_MAX = 128
/** Known agent names remembered per session (valid parents), spawned or seen acting. */
export const NORM_MAX_KNOWN_AGENTS = 1024
/** Sessions whose shared normalization counters are tracked at once (oldest forgotten first). */
export const NORM_MAX_TRACKED_SESSIONS = 256

// ─── Project context (CLAUDE.md, memory) ─────────────────────────────────────

/** Max bytes read per context file (CLAUDE.md, MEMORY.md); the head is kept and truncation is reported */
export const PROJECT_CONTEXT_MAX_FILE_BYTES = 64 * 1024
/** Max issue references (#n) extracted from the context files */
export const PROJECT_CONTEXT_MAX_ISSUES = 50
/** Token bucket per client address for GET /context: burst and sustained refill (tokens/s) */
export const RELAY_CONTEXT_RATE_BURST = 10
export const RELAY_CONTEXT_RATE_PER_S = 2

// ─── Shared state snapshots (#71) and observations (#72) ─────────────────────

/** Version of the snapshot envelope; a reader refuses any other value */
export const SNAPSHOT_SCHEMA_VERSION = 1
/** A snapshot file (and its payload once serialized) never exceeds this; bigger files are refused on read */
export const SNAPSHOT_MAX_BYTES = 256 * 1024
/** Nesting / array / key bounds of a snapshot payload */
export const SNAPSHOT_MAX_DEPTH = 8
export const SNAPSHOT_MAX_ARRAY_LENGTH = 1000
export const SNAPSHOT_MAX_KEYS = 200
/** A snapshot older than this is stale (same threshold as a silent agent on the canvas: STALE_AFTER_MS of web/lib/canvas-constants.ts, a test compares them) */
export const SNAPSHOT_STALE_AFTER_MS = 30_000
/** A snapshot dated further than this in the future is rejected (clock skew we cannot prove) */
export const SNAPSHOT_FUTURE_TOLERANCE_MS = 5_000

/** Observations action: caps on what is returned to Claude */
export const OBSERVATIONS_MAX_SESSIONS = 25
export const OBSERVATIONS_MAX_AGENTS_PER_SESSION = 50
export const OBSERVATIONS_NAME_MAX = 64
