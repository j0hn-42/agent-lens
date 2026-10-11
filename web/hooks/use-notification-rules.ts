'use client'

import { useCallback, useEffect, useState } from 'react'
import { DEFAULT_RULES, NOTIFY_RULES_STORAGE_KEY, parseRules, serializeRules, type NotificationRules } from '@/lib/notification-rules'

/**
 * The notification rules (#225), kept in this browser's local storage. Read after mount so the server render and the
 * first client render agree; an unavailable storage leaves the defaults and the choice lasts for the session only.
 */
export function useNotificationRules() {
  const [rules, setRulesState] = useState<NotificationRules>({ ...DEFAULT_RULES })

  useEffect(() => {
    try { setRulesState(parseRules(localStorage.getItem(NOTIFY_RULES_STORAGE_KEY))) } catch { /* storage unavailable */ }
  }, [])

  const setRules = useCallback((next: NotificationRules) => {
    setRulesState(next)
    try { localStorage.setItem(NOTIFY_RULES_STORAGE_KEY, serializeRules(next)) } catch { /* storage unavailable */ }
  }, [])

  return { rules, setRules }
}
