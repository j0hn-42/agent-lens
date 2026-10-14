'use client'

import { useCallback, useEffect, useMemo, useRef } from 'react'
import type { useVSCodeBridge } from '@/hooks/use-vscode-bridge'
import type { UseUiPreferences } from '@/hooks/use-ui-preferences'
import { planScopeChoice, type ScopeChoice } from '@/lib/relay-scope'

type Bridge = ReturnType<typeof useVSCodeBridge>

/**
 * Scope selector (#291). The shown scope is the relay's own report; a choice becomes the remembered one only
 * once the relay applied it.
 */
export function useScopeControls(
  bridge: Pick<Bridge, 'relayScope' | 'setRelayScope' | 'sessions' | 'relayScopePending' | 'relayScopeError'>,
  uiPrefs: UseUiPreferences,
) {
  const { prefs, setPref, getPrefs } = uiPrefs
  const { relayScope, setRelayScope } = bridge
  const chooseScope = useCallback((choice: ScopeChoice) => {
    const plan = planScopeChoice(choice, relayScope?.scope ?? 'workspace')
    setPref('sessionFilterProject', plan.projectId)
    if (choice.kind === 'project') return
    if (relayScope && plan.relayScope === relayScope.scope) { setPref('relayScope', plan.relayScope); return }
    void setRelayScope(plan.relayScope).then(ok => { if (ok) setPref('relayScope', plan.relayScope) })
  }, [relayScope, setRelayScope, setPref])
  const scopeProps = useMemo(() => ({
    state: relayScope, sessions: bridge.sessions, projectId: prefs.sessionFilterProject,
    pending: bridge.relayScopePending, error: bridge.relayScopeError, onChoose: chooseScope,
  }), [relayScope, bridge.sessions, prefs.sessionFilterProject, bridge.relayScopePending, bridge.relayScopeError, chooseScope])
  // A scope chosen earlier is asked of the relay once per page load, when it reports another one
  const scopeRestoredRef = useRef(false)
  useEffect(() => {
    if (scopeRestoredRef.current || !relayScope) return
    scopeRestoredRef.current = true
    const wanted = getPrefs().relayScope
    if (wanted && wanted !== relayScope.scope) void setRelayScope(wanted)
  }, [relayScope, setRelayScope, getPrefs])

  return scopeProps
}
