"use client"

import type { useVSCodeBridge } from "@/hooks/use-vscode-bridge"
import { emptyStateChecklist } from "@/lib/chrome-utils"
import { FOCUS_RING } from "@/lib/focus-ring"
import { SCENE } from "@/lib/colors"
import { detectedSessions } from "@/lib/session-model"
import { LearnMoreLink } from "./learn-more-link"

type Bridge = ReturnType<typeof useVSCodeBridge>

/**
 * Shown when there is no demo and no live data. Its text sits directly on the scene ground: scene colours,
 * whatever the theme.
 */
export function EmptyState({ bridge }: {
  bridge: Pick<Bridge, 'connectionStatus' | 'relayPort' | 'sessions' | 'hooksConfigured' | 'isVSCode' | 'relayScope' | 'loadDemo'>
}) {
  const checklist = emptyStateChecklist({
    status: bridge.connectionStatus,
    relayPort: bridge.relayPort || undefined,
    sessionCount: detectedSessions(bridge.sessions).length,
    hooksConfigured: bridge.hooksConfigured,
    isVSCode: bridge.isVSCode,
    scope: bridge.relayScope?.scope,
  })
  return (
    <div className="absolute inset-0 flex items-center justify-center z-(--z-info) p-3 pointer-events-none">
      <div
        className="text-center max-w-[calc(100vw-24px)] pointer-events-auto"
        style={{ fontFamily: "'SF Mono', 'Fira Code', monospace" }}
      >
        <div className="text-sm font-semibold" style={{ color: SCENE.textPrimary }}>Waiting for an agent session</div>
        <div className="mt-1 text-xs" style={{ color: SCENE.textMuted }}>Start a Claude Code, Codex, Copilot, Pi, Gemini CLI or OpenCode session in the watched workspace to see activity</div>
        <ul className="mt-3 inline-block text-left text-xs space-y-1" style={{ color: SCENE.textMuted }}>
          {checklist.map(item => (
            <li key={item.id}>
              <span aria-hidden="true" className="inline-block w-4" style={{ color: item.unknown ? SCENE.textMuted : item.ok ? SCENE.complete : SCENE.error }}>{item.unknown ? '?' : item.ok ? '✓' : '✗'}</span>
              <span className="sr-only">{item.unknown ? 'Unknown: ' : item.ok ? 'Done: ' : 'Not done: '}</span>
              {item.label}
              {item.detail && <span> ({item.detail})</span>}
            </li>
          ))}
        </ul>
        <div className="mt-3">
          <button
            type="button"
            onClick={bridge.loadDemo}
            className={`min-h-6 min-w-6 px-3 py-1 rounded text-xs font-semibold ${FOCUS_RING}`}
            style={{ background: SCENE.holoBg10, border: `1px solid ${SCENE.controlBorder}`, color: SCENE.textPrimary }}
          >
            Load demo
          </button>
        </div>
        <div className="mt-2 text-xs" style={{ color: SCENE.textMuted }}>
          <LearnMoreLink palette={SCENE} />
        </div>
      </div>
    </div>
  )
}
