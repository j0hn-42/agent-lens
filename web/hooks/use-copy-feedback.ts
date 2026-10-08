import { useCallback, useEffect, useRef, useState } from 'react'

const CLEAR_MS = 4000

/**
 * Result line of a copy / export action. The panel renders it in a polite live region (role="status"), so
 * the outcome is announced to screen readers and shown to everyone; it clears itself after a few seconds.
 * The same message twice in a row is re-announced (a trailing non-breaking space alternates).
 */
export function useCopyFeedback() {
  const [message, setMessage] = useState('')
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const flip = useRef(false)

  const notify = useCallback((text: string) => {
    if (timer.current) clearTimeout(timer.current)
    flip.current = !flip.current
    setMessage(flip.current ? text : `${text} `)
    timer.current = setTimeout(() => setMessage(''), CLEAR_MS)
  }, [])

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])
  return { message, notify }
}
