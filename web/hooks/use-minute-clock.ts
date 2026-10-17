'use client'

import { useEffect, useState } from 'react'

const MINUTE_MS = 60_000

/** `Date.now()` refreshed once a minute, so an age ("updated 12 min ago") and an expiry move without a re-render storm.
 *  Idle when `enabled` is false and while the document is hidden; it refreshes at once when the tab comes back. */
export function useMinuteClock(enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!enabled) return
    setNow(Date.now())
    let timer: ReturnType<typeof setInterval> | null = null
    const stop = () => {
      if (timer !== null) clearInterval(timer)
      timer = null
    }
    const start = () => {
      if (timer === null) timer = setInterval(() => setNow(Date.now()), MINUTE_MS)
    }
    const onVisibility = () => {
      if (document.hidden) {
        stop()
      } else {
        setNow(Date.now())
        start()
      }
    }
    if (!document.hidden) start()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      stop()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [enabled])
  return now
}
