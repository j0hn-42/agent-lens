'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { attentionTitle, baseTitle, type AttentionSummary } from '@/lib/attention'
import { DEFAULT_RULES, emptySnapshot, evaluateTriggers, type NotificationRules, type NotifyItem, type NotifySnapshot } from '@/lib/notification-rules'
import type { SessionInfo } from '@/lib/bridge-types'
import type { UsageTotal } from '@/lib/usage'

/** localStorage key of the opt-in to browser notifications (never asked for at load) */
export const NOTIFY_STORAGE_KEY = 'agent-lens:notify-blocked'

export type NotifyState = 'unsupported' | 'off' | 'on' | 'denied'

function notificationApi(): typeof Notification | null {
  return typeof Notification === 'undefined' ? null : Notification
}

function storedOptIn(): boolean {
  try { return localStorage.getItem(NOTIFY_STORAGE_KEY) === 'true' } catch { return false }
}

export interface AttentionAlertOptions {
  /** Which triggers are on (default: permission and error) */
  rules?: NotificationRules
  /** Sessions with their status, for the "session finished" rule */
  sessions?: readonly Pick<SessionInfo, 'id' | 'label' | 'status'>[]
  /** Qualified session cost, for the cost threshold rule */
  cost?: UsageTotal
  /** The history is being replayed: what it contains is not news, nothing is sent */
  replaying?: boolean
  /** Native channel (VS Code): sends the item to the extension instead of the browser API; no browser permission involved */
  native?: (item: NotifyItem) => void
}

/**
 * Makes the agents that need the user visible outside the canvas (#126): the tab title carries their
 * number, and an opt-in notification fires when something new matches an enabled rule (#225): a permission, an error,
 * a finished session, a cost threshold. In a browser the notification is shown only while the tab is hidden and the
 * permission is requested only when the user turns the option on; in VS Code the item goes to the extension, which
 * shows a native message unless the panel has the focus.
 */
export function useAttentionAlerts(summary: AttentionSummary, options: AttentionAlertOptions = {}) {
  const { rules = DEFAULT_RULES, sessions, cost, replaying = false, native } = options
  const total = summary.total
  const nativeRef = useRef(native)
  nativeRef.current = native
  const isNative = native !== undefined

  useEffect(() => {
    if (typeof document === 'undefined') return
    const base = baseTitle(document.title)
    document.title = attentionTitle(base, total)
    return () => { document.title = base }
  }, [total])

  const [state, setState] = useState<NotifyState>('off')
  useEffect(() => {
    if (isNative) { setState(storedOptIn() ? 'on' : 'off'); return }
    const api = notificationApi()
    if (!api) { setState('unsupported'); return }
    if (api.permission === 'denied') { setState('denied'); return }
    setState(storedOptIn() && api.permission === 'granted' ? 'on' : 'off')
  }, [isNative])

  const toggle = useCallback(async () => {
    const remember = (on: boolean) => { try { localStorage.setItem(NOTIFY_STORAGE_KEY, on ? 'true' : 'false') } catch { /* storage unavailable */ } }
    if (state === 'on') { setState('off'); remember(false); return }
    if (nativeRef.current) { setState('on'); remember(true); return }
    const api = notificationApi()
    if (!api) return
    const permission = api.permission === 'granted' ? 'granted' : await api.requestPermission()
    if (permission === 'granted') {
      setState('on'); remember(true)
    } else {
      setState(permission === 'denied' ? 'denied' : 'off')
    }
  }, [state])

  const previousRef = useRef<NotifySnapshot | null>(null)
  useEffect(() => {
    const snapshot: NotifySnapshot = {
      ...emptySnapshot(),
      waitingIds: summary.waitingIds,
      errorIds: summary.errorIds,
      sessions: new Map((sessions ?? []).map(s => [s.id, { label: s.label, status: s.status }])),
      cost: cost ?? emptySnapshot().cost,
    }
    const items = evaluateTriggers(previousRef.current, snapshot, rules)
    previousRef.current = snapshot
    if (state !== 'on' || replaying || items.length === 0) return
    const send = nativeRef.current
    if (send) {
      for (const item of items) send(item)
      return
    }
    const api = notificationApi()
    if (!api || typeof document === 'undefined' || !document.hidden) return
    for (const item of items) {
      try { new api(item.title, { body: item.body, tag: `agent-lens-${item.trigger}` }) } catch { /* notifications blocked by the platform */ }
    }
  }, [summary, sessions, cost, rules, state, replaying])

  return { notifyState: state, toggleNotify: toggle }
}
