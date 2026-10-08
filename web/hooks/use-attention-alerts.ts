'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { attentionTitle, baseTitle, formatAttention, newlyBlocked, type AttentionSummary } from '@/lib/attention'

/** localStorage key of the opt-in to browser notifications (never asked for at load) */
export const NOTIFY_STORAGE_KEY = 'agent-lens:notify-blocked'

export type NotifyState = 'unsupported' | 'off' | 'on' | 'denied'

function notificationApi(): typeof Notification | null {
  return typeof Notification === 'undefined' ? null : Notification
}

/**
 * Makes the agents that need the user visible outside the canvas (#126): the tab title carries their
 * number, and an opt-in browser notification fires when new ones appear while the tab is hidden.
 * The permission is requested only when the user turns the option on.
 */
export function useAttentionAlerts(summary: AttentionSummary) {
  const total = summary.total

  useEffect(() => {
    if (typeof document === 'undefined') return
    const base = baseTitle(document.title)
    document.title = attentionTitle(base, total)
    return () => { document.title = base }
  }, [total])

  const [state, setState] = useState<NotifyState>('off')
  useEffect(() => {
    const api = notificationApi()
    if (!api) { setState('unsupported'); return }
    if (api.permission === 'denied') { setState('denied'); return }
    try {
      setState(localStorage.getItem(NOTIFY_STORAGE_KEY) === 'true' && api.permission === 'granted' ? 'on' : 'off')
    } catch { /* storage unavailable */ }
  }, [])

  const toggle = useCallback(async () => {
    const api = notificationApi()
    if (!api) return
    if (state === 'on') {
      setState('off')
      try { localStorage.setItem(NOTIFY_STORAGE_KEY, 'false') } catch { /* storage unavailable */ }
      return
    }
    const permission = api.permission === 'granted' ? 'granted' : await api.requestPermission()
    if (permission === 'granted') {
      setState('on')
      try { localStorage.setItem(NOTIFY_STORAGE_KEY, 'true') } catch { /* storage unavailable */ }
    } else {
      setState(permission === 'denied' ? 'denied' : 'off')
    }
  }, [state])

  const previousRef = useRef<ReadonlySet<string>>(new Set())
  useEffect(() => {
    const fresh = newlyBlocked(previousRef.current, summary.blockedIds)
    previousRef.current = summary.blockedIds
    const api = notificationApi()
    if (state !== 'on' || !api || fresh.length === 0 || typeof document === 'undefined' || !document.hidden) return
    try {
      new api('Agent Lens', { body: formatAttention(summary.waiting, summary.errors), tag: 'agent-lens-attention' })
    } catch { /* notifications blocked by the platform */ }
  }, [summary, state])

  return { notifyState: state, toggleNotify: toggle }
}
