// ─── Model families ──────────────────────────────────────────────────────────

/** Single source of truth for Claude model families. Display names
 *  (formatModelName in utils.ts), context-window sizes, and cost rates all
 *  derive from this table — add new families here and nowhere else.
 *  Rates are blended $/M-token (0.75 × input + 0.25 × output per-MTok). */
export const CLAUDE_FAMILIES: ReadonlyArray<{ name: string; context: number; rate: number }> = [
  { name: 'fable',  context: 1_000_000, rate: 20 }, // $10 in / $50 out
  { name: 'mythos', context: 1_000_000, rate: 20 }, // $10 in / $50 out
  { name: 'opus',   context: 1_000_000, rate: 10 }, // $5 in / $25 out
  { name: 'sonnet', context: 1_000_000, rate: 6 },  // $3 in / $15 out
  { name: 'haiku',  context: 200_000,   rate: 2 },  // $1 in / $5 out
]

/** Regex alternation fragment of all Claude family names (e.g. 'fable|mythos|…'). */
export const CLAUDE_FAMILY_ALTERNATION = CLAUDE_FAMILIES.map(f => f.name).join('|')

/** Context window size by model family. Patterns are checked in order;
 *  first match wins. Matched against lower-cased model IDs. */
export const MODEL_FAMILY_CONTEXT: ReadonlyArray<{ pattern: RegExp; size: number }> = [
  ...CLAUDE_FAMILIES.map(f => ({ pattern: new RegExp(`${f.name}(?:-\\d|$)`), size: f.context })),
  // Codex/GPT models. Fallback only — Codex normally reports its own
  // authoritative window via event_msg.token_count.info.model_context_window.
  { pattern: /gpt-\d/, size: 400_000 },
]
/** Used when no family pattern matches (unknown model). */
export const DEFAULT_CONTEXT_SIZE = 200_000
/** Used when no model ID is available at all. */
export const FALLBACK_CONTEXT_SIZE = 1_000_000

// ─── Visibility threshold ───────────────────────────────────────────────────

/** Minimum opacity for an element to be considered visible (used for edge/draw culling) */
export const MIN_VISIBLE_OPACITY = 0.05

// ─── Agent spawn distance ───────────────────────────────────────────────────

export const AGENT_SPAWN_DISTANCE = 250

// ─── Tool call dedup window (seconds) ──────────────────────────────────────

export const TOOL_DEDUP_WINDOW_S = 3

// ─── LocalStorage keys ─────────────────────────────────────────────────────

export const SOUND_PREF_KEY = 'agent-viz-sound'

// ─── Mock scenario buffer ──────────────────────────────────────────────────

export const MOCK_END_BUFFER_S = 8

// ─── Canvas drawing constants ────────────────────────────────────────────────

/** Seconds a message bubble stays fully visible */
export const BUBBLE_HOLD = 10
/** Seconds for bubble fade-in animation */
export const BUBBLE_FADE_IN = 0.3
/** Seconds for bubble fade-out animation */
export const BUBBLE_FADE_OUT = 1.5
/** Maximum width (px) of a message bubble */
export const BUBBLE_MAX_W = 260
/** Vertical gap (px) between stacked bubbles */
export const BUBBLE_GAP = 6
/** Max visible lines in a bubble before truncation */
export const BUBBLE_MAX_LINES = 8

/** Tool card width (px) for overlap detection */
export const TOOL_CARD_W = 210
/** Tool card height (px) for overlap detection */
export const TOOL_CARD_H = 44

// ─── Animation timing constants ─────────────────────────────────────────────

/** Seconds a completed tool call stays visible before fading */
export const TOOL_MIN_DISPLAY_S = 4.0
/** Default seconds without an observed end before a running tool call becomes `expired` (a long Bash or a sub-agent legitimately runs for minutes) */
export const TOOL_EXPIRY_S = 300
/** Delays the user can pick for the orphan-call expiry */
export const TOOL_EXPIRY_CHOICES_S = [60, 120, 300, 600, 1800] as const
export const TOOL_EXPIRY_KEY = 'agent-viz-tool-expiry-s'

/** Reads a stored expiry delay; anything that is not one of the offered choices falls back to the default. */
export function parseToolExpiryS(raw: string | null | undefined): number {
  const n = Number(raw)
  return (TOOL_EXPIRY_CHOICES_S as readonly number[]).includes(n) ? n : TOOL_EXPIRY_S
}

/** Live setting read by the simulation on each frame and each seek (set from the canvas controls). */
export const toolExpiryConfig = { seconds: TOOL_EXPIRY_S }

/** Loads the stored delay into the live setting and returns it (storage may be unavailable). */
export function loadToolExpiryS(): number {
  try { toolExpiryConfig.seconds = parseToolExpiryS(window.localStorage.getItem(TOOL_EXPIRY_KEY)) } catch { /* default */ }
  return toolExpiryConfig.seconds
}

/** Applies and stores a new delay; a value outside the choices falls back to the default. */
export function setToolExpiryS(seconds: number): number {
  const next = parseToolExpiryS(String(seconds))
  toolExpiryConfig.seconds = next
  try { window.localStorage.setItem(TOOL_EXPIRY_KEY, String(next)) } catch { /* storage unavailable */ }
  return next
}
/** Seconds a discovery card stays visible before fading */
export const DISCOVERY_HOLD_S = 8
/** Speed multiplier for discovery lerp toward target position */
export const DISCOVERY_LERP_SPEED = 3
/** Seconds a message bubble is considered visible (for pruning) */
export const BUBBLE_VISIBLE_S = 12


// ─── Animation speed multipliers ─────────────────────────────────────────────
// Multiplied by deltaTime in the animation loop

export const ANIM_SPEED = {
  /** Agent fade-in (opacity per dt) */
  agentFadeIn: 3,
  /** Agent scale-in (scale per dt) */
  agentScaleIn: 4,
  /** Agent fade-out after complete (opacity per dt) */
  agentFadeOut: 0.4,
  /** Agent scale-out after complete (scale per dt) */
  agentScaleOut: 0.05,
  /** Tool fade-in (opacity per dt) */
  toolFadeIn: 4,
  /** Tool fade-out after complete/visible (opacity per dt) */
  toolFadeOut: 1.5,
  /** Edge fade-in (opacity per dt) */
  edgeFadeIn: 4,
  /** Discovery fade-in (opacity per dt) */
  discoveryFadeIn: 2,
  /** Discovery fade-out after hold expires (opacity per dt) */
  discoveryFadeOut: 0.5,
  /** Particle speed multiplier */
  particleSpeed: 1.2,
  /** Default delta time cap (seconds) */
  maxDeltaTime: 0.1,
  /** Default delta time when time info unavailable */
  defaultDeltaTime: 0.016,
  /** Minimum ms between frames (60fps cap, with 1ms slack for timing jitter) */
  minFrameInterval: (1000 / 60) - 1,
} as const

// ─── UI panel constants ─────────────────────────────────────────────────────

/** Distance from bottom (px) before a scroll container is considered "at bottom" */
export const AUTO_SCROLL_THRESHOLD = 60

// ─── Camera / interaction constants ─────────────────────────────────────────

export const CAMERA = {
  zoomStepDown: 0.92,
  zoomStepUp: 1.08,
  /** Floor of the interactive zoom AND of the zoom-to-fit (FIT_MIN_SCALE): dozens of clusters fit at this scale */
  minZoom: 0.04,
  maxZoom: 4,
  /** Pixels moved by one Shift+arrow press */
  keyboardPanStep: 48,
  /** Multiplier applied by the keyboard / button zoom controls */
  keyboardZoomStep: 1.25,
  velocityScale: 0.016,
} as const

// ─── Force simulation config ────────────────────────────────────────────────

export const FORCE = {
  chargeStrength: -1200,
  collideRadius: 140,
  linkDistance: 350,
  linkStrength: 0.4,
  alphaDecay: 0.02,
  velocityDecay: 0.4,
} as const

// ─── Fleet layout (clusters of agents in the 'All' view) ────────────────────

export const CLUSTER_LAYOUT = {
  /** Disc radius of a cluster = baseRadius + members * memberSpacing */
  baseRadius: 300,
  memberSpacing: 30,
  maxMembers: 100,
  /** Free space kept between two cluster discs */
  gap: 80,
  /** Up to this many clusters sit on a ring, more on a phyllotaxis spiral */
  maxRingClusters: 8,
  /** Share of the distance a lead (orchestrator) covers towards its anchor, per tick */
  holdStrength: 0.15,
  /** Weak pull of members to the anchor (times alpha) */
  pullStrength: 0.02,
  /** Archived agents drift to this fraction of the cluster radius */
  archivedRingFactor: 0.85,
  ringStrength: 0.06,
  /** Members are kept within this fraction of the cluster radius */
  containFactor: 0.95,
} as const

// ─── Tool slot placement config ─────────────────────────────────────────────

export const TOOL_SLOT = {
  maxRings: 5,
  baseDistance: 100,
  ringIncrement: 35,
  baseSteps: 5,
  stepsPerRing: 2,
  fallbackDistance: 90,
} as const

// ─── Discovery card dimension helpers ───────────────────────────────────────

export const DISC_CHAR_W = 6.6
export const DISC_LABEL_CHAR_W = 7.2
export const DISC_MIN_W = 80
export const DISC_MAX_W = 200
export const DISC_PADDING = 16
export const DISC_HEADER_H = 20
export const DISC_LINE_H = 14

/** Half-width used for discovery card bounding box in auto-fit calculations */
export const DISC_BOUNDS_HALF_W = 100
/** Half-height used for discovery card bounding box in auto-fit calculations */
export const DISC_BOUNDS_HALF_H = 36

export function getDiscoveryCardDimensions(label: string, contentLines: string[]) {
  const maxLineWidth = Math.max(...contentLines.map(l => l.length * DISC_CHAR_W), label.length * DISC_LABEL_CHAR_W)
  const cardW = Math.min(Math.max(DISC_MIN_W, maxLineWidth + DISC_PADDING), DISC_MAX_W)
  const cardH = DISC_HEADER_H + contentLines.length * DISC_LINE_H
  return { cardW, cardH }
}

// ─── Tool card dimension constant ───────────────────────────────────────────

export const TOOL_MAX_CARD_W = 200

/** Blended $/M-token rate by model family (0.75 × input + 0.25 × output
 *  per-MTok pricing, the same weighting the original Sonnet-class rate used).
 *  Claude rates derive from CLAUDE_FAMILIES. Patterns are checked in order;
 *  first match wins. Matched against lower-cased model IDs. */
export const MODEL_FAMILY_COST: ReadonlyArray<{ pattern: RegExp; rate: number }> = [
  ...CLAUDE_FAMILIES.map(f => ({ pattern: new RegExp(`${f.name}(?:-\\d|$)`), rate: f.rate })),
  { pattern: /gpt-\d/, rate: 5 }, // gpt-5.3-codex: $1.75 in / $14 out
]

/** Blended $/M-token fallback rate for unknown models (Sonnet-class) */
export const COST_RATE = 6

// ─── Agent drawing constants ────────────────────────────────────────────────

export const AGENT_DRAW = {
  /** Offset from agent center to bubble anchor point */
  bubbleAnchorOffset: 14,
  /** Initial cursor Y offset for bubbles */
  bubbleCursorY: -20,
  /** Outer glow extra radius beyond agent radius */
  glowPadding: 20,
  /** Ambient outer hex ring offset from agent radius */
  outerRingOffset: 3,
  /** Shadow blur for depth shadow */
  shadowBlur: 15,
  shadowOffsetX: 3,
  shadowOffsetY: 5,
  /** Agent name label Y offset from agent radius */
  labelYOffset: 8,
  /** Font size of agent name and state label (canvas text minimum is 11px) */
  labelFontSize: 11,
  /** Vertical distance between the name line and the state-label line */
  stateLabelGap: 13,
  /** Width of the dark outline drawn behind label text */
  labelHaloWidth: 3,
  /** Agent name label width multiplier of radius */
  labelWidthMultiplier: 4.5,
  /** Scanline gradient half-height */
  scanlineHalfH: 4,
  /** Scanline width = 2 * scanlineHalfH */
  scanlineWidth: 8,
  /** Dash offset animation speed for waiting state */
  waitingDashSpeed: 25,
  /** Orbiting particle offset from radius */
  orbitParticleOffset: 12,
  orbitParticleSize: 1.5,
  /** Waiting state ripple inner offset from radius */
  rippleInnerOffset: 5,
  rippleMaxExpand: 45,
  rippleMaxAlpha: 0.4,
  /** Waiting state orbiting particle offset */
  waitingOrbitOffset: 14,
  waitingOrbitParticleSize: 2,
  waitingOrbitSpeed: 0.8,
  /** Waiting state breathe parameters */
  waitingBreatheSpeed: 1.2,
  waitingBreatheAmp: 0.08,
  /** Claude spark logo scale factor (relative to radius / SVG viewBox) */
  sparkScale: 0.45,
  /** SVG viewBox size for Claude spark path */
  sparkViewBox: 256,
  /** Sub-agent icon font size relative to radius */
  subIconScale: 0.45,
} as const

export const CONTEXT_BAR = {
  /** Minimum bar width */
  minWidth: 60,
  /** Bar width multiplier of radius */
  widthMultiplier: 2.2,
  barHeight: 6,
  /** Y offset from agent radius (below the name + state label lines) */
  yOffset: 36,
  borderRadius: 3,
  /** Font for token count label (canvas text minimum is 11px) */
  fontSize: 11,
  /** Y padding below bar for label */
  labelPadding: 13,
  /** Extra background height below the bar for the label */
  labelBoxExtra: 18,
} as const

export const CONTEXT_RING = {
  /** Ring offset from agent radius */
  ringOffset: 8,
  ringWidth: 4,
  /** Warning threshold ratios */
  warningThreshold: 0.8,
  criticalThreshold: 0.9,
  /** Show percentage label above this usage ratio */
  percentLabelThreshold: 0.7,
  /** Warning glow extra radius */
  glowPadding: 4,
  glowLineWidth: 2,
  glowBlur: 12,
  /** Percentage label Y offset from radius */
  percentYOffset: 10,
} as const

export const STATS_OVERLAY = {
  /** Y offset above agent radius (legacy; the live layout comes from overlay-layout.ts) */
  yOffset: 25,
  boxWidth: 124,
  boxHeight: 20,
  borderRadius: 3,
  fontSize: 11,
  textPaddingY: 4,
} as const

// ─── Tool card drawing constants ────────────────────────────────────────────

export const TOOL_DRAW = {
  fontSize: 11,
  borderRadius: 4,
  /** Extra height for completed/error cards showing token cost */
  expandedHeight: 40,
  collapsedHeight: 28,
  /** Error glow base blur + pulse amplitude */
  errorGlowBase: 8,
  errorGlowPulse: 4,
  /** Spinning ring extra radius beyond card half-size */
  spinRingPadding: 4,
  spinSpeed: 3,
  spinArc: Math.PI * 1.2,
  /** Error detail font size */
  errorFontSize: 11,
  /** Token cost font size */
  tokenFontSize: 11,
  /** Y offset for two-line card layout */
  twoLineOffset: 7,
} as const

// ─── MCP tool call drawing constants ────────────────────────────────────────

export const MCP_DRAW = {
  /** Server badge above the card */
  badgeHeight: 11,
  badgeFontSize: 9,
  badgePadX: 5,
  badgeGap: 3,
  /** Orbiting dots around a running MCP card */
  orbitDots: 3,
  orbitPadding: 8,
  orbitSpeed: 2.2,
  orbitDotSize: 2.2,
  /** Dashed rim on the calling agent */
  agentRimPadding: 6,
  agentRimDash: [3, 5] as readonly number[],
  agentRimSpeed: 18,
  /** Dotted comet trail: draw every Nth trail segment */
  trailSegmentStep: 2,
  /** Particle core size multiplier */
  particleScale: 1.25,
  /** Completion pulse (no bright flash, so it is safe for WCAG 2.3.1) */
  pulseDuration: 0.9,
  pulseRingStart: 14,
  pulseRingExpand: 46,
  pulseRings: 2,
} as const

// ─── Cost overlay drawing constants ─────────────────────────────────────────

export const COST_DRAW = {
  /** Minimum cost to display label */
  minDisplayCost: 0.0001,
  /** Cost pill Y offset above agent radius */
  pillYOffset: 22,
  pillPadding: 14,
  pillHeight: 20,
  pillRadius: 8,
  /** Mini bar height below cost pill */
  miniBarHeight: 3,
  miniBarRadius: 1.5,
  miniBarGap: 3,
  miniBarMaxExtra: 10,
  miniBarMax: 80,
} as const

export const COST_PANEL = {
  width: 232,
  /** X margin from right edge */
  xMargin: 16,
  /** Y position (below top bar) */
  yStart: 48,
  lineHeight: 18,
  headerHeight: 30,
  sectionGap: 8,
  maxRows: 5,
  borderRadius: 8,
  contentPadding: 10,
  barInset: 4,
  barRadius: 3,
} as const

// ─── Bubble drawing constants ───────────────────────────────────────────────

export const BUBBLE_DRAW = {
  thinking: { fontSize: 11, labelSize: 11, lineH: 14, padding: 6, headerH: 16 },
  normal: { fontSize: 11, labelSize: 11, lineH: 15, padding: 7, headerH: 17 },
  /** Triangle pointer offsets */
  triOffset: 4,
  triWidth: 5,
  /** Border radius for bubble rounded rectangles */
  borderRadius: 5,
} as const

// ─── Effect drawing constants ───────────────────────────────────────────────

export const SPAWN_FX = {
  ringStart: 10,
  ringExpand: 60,
  maxAlpha: 0.7,
  flashThreshold: 0.3,
  flashAlpha: 0.6,
  flashBaseRadius: 20,
  flashMinRadius: 5,
  particleCount: 8,
  particleSize: 1.5,
} as const

export const COMPLETE_FX = {
  ringStart: 20,
  ringExpand: 80,
  maxAlpha: 0.6,
  flashThreshold: 0.2,
  flashAlpha: 0.8,
  flashRadius: 30,
  lineWidthMax: 3,
  glowInner: 5,
  glowOuter: 10,
} as const

// ─── Particle drawing constants ─────────────────────────────────────────────

export const PARTICLE_DRAW = {
  glowRadius: 15,
  coreHighlightScale: 0.4,
  labelMinT: 0.08,
  labelMaxT: 0.95,
  labelFontSize: 11,
  labelYOffset: -12,
} as const

// ─── Performance overlay constants (debug only, ?perf or ?stress) ────────────

/** Cached once at module load — avoids parsing location.search every frame */
export const PERF_OVERLAY_ENABLED = typeof window !== 'undefined'
  && (() => {
    const p = new URLSearchParams(window.location.search)
    return p.has('perf') || p.has('stress')
  })()

export const PERF_OVERLAY = {
  x: 8,
  y: 8,
  width: 260,
  height: 140,
  padding: 8,
  lineHeight: 18,
  font: '12px monospace',
  maxFrameSamples: 120,
  fpsWarning: 30,
  fpsCaution: 50,
  updateIntervalMs: 1000,
  bgColor: 'rgba(0, 0, 0, 0.75)',
  fpsGoodColor: '#44ff44',
  fpsCautionColor: '#ffaa00',
  fpsWarningColor: '#ff4444',
  textColor: '#cccccc',
} as const

// ─── Hit detection constants ────────────────────────────────────────────────

export const HIT_DETECTION = {
  /** Estimated character width for tool card labels */
  toolCharWidth: 6.6,
  /** Estimated character width for bubble text */
  bubbleCharWidth: 6.6,
  /** Tool card expanded height (with result) */
  toolExpandedH: 40,
  toolCollapsedH: 28,
  /** Minimum agent hit radius in SCREEN pixels (independent of zoom) */
  minAgentRadiusPx: 12,
  /** Minimum width/height of any other hit target in SCREEN pixels (WCAG 2.5.8) */
  minTargetPx: 24,
  /** Tolerance (SCREEN pixels) around a link curve for hit-testing */
  linkTolerancePx: 8,
} as const


// ─── Level of detail (zoom thresholds) ──────────────────────────────────────

export const LOD = {
  /** Below this zoom, hide secondary text: stats, token labels, tool/discovery/bubble text, cost pills */
  detailMinZoom: 0.6,
  /** Below this zoom, hide agent names and state labels too (only shapes remain) */
  labelMinZoom: 0.35,
} as const

// ─── State presentation (colour + text, so state never relies on colour alone) ──

/** Canvas-local state colours that differ from colors.ts so that every state is
 *  visually distinct (WCAG 1.4.1): thinking vs idle, waiting_permission vs tool_calling. */
export const STATE_COLOR_OVERRIDES: Readonly<Record<string, string>> = {
  thinking: '#b79cff',
  waiting_permission: '#ff7ad9',
}

/** Short state label drawn under every agent name */
export const STATE_LABEL_SHORT: Readonly<Record<string, string>> = {
  idle: 'idle',
  thinking: 'thinking',
  tool_calling: 'tool call',
  complete: 'done',
  error: 'error',
  paused: 'paused',
  waiting_permission: 'waiting',
}

/** Full state text used by the DOM mirror, legend and tooltip */
export const STATE_LABEL_LONG: Readonly<Record<string, string>> = {
  idle: 'idle',
  thinking: 'thinking',
  tool_calling: 'calling a tool',
  complete: 'complete',
  error: 'error',
  paused: 'paused',
  waiting_permission: 'waiting for permission',
}

// ─── Accessibility / motion ─────────────────────────────────────────────────

/** Cadence (ms) of the DOM mirror snapshot of the simulation */
export const A11Y_SNAPSHOT_MS = 500
/** Max tool-call history entries kept in the DOM mirror */
export const A11Y_HISTORY_MAX = 200
/** Max tool-call entries listed per agent in the DOM mirror */
export const A11Y_TOOLS_PER_AGENT = 50
/** Max live-region messages kept (older are dropped) */
export const A11Y_ANNOUNCE_MAX = 3
/** Global cap on bright flashes per second (WCAG 2.3.1) */
export const FLASH_MAX_PER_SECOND = 2

export const ANIM_PAUSE_KEY = 'agent-viz-pause-animations'
export const NEVER_HIDE_KEY = 'agent-viz-never-hide'
export const LEGEND_OPEN_KEY = 'agent-viz-legend-open'

// ─── Expiry hold (bubbles / tool cards / discoveries do not expire while hovered, focused, paused) ──

export interface ExpiryHold {
  /** User setting: never auto-hide bubbles, cards and discoveries */
  neverHide: boolean
  /** Playback or animations are paused: nothing expires */
  paused: boolean
  /** Agent ids whose bubbles are held (hovered / focused) */
  agentIds: Set<string>
  toolIds: Set<string>
  discoveryIds: Set<string>
}

/** Mutable singleton written by AgentCanvas, read by the animation step and draw code. */
export const expiryHold: ExpiryHold = {
  neverHide: false,
  paused: false,
  agentIds: new Set(),
  toolIds: new Set(),
  discoveryIds: new Set(),
}

export function isExpiryHeld(kind: 'agent' | 'tool' | 'discovery', id: string, hold: ExpiryHold = expiryHold): boolean {
  if (hold.neverHide || hold.paused) return true
  if (kind === 'agent') return hold.agentIds.has(id)
  if (kind === 'tool') return hold.toolIds.has(id)
  return hold.discoveryIds.has(id)
}

// ─── canvas-fleet draw constants (orchestrator, cluster halos, edge bubbles, label placement) ──
// Layout constants (cluster anchors, spacing) live in a separate block, owned by the fleet-layout package.

export const ORCHESTRATOR_DRAW = {
  /** Draw / hit scale of the orchestrator node relative to a regular main node */
  scale: 1.2,
  /** Badge text of the orchestrator of a team */
  leadText: 'LEAD',
  /** Badge text of the main agent of a session */
  mainText: 'MAIN',
  badgeFontSize: 11,
  badgeHeight: 16,
  /** Gap between the node top and the badge */
  badgeGap: 14,
  /** Accent of the crown badge (the crown SHAPE and the text carry the meaning, not the colour) */
  accent: '#ffd166',
} as const

export const EDGE_BUBBLE = {
  /** Lines of text shown in an edge bubble */
  maxLines: 3,
  maxWidth: 200,
  fontSize: 11,
  lineHeight: 14,
  padding: 6,
  /** Simulation seconds an edge bubble stays after its message */
  visibleS: 8,
  /** Fraction of the curve from the SENDER where the bubble is anchored */
  anchorT: 1 / 3,
  /** Chars of message text kept for a bubble (before wrapping) */
  maxChars: 240,
  /** Max bubbles shown per link (the newest messages): bounds memory and DOM buttons */
  maxPerLink: 3,
  /** Max bubbles shown on the whole canvas (the newest win) */
  maxTotal: 12,
  /** Fraction of the curve where a peer (teammate) message is anchored */
  peerT: 0.5,
  /** Words of the message kept in the accessible name of a bubble button */
  ariaWords: 10,
  /** Messages per link mirrored in the DOM list */
  listedPerLink: 5,
} as const

export const CLUSTER_DRAW = {
  labelFontSize: 12,
  detailFontSize: 11,
  labelHeight: 36,
  labelMaxWidth: 260,
  /** The title starts this many px right of the detail line (room for the colour dot) */
  titleIndent: 10,
  /** Padding between members and the halo edge (world px) */
  padding: 56,
} as const

export const PLACEMENT = {
  /** Gap kept between two placed labels (screen px) */
  gap: 3,
  /** Above this number of live items, secondary overlays are hidden (screen crowding) */
  crowdedItems: 60,
  /** Size of the collapsed bubble count chip (screen px) */
  chipW: 28,
  chipH: 20,
} as const

// ─── Freshness (issues #48, #52) ────────────────────────────────────────────

/** No event for this long (ms) and a live status is no longer proven: the node turns "stale" */
export const STALE_AFTER_MS = 30_000
/** A status that comes from history (not seen live) expires after this long (ms) */
export const HISTORY_STATUS_EXPIRY_MS = 15 * 60_000
/** A terminal status (error / interrupted) stays visible this long (ms), then the agent reads "closed" */
export const TERMINAL_STATUS_VISIBLE_MS = 2 * 60_000
/** Period (ms) of the one shared freshness clock */
export const FRESHNESS_TICK_MS = 1000
/** Max agent names listed in one screen reader announcement */
export const FRESHNESS_ANNOUNCE_MAX_NAMES = 3

export const FRESHNESS_DRAW = {
  /** Neutral grey of a stale node (state colours say "live") */
  staleColor: '#8a94a0',
  /** Alpha multiplier applied to a stale node (the label text stays fully opaque) */
  staleAlpha: 0.45,
  /** Max width (px) of the "last known state" line */
  labelMaxWidth: 240,
} as const
