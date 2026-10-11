'use client'

import { useEffect, useState } from 'react'
import { ISSUE_LINKS_CACHE_TTL_MS, ISSUE_LINKS_MAX_RETRIES, issueLinksRetryDelayMs } from '@/lib/issue-links'
import { loadSessionWork, type SessionWork } from '@/lib/session-work'

const CACHE_MAX_SESSIONS = 32
const cache = new Map<string, { at: number; work: SessionWork }>()

/** 'idle': nothing asked; 'loading': first answer pending; 'ok': the relay answered; 'unknown-project': the relay does not know where the session works; 'unavailable': the last attempt failed */
export type SessionWorkStatus = 'idle' | 'loading' | 'ok' | 'unknown-project' | 'unavailable'

export interface SessionWorkState {
  status: SessionWorkStatus
  work?: SessionWork
}

const IDLE: SessionWorkState = { status: 'idle' }
const LOADING: SessionWorkState = { status: 'loading' }
const UNKNOWN: SessionWorkState = { status: 'unknown-project' }
const UNAVAILABLE: SessionWorkState = { status: 'unavailable' }

/**
 * Open PRs by branch and issues without an agent for the project of `sessionId`, from the relay. Requested only
 * while `active` (the panel is open) with a relay origin and a session. Only a successful answer (a true empty
 * list included) is cached for 60 s; a failure is 'unavailable', never cached, and retried with the backoff of the
 * issue links (honouring Retry-After).
 */
export function useSessionWork(origin: string | null | undefined, sessionId: string | null | undefined, active: boolean): SessionWorkState {
  const [state, setState] = useState<SessionWorkState>(IDLE)

  useEffect(() => {
    if (!active || origin == null || !sessionId) { setState(IDLE); return }
    const key = `${origin}|${sessionId}`
    const hit = cache.get(key)
    if (hit && Date.now() - hit.at < ISSUE_LINKS_CACHE_TTL_MS) { setState({ status: 'ok', work: hit.work }); return }
    setState(LOADING)
    const ctrl = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined

    const attempt = (n: number) => {
      void loadSessionWork(origin, sessionId, (url, init) => fetch(url, init), ctrl.signal).then(result => {
        if (ctrl.signal.aborted) return
        if (result.status === 'ok') {
          if (cache.size >= CACHE_MAX_SESSIONS) {
            const oldest = cache.keys().next().value
            if (oldest !== undefined) cache.delete(oldest)
          }
          cache.set(key, { at: Date.now(), work: result.work })
          setState({ status: 'ok', work: result.work })
        } else if (result.status === 'unknown-project') {
          setState(UNKNOWN)
        } else {
          setState(UNAVAILABLE)
          if (n < ISSUE_LINKS_MAX_RETRIES) timer = setTimeout(() => attempt(n + 1), issueLinksRetryDelayMs(n, result.retryAfterMs))
        }
      })
    }
    attempt(0)
    return () => { ctrl.abort(); if (timer !== undefined) clearTimeout(timer) }
  }, [origin, sessionId, active])

  return state
}
