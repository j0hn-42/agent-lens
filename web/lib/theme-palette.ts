/**
 * COLORS palettes per theme.
 *
 * - `neon` is the palette the app has always shipped, kept literally (the look must not move).
 * - the other themes (every theme but `neon`) are derived from their design tokens (`theme-tokens.ts`) by `derivePalette`,
 *   following the design README: colours by role, neutral grounds, flat cards, solid text colours
 *   (>= 4.5:1) and control boundaries (>= 3:1).
 *
 * Pure module (no DOM) so it can be unit-tested; `lib/colors.ts` exposes the live `COLORS` object.
 */

import { TOKENS, SHADOW_CARD, type ThemeId, type ThemeTokens } from './theme-tokens'

// Neon palette (current look). The role-named keys at the end (surface ... info) are the neon design tokens.
export const NEON_COLORS = {
  // Background
  void: '#050510',
  hexGrid: '#0d0d1f',

  // Primary Hologram
  holoBase: '#66ccff',
  holoBright: '#aaeeff',
  holoHot: '#ffffff',

  // Agent States
  idle: '#66ccff',
  thinking: '#66ccff',
  tool_calling: '#ffbb44',
  complete: '#66ffaa',
  error: '#ff5566',
  paused: '#888899',
  waiting_permission: '#ffaa33',

  // Edge/Particle Colors
  dispatch: '#cc88ff',
  return: '#66ffaa',
  tool: '#ffbb44',
  /** MCP tool calls (cyan, distinct from the amber of native tools) */
  mcp: '#22d3ee',
  message: '#66ccff',

  // Context breakdown colors
  contextSystem: '#7777a0',     // gray-blue — fixed overhead (>= 3:1 non-text)
  contextUser: '#66ccff',       // blue — user input
  contextToolResults: '#ffbb44', // amber — expensive!
  contextReasoning: '#cc88ff',  // purple — agent thinking
  contextSubagent: '#66ffaa',   // green — child agent results

  // UI Chrome
  nodeInterior: 'rgba(10, 15, 40, 0.5)',
  textPrimary: '#aaeeff',
  textDim: '#66ccffa0',      // >= 4.5:1 text on void/glass — headings of empty states, secondary labels
  textMuted: '#66ccffb0',    // >= 4.5:1 text — muted body copy, brighter than textDim
  textHint: 'rgba(170, 238, 255, 0.6)', // >= 4.5:1 text — hints below an empty-state heading (second tier)

  // Glass card
  glassBg: 'rgba(10, 15, 30, 0.7)',
  controlBorder: 'rgba(102, 204, 255, 0.5)', // >= 3:1 non-text — border of buttons/inputs that are real controls (glassBorder is decoration only)
  glassBorder: 'rgba(102, 204, 255, 0.22)', // decorative card edge only (not a control boundary, no 3:1 requirement)
  glassHighlight: 'rgba(100, 200, 255, 0.08)',

  // Holo background/border opacities (avoids scattered rgba literals)
  holoBg03: 'rgba(100, 200, 255, 0.03)',
  holoBg05: 'rgba(100, 200, 255, 0.05)',
  holoBg10: 'rgba(100, 200, 255, 0.1)',
  holoBorder06: 'rgba(100, 200, 255, 0.06)',
  holoBorder08: 'rgba(100, 200, 255, 0.08)',
  holoBorder10: 'rgba(100, 200, 255, 0.1)',
  holoBorder12: 'rgba(100, 200, 255, 0.12)',

  // Panel chrome
  panelBg: 'rgba(8, 12, 24, 0.85)',
  panelSeparator: 'rgba(100, 200, 255, 0.04)',

  // Toggle button states
  toggleActive: 'rgba(100, 200, 255, 0.15)',
  toggleInactive: 'rgba(100, 200, 255, 0.05)',
  toggleBorder: 'rgba(102, 204, 255, 0.5)',   // >= 3:1 non-text — inactive toggle boundary
  toggleBorderActive: '#66ccff',              // >= 3:1 non-text — pressed toggle, fully opaque so it reads stronger than toggleBorder

  // Non-text tracks (scrubber, progress bars), >= 3:1 on glass/void
  controlTrack: 'rgba(102, 204, 255, 0.5)', // >= 3:1 non-text — scrubber/progress track

  // Live indicator
  liveDot: '#ff4444',
  liveText: '#ff6666',
  liveResumeBg: 'rgba(255, 68, 68, 0.15)',
  liveResumeBorder: 'rgba(255, 68, 68, 0.7)', // >= 3:1 non-text — live-resume button boundary

  // Discovery type colors
  discoveryFile: '#66ccff',
  discoveryPattern: '#cc88ff',
  discoveryFinding: '#66ffaa',
  discoveryCode: '#ffbb44',

  // Session tab states
  tabSelectedBg: 'rgba(100, 200, 255, 0.15)',
  tabInactiveBg: 'rgba(100, 200, 255, 0.03)',
  tabSelectedBorder: '#66ccff',                     // >= 3:1 non-text — selected tab, fully opaque (use with tabSelectedBg + 2px border)
  tabInactiveBorder: 'rgba(102, 204, 255, 0.5)',    // >= 3:1 non-text — inactive tab boundary (1px)
  tabClose: '#ff6688',

  // Role colors (message bubbles)
  roleAssistantBg: 'rgba(80, 160, 220, 0.12)',
  roleAssistantBgSelected: 'rgba(80, 160, 220, 0.2)',
  roleAssistantText: '#a0d4f0',
  roleThinkingBg: 'rgba(140, 100, 200, 0.12)',
  roleThinkingBgSelected: 'rgba(140, 100, 200, 0.2)',
  roleThinkingText: '#c0a0e0',
  roleUserBg: 'rgba(200, 160, 80, 0.12)',
  roleUserBgSelected: 'rgba(200, 160, 80, 0.2)',
  roleUserText: '#e0c888',

  // Result/success
  resultBg: 'rgba(102, 255, 170, 0.05)',
  resultBorder: 'rgba(102, 255, 170, 0.1)',

  // Unread indicator
  unreadDot: '#ff6666',

  // Play button
  playBtnBg: 'rgba(102, 204, 255, 0.12)',
  playBtnActiveBg: 'rgba(102, 204, 255, 0.2)',
  playBtnBorder: 'rgba(102, 204, 255, 0.5)', // >= 3:1 non-text — play button boundary
  playBtnGlow: '0 0 12px rgba(102, 204, 255, 0.15)',

  // Scrubber
  // Both stops >= 3:1 against controlTrack (the fill is painted over the track); tested in scripts/contrast.test.ts
  scrubberFill: 'linear-gradient(90deg, rgba(170,238,255,0.8), rgba(170,238,255,0.95))',
  scrubberHeadGlow: '0 0 10px rgba(102, 204, 255, 0.6), 0 0 20px rgba(102, 204, 255, 0.2)',
  reviewBtnBorder: 'rgba(102, 204, 255, 0.5)', // >= 3:1 non-text — review button boundary

  // Cost overlay
  costActiveBg: 'rgba(102, 255, 170, 0.15)',

  // Canvas drawing — bubble base colors (partial rgba, alpha appended at draw time)
  bubbleThinkingBase: 'rgba(140, 100, 200,',
  bubbleUserBase: 'rgba(200, 160, 80,',
  bubbleAssistantBase: 'rgba(80, 160, 220,',

  // Canvas drawing — tool card backgrounds (partial rgba, alpha appended at draw time)
  toolCardErrorBase: 'rgba(40, 10, 15,',
  toolCardSelectedBase: 'rgba(100, 200, 255,',
  toolCardBase: 'rgba(10, 15, 30,',

  // Canvas drawing — agent/tool card backgrounds
  cardBgDark: 'rgba(5, 5, 16, 0.8)',
  cardBg: 'rgba(10, 15, 30, 0.6)',
  cardBgSelected: 'rgba(10, 15, 30, 0.8)',
  cardBgError: 'rgba(40, 10, 15, 0.8)',
  cardBgSelectedHolo: 'rgba(100, 200, 255, 0.15)',
  cardBgFaintOverlay: 'rgba(0, 0, 0, 0.01)',

  // Active tool indicator (detail card)
  mcpIndicatorBg: 'rgba(34, 211, 238, 0.1)',
  mcpIndicatorBorder: 'rgba(34, 211, 238, 0.25)',
  toolIndicatorBg: 'rgba(255, 187, 68, 0.1)',
  toolIndicatorBorder: 'rgba(255, 187, 68, 0.2)',
  toolIndicatorText: '#ffbb44',

  // Canvas drawing — cost labels
  costText: '#66ffaa',
  costTextDim: '#66ffaaa0',
  costPillBg: 'rgba(10, 20, 40, 0.75)',
  costPillStroke: 'rgba(102, 255, 170, 0.3)',

  // Canvas drawing — cost panel bar fills
  barFillMain: 'rgba(102, 204, 255, 0.15)',
  barFillSub: 'rgba(204, 136, 255, 0.15)',

  // ─── Transcript / message feed colors ───────────────────────────────────────

  // User messages
  userMsgBg: 'rgba(255, 187, 68, 0.06)',
  userMsgBorder: 'rgba(255, 187, 68, 0.12)',
  userLabel: '#ffbb44a0',
  userText: '#ffcc66',

  // Assistant messages
  assistantLabel: '#66ccffa0',
  assistantText: '#aaeeff',

  // Thinking messages
  thinkingBgExpanded: 'rgba(180, 140, 255, 0.06)',
  thinkingBgCollapsed: 'rgba(180, 140, 255, 0.03)',
  thinkingBorder: 'rgba(180, 140, 255, 0.08)',
  thinkingLabel: '#bb99ffc0',
  thinkingArrow: '#bb99ffc0',
  thinkingPreview: '#bb99ff',
  thinkingTextExpanded: '#bb99ffc0',
  thinkingBorderLeft: 'rgba(180, 140, 255, 0.15)',

  // Tool call messages
  toolCallBg: 'rgba(255, 187, 68, 0.05)',
  toolCallBorder: 'rgba(255, 187, 68, 0.1)',

  // Tool result messages
  bashResultBg: 'rgba(0,0,0,0.25)',
  toolResultBg: 'rgba(102, 255, 170, 0.04)',
  bashResultBorder: 'rgba(255, 187, 68, 0.1)',
  toolResultBorder: 'rgba(102, 255, 170, 0.08)',
  bashResultText: '#aaeeffa0',
  toolResultText: '#66ffaaa0',
  textFaint: '#aaeeffa0', // >= 4.5:1 text — faint/tertiary text; use instead of text + opacity

  // Search highlight
  searchHighlightBg: 'rgba(255,187,68,0.3)',

  // ─── Diff / code block colors ───────────────────────────────────────────────

  codeBlockBg: 'rgba(0,0,0,0.3)',
  diffRemoved: '#ff6666',
  diffRemovedBg: 'rgba(255,80,80,0.08)',
  diffAdded: '#66ff88',
  diffAddedBg: 'rgba(80,255,120,0.08)',

  // ─── Tool content colors ────────────────────────────────────────────────────

  filePathActive: '#66ccff',
  filePathInactive: '#66ccffa0',
  todoCompleted: '#66ffaa',
  todoCompletedText: '#66ffaaa0', // >= 4.5:1 text as rendered — completed todo content, render WITHOUT an extra opacity
  todoPending: '#66ccffa0', // >= 4.5:1 as rendered — pending todo icon, render WITHOUT an extra opacity
  contentDim: '#aaeeffa0',
  searchIcon: '#66ccff60',

  // ─── Panel header / chrome text ─────────────────────────────────────────────

  panelLabel: '#66ccffa0',
  panelLabelDim: '#66ccffa0',
  scrollBtnText: '#66ccff',
  scrollbarThumb: 'rgba(102,204,255,0.5)', // >= 3:1 non-text — scrollbar thumb (mirrors globals.css)

  // Status dot rings (non-color-only state cue)
  statusDotRing: '#aaeeff',      // >= 3:1 non-text — light ring around a status dot on void/glass
  statusDotRingInner: '#050510', // dark gap between dot and ring; ring-vs-gap contrast >= 3:1

  // Design tokens by role (neon values of the design system; new keys, nothing above depends on them)
  surface: '#0a0f1e',
  surfaceRaised: '#121a30',
  edge: '#1c3750',
  ink: '#aaeeff',
  inkMuted: '#7fc3e0',
  accent: '#66ccff',
  onAccent: '#050510',
  focus: '#99e0ff',
  ok: '#66ffaa',
  warn: '#ffbb44',
  danger: '#ff6666',
  delegate: '#cc88ff',
  info: '#22d3ee',
  shadowCard: '0 0 20px rgba(0, 0, 0, 0.3), inset 0 1px 0 rgba(100, 200, 255, 0.08)',
  glassBlur: 'blur(20px)',

  // Canvas scene colours (added for the canvas zone; neon keeps the literals the canvas always used)
  perfBg: 'rgba(0, 0, 0, 0.75)',
  perfText: '#cccccc',
  fpsGood: '#44ff44',
  fpsCaution: '#ffaa00',
  fpsWarning: '#ff4444',
  /** thinking / waiting_permission: distinct from idle and tool_calling (WCAG 1.4.1, the state text says it too) */
  stateThinking: '#b79cff',
  stateWaitingPermission: '#ff7ad9',
  /** Crown badge (LEAD / MAIN): fill and text on it */
  crownFill: '#ffd166',
  crownText: '#11161c',
  /** Stale node and its "last known state" label */
  staleNode: '#8a94a0',
  staleText: '#c5ced8',
  /** Halo of a teammate whose team colour is missing */
  teamDefault: '#b794f6',
  /** Shadow under an agent node */
  depthShadow: 'rgba(0, 0, 0, 0.5)',
  /** Halo colours of sessions */
  session0: '#66ccff',
  session1: '#7ee0a8',
  session2: '#ffcc66',
  session3: '#ff9ec7',
  session4: '#b79cff',
  session5: '#9ad0ff',
  session6: '#ffa978',
  session7: '#8de3de',

  commDispatchBg: 'rgba(80,140,255,0.14)',
  commDispatchBgSelected: 'rgba(80,140,255,0.26)',
  commDispatchText: '#9cc4ff',
  commReturnBg: 'rgba(60,200,120,0.12)',
  commReturnBgSelected: 'rgba(60,200,120,0.24)',
  commReturnText: '#7fe3a3',
  commErrorBg: 'rgba(255,90,90,0.14)',
  commErrorBgSelected: 'rgba(255,90,90,0.26)',
  commErrorText: '#ff9b9b',
  commMessageBg: 'rgba(200,150,255,0.12)',
  commMessageBgSelected: 'rgba(200,150,255,0.24)',
  commMessageText: '#e0b0ff',
  fileCardBg: 'rgba(10, 15, 30, 0.5)',

  // Timeline, legend (zone 4): swimlane arrows, opaque muted text, crown of the orchestrator
  swimlaneDispatch: '#7fb2ff',
  swimlaneReturn: '#7fe3a3',
  swimlaneError: '#ff8f8f',
  swimlaneMessage: '#e0b0ff',
  textMutedOpaque: '#8fcfef',
  crownAccent: '#ffd166',
} as const

export type ColorKey = keyof typeof NEON_COLORS
export type Palette = Record<ColorKey, string>

// ─── Colour helpers ──────────────────────────────────────────────────────────

function rgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
}

/** '#rrggbb' + alpha -> 'rgba(r, g, b, a)' */
function rgba(hex: string, alpha: number): string {
  const [r, g, b] = rgb(hex)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

/** '#rrggbb' -> 'rgba(r, g, b,' (alpha appended at draw time with withAlpha) */
function rgbaBase(hex: string): string {
  const [r, g, b] = rgb(hex)
  return `rgba(${r}, ${g}, ${b},`
}

/** Linear mix of two '#rrggbb' colours: 0 = a, 1 = b. */
function mix(a: string, b: string, t: number): string {
  const [ar, ag, ab] = rgb(a)
  const [br, bg, bb] = rgb(b)
  const c = (x: number, y: number) => Math.round(x + (y - x) * t).toString(16).padStart(2, '0')
  return `#${c(ar, br)}${c(ag, bg)}${c(ab, bb)}`
}

function luminance(hex: string): number {
  const f = rgb(hex).map(v => v / 255).map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
  return 0.2126 * f[0] + 0.7152 * f[1] + 0.0722 * f[2]
}

/** WCAG contrast ratio of two '#rrggbb' colours. */
function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

/**
 * Palette of a theme from its design tokens. Text colours are the solid role colours (no alpha), so the
 * contrast promised by the tokens is the contrast painted. Overlays (hover tints, borders) use the role
 * colour at low alpha.
 */
export function derivePalette(t: Readonly<ThemeTokens>, shadowCard: string): Palette {
  const { void: ground, surface, ink, accent, warn, danger, delegate, info, ok } = t
  const raised = t['surface-raised']
  const muted = t['ink-muted']
  const ctl = t['control-border']
  const edge = t.edge
  // Black overlays (code blocks)
  const shade = (a: number) => rgba('#000000', a)
  // Scrubber: opaque ink fill over a track made of the control border. When the border is too close to the ink for the fill to stand
  // out (High contrast, Catppuccin), the fill is brightened and the track darkened toward the ground, keeping it >= 3:1 on the surface
  let fill = ink
  let track = ctl
  if (contrastRatio(ink, ctl) < 3.2) {
    fill = mix(ink, '#ffffff', 0.5)
    for (let k = 1; k <= 40 && contrastRatio(fill, track) < 3.1; k++) {
      const next = mix(ctl, surface, k / 40)
      if (contrastRatio(next, surface) < 3.1) break
      track = next
    }
  }
  const errCard = mix(danger, ground, 0.85)
  const flat = 'none'
  return {
    void: ground,
    hexGrid: mix(ground, ink, 0.06),

    holoBase: accent,
    holoBright: ink,
    holoHot: t.focus,

    idle: accent,
    thinking: accent,
    tool_calling: warn,
    complete: ok,
    error: danger,
    paused: t['context-system'],
    waiting_permission: warn,

    dispatch: delegate,
    return: ok,
    tool: warn,
    mcp: info,
    message: accent,

    contextSystem: t['context-system'],
    contextUser: accent,
    contextToolResults: warn,
    contextReasoning: delegate,
    contextSubagent: ok,

    nodeInterior: rgba(surface, 0.5),
    textPrimary: ink,
    textDim: muted,
    textMuted: muted,
    textHint: muted,

    glassBg: surface,
    controlBorder: ctl,
    glassBorder: edge,
    glassHighlight: rgba(accent, 0.04),

    holoBg03: rgba(accent, 0.03),
    holoBg05: rgba(accent, 0.05),
    holoBg10: rgba(accent, 0.1),
    holoBorder06: rgba(edge, 0.6),
    holoBorder08: rgba(edge, 0.8),
    holoBorder10: edge,
    holoBorder12: edge,

    panelBg: surface,
    panelSeparator: edge,

    toggleActive: rgba(accent, 0.15),
    toggleInactive: rgba(accent, 0.05),
    toggleBorder: ctl,
    toggleBorderActive: accent,

    controlTrack: track,

    liveDot: danger,
    liveText: danger,
    liveResumeBg: rgba(danger, 0.15),
    liveResumeBorder: danger,

    discoveryFile: accent,
    discoveryPattern: delegate,
    discoveryFinding: ok,
    discoveryCode: warn,

    tabSelectedBg: rgba(accent, 0.15),
    tabInactiveBg: rgba(accent, 0.03),
    tabSelectedBorder: accent,
    tabInactiveBorder: ctl,
    tabClose: danger,

    roleAssistantBg: rgba(accent, 0.12),
    roleAssistantBgSelected: rgba(accent, 0.2),
    roleAssistantText: ink,
    roleThinkingBg: rgba(delegate, 0.12),
    roleThinkingBgSelected: rgba(delegate, 0.2),
    roleThinkingText: delegate,
    roleUserBg: rgba(warn, 0.12),
    roleUserBgSelected: rgba(warn, 0.2),
    roleUserText: warn,

    resultBg: rgba(ok, 0.05),
    resultBorder: rgba(ok, 0.1),

    unreadDot: danger,

    playBtnBg: rgba(accent, 0.12),
    playBtnActiveBg: rgba(accent, 0.2),
    playBtnBorder: ctl,
    playBtnGlow: flat,

    scrubberFill: `linear-gradient(90deg, ${fill}, ${fill})`, // opaque: a translucent fill would fall under 3:1 against the grey track
    scrubberHeadGlow: flat,
    reviewBtnBorder: ctl,

    costActiveBg: rgba(ok, 0.15),

    bubbleThinkingBase: rgbaBase(delegate),
    bubbleUserBase: rgbaBase(warn),
    bubbleAssistantBase: rgbaBase(accent),

    toolCardErrorBase: rgbaBase(errCard),
    toolCardSelectedBase: rgbaBase(accent),
    toolCardBase: rgbaBase(surface),

    cardBgDark: rgba(ground, 0.8),
    cardBg: rgba(surface, 0.6),
    cardBgSelected: rgba(surface, 0.8),
    cardBgError: rgba(errCard, 0.8),
    cardBgSelectedHolo: rgba(accent, 0.15),
    cardBgFaintOverlay: 'rgba(0, 0, 0, 0.01)',

    mcpIndicatorBg: rgba(info, 0.1),
    mcpIndicatorBorder: rgba(info, 0.25),
    toolIndicatorBg: rgba(warn, 0.1),
    toolIndicatorBorder: rgba(warn, 0.2),
    toolIndicatorText: warn,

    costText: ok,
    costTextDim: ok,
    costPillBg: rgba(surface, 0.75),
    costPillStroke: rgba(ok, 0.3),

    barFillMain: rgba(accent, 0.15),
    barFillSub: rgba(delegate, 0.15),

    userMsgBg: rgba(warn, 0.06),
    userMsgBorder: rgba(warn, 0.12),
    userLabel: warn,
    userText: warn,

    assistantLabel: muted,
    assistantText: ink,

    thinkingBgExpanded: rgba(delegate, 0.06),
    thinkingBgCollapsed: rgba(delegate, 0.03),
    thinkingBorder: rgba(delegate, 0.08),
    thinkingLabel: delegate,
    thinkingArrow: delegate,
    thinkingPreview: delegate,
    thinkingTextExpanded: delegate,
    thinkingBorderLeft: rgba(delegate, 0.15),

    toolCallBg: rgba(warn, 0.05),
    toolCallBorder: rgba(warn, 0.1),

    bashResultBg: shade(0.25),
    toolResultBg: rgba(ok, 0.04),
    bashResultBorder: rgba(warn, 0.1),
    toolResultBorder: rgba(ok, 0.08),
    bashResultText: muted,
    toolResultText: ok,
    textFaint: muted,

    searchHighlightBg: rgba(warn, 0.24),

    codeBlockBg: shade(0.3),
    diffRemoved: danger,
    diffRemovedBg: rgba(danger, 0.08),
    diffAdded: ok,
    diffAddedBg: rgba(ok, 0.08),

    filePathActive: accent,
    filePathInactive: muted,
    todoCompleted: ok,
    todoCompletedText: ok,
    todoPending: muted,
    contentDim: muted,
    searchIcon: muted,

    panelLabel: muted,
    panelLabelDim: muted,
    scrollBtnText: accent,
    scrollbarThumb: ctl,

    statusDotRing: ink,
    statusDotRingInner: ground,

    surface,
    surfaceRaised: raised,
    edge,
    ink,
    inkMuted: muted,
    accent,
    onAccent: t['on-accent'],
    focus: t.focus,
    ok,
    warn,
    danger,
    delegate,
    info,
    shadowCard,
    glassBlur: 'none',

    perfBg: rgba(surface, 0.9),
    perfText: ink,
    fpsGood: ok,
    fpsCaution: warn,
    fpsWarning: danger,
    stateThinking: delegate,
    stateWaitingPermission: info,
    crownFill: accent,
    crownText: t['on-accent'],
    staleNode: t['context-system'],
    staleText: muted,
    teamDefault: delegate,
    depthShadow: 'rgba(0, 0, 0, 0)',
    session0: accent,
    session1: ok,
    session2: warn,
    session3: delegate,
    session4: info,
    session5: mix(ok, info, 0.5),
    session6: mix(warn, danger, 0.5),
    session7: mix(delegate, danger, 0.5),

    commDispatchBg: rgba(info, 0.08),
    commDispatchBgSelected: rgba(info, 0.14),
    commDispatchText: info,
    commReturnBg: rgba(ok, 0.08),
    commReturnBgSelected: rgba(ok, 0.14),
    commReturnText: ok,
    commErrorBg: rgba(danger, 0.05),
    commErrorBgSelected: rgba(danger, 0.08),
    commErrorText: danger,
    commMessageBg: rgba(delegate, 0.08),
    commMessageBgSelected: rgba(delegate, 0.14),
    commMessageText: delegate,
    fileCardBg: raised,

    swimlaneDispatch: info,
    swimlaneReturn: ok,
    swimlaneError: danger,
    swimlaneMessage: delegate,
    textMutedOpaque: muted,
    crownAccent: accent,
  }
}

/** Palette of a theme: neon is the literal legacy palette, the others are derived from their tokens. */
export function paletteFor(id: ThemeId, tokens: Readonly<ThemeTokens> = TOKENS[id]): Palette {
  if (id === 'neon') return { ...NEON_COLORS }
  return derivePalette(tokens, SHADOW_CARD[id])
}
