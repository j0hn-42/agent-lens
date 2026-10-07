/**
 * Holographic color palette and role color definitions.
 *
 * Extracted from agent-types.ts to keep that file focused on type definitions.
 * All colors are re-exported from agent-types.ts for backward compatibility.
 */

import type { AgentState, ContextBreakdown } from './agent-types'

// Holographic Color Palette
export const COLORS = {
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
  scrubberFill: 'linear-gradient(90deg, rgba(102,204,255,0.3), rgba(102,204,255,0.6))',
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
} as const

// ─── Role Colors (message feed & bubbles) ───────────────────────────────────

export const ROLE_COLORS: Record<string, { bg: string; bgSelected: string; text: string; label: string }> = {
  assistant: { bg: COLORS.roleAssistantBg, bgSelected: COLORS.roleAssistantBgSelected, text: COLORS.roleAssistantText, label: 'CLAUDE' },
  thinking:  { bg: COLORS.roleThinkingBg,  bgSelected: COLORS.roleThinkingBgSelected,  text: COLORS.roleThinkingText,  label: 'THINKING' },
  user:      { bg: COLORS.roleUserBg,       bgSelected: COLORS.roleUserBgSelected,       text: COLORS.roleUserText,       label: 'USER' },
} as const

// ─── Color Helper Functions ──────────────────────────────────────────────────

export function getStateColor(state: AgentState): string {
  switch (state) {
    case 'idle': return COLORS.idle
    case 'thinking': return COLORS.thinking
    case 'tool_calling': return COLORS.tool_calling
    case 'complete': return COLORS.complete
    case 'error': return COLORS.error
    case 'paused': return COLORS.paused
    case 'waiting_permission': return COLORS.waiting_permission
  }
}

export function getDiscoveryTypeColor(type: string): string {
  switch (type) {
    case 'file': return COLORS.discoveryFile
    case 'pattern': return COLORS.discoveryPattern
    case 'finding': return COLORS.discoveryFinding
    default: return COLORS.discoveryCode
  }
}

/** Safely combine a partial rgba base (e.g. 'rgba(10, 15, 30,') with an alpha value */
export function withAlpha(rgbaBase: string, alpha: number): string {
  return `${rgbaBase} ${alpha})`
}

/** Build the context-breakdown color segments for a given breakdown. */
export function contextSegments(bd: ContextBreakdown) {
  return [
    { value: bd.systemPrompt, color: COLORS.contextSystem },
    { value: bd.userMessages, color: COLORS.contextUser },
    { value: bd.toolResults, color: COLORS.contextToolResults },
    { value: bd.reasoning, color: COLORS.contextReasoning },
    { value: bd.subagentResults, color: COLORS.contextSubagent },
  ]
}
