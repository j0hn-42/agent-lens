import { useEffect, useRef, useState, type RefObject } from 'react'
import { HIDDEN_NAMES_INITIAL, NO_HIDDEN_NAMES, stepHiddenNames, type HiddenNamesDisplay } from '@/lib/hidden-names-display'

/** How often the "N names hidden" button reads the count of the last planned frame (#594) */
const HIDDEN_NAMES_POLL_MS = 200

/** The "names hidden" button has the keyboard focus (it is kept while focused, see stepHiddenNames) */
function buttonFocused(): boolean {
  const a = typeof document === 'undefined' ? null : document.activeElement
  return a instanceof HTMLElement && a.hasAttribute('data-hidden-names')
}

/**
 * Reads the plan's count (written by the draw loop into `countRef`) every HIDDEN_NAMES_POLL_MS and returns what the
 * button shows (stepHiddenNames): React state changes only when that changes.
 */
export function useHiddenNamesDisplay(countRef: RefObject<number>, isCameraBusy: () => boolean): HiddenNamesDisplay {
  const [display, setDisplay] = useState<HiddenNamesDisplay>(NO_HIDDEN_NAMES)
  const stateRef = useRef(HIDDEN_NAMES_INITIAL)
  const busyRef = useRef(isCameraBusy)
  busyRef.current = isCameraBusy
  useEffect(() => {
    const timer = setInterval(() => {
      const next = stepHiddenNames(stateRef.current, {
        raw: countRef.current ?? 0, now: Date.now(), cameraBusy: busyRef.current(), focused: buttonFocused(),
      })
      stateRef.current = next
      setDisplay(prev => (prev.shown === next.shown && prev.count === next.count ? prev : { shown: next.shown, count: next.count }))
    }, HIDDEN_NAMES_POLL_MS)
    return () => clearInterval(timer)
  }, [countRef])
  return display
}
