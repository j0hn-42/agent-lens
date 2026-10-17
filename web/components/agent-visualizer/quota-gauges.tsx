'use client'

import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { COLORS } from '@/lib/colors'
import { FOCUS_RING } from '@/lib/focus-ring'
import { useLocale, useT } from '@/lib/locale'
import type { Locale } from '@/lib/messages'
import type { GaugeView, QuotaGaugeState } from '@/lib/quota'

/** Under this share of the window left (after rounding, as displayed) the gauge is "low", and under the second one "critical".
 *  The level is always said in words and with an icon beside the colour. */
const QUOTA_LOW_BELOW = 25
const QUOTA_CRITICAL_BELOW = 10

type Level = 'ok' | 'low' | 'critical'

function quotaLevel(displayedPercent: number): Level {
  return displayedPercent < QUOTA_CRITICAL_BELOW ? 'critical' : displayedPercent < QUOTA_LOW_BELOW ? 'low' : 'ok'
}

const levelColor = (level: Level) => (level === 'critical' ? COLORS.quotaCritical : level === 'low' ? COLORS.quotaLow : COLORS.quotaOk)

/** HH:MM, 24 h in both languages ("16:40"); `resetsAt` is epoch seconds */
function formatTime(resetsAt: number, locale: Locale): string {
  return new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(resetsAt * 1000))
}

function formatDay(resetsAt: number, locale: Locale): string {
  return new Intl.DateTimeFormat(locale, { weekday: 'short' }).format(new Date(resetsAt * 1000))
}

function LevelIcon({ level }: { level: 'low' | 'critical' }) {
  const color = levelColor(level)
  return (
    <svg aria-hidden="true" focusable="false" width="10" height="10" viewBox="0 0 10 10" className="shrink-0">
      {level === 'low'
        ? <path d="M5 1 L9.5 9 L0.5 9 Z" fill={color} />
        : <path d="M3 0.5 H7 L9.5 3 V7 L7 9.5 H3 L0.5 7 V3 Z M3.2 3.2 L6.8 6.8 M6.8 3.2 L3.2 6.8" fill={color} stroke={COLORS.void} strokeWidth="1.2" />}
    </svg>
  )
}

/** Focusable wrapper whose detail (a tooltip) shows on hover and on keyboard focus, is dismissed with Escape and stays
 *  while the pointer is over it (WCAG 1.4.13). A role="group" is the focusable role the a11y lint allows. */
function FocusTip({ label, tip, help, children }: { label: string; tip: ReactNode; help?: string; children: ReactNode }) {
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const helpId = useId()
  const ref = useRef<HTMLSpanElement>(null)
  const open = (hovered || focused) && !dismissed
  // Native listeners: the lint rules out pointer and focus handlers on a non-interactive role in JSX
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const enter = () => { setHovered(true); setDismissed(false) }
    const leave = () => setHovered(false)
    const focus = () => { setFocused(true); setDismissed(false) }
    const blur = () => setFocused(false)
    el.addEventListener('mouseenter', enter)
    el.addEventListener('mouseleave', leave)
    el.addEventListener('focus', focus)
    el.addEventListener('blur', blur)
    return () => {
      el.removeEventListener('mouseenter', enter)
      el.removeEventListener('mouseleave', leave)
      el.removeEventListener('focus', focus)
      el.removeEventListener('blur', blur)
    }
  }, [])
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setDismissed(true) }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])
  return (
    <span
      ref={ref}
      role="group"
      aria-label={label}
      aria-describedby={help ? helpId : undefined}
      tabIndex={0}
      className={`relative inline-flex items-center rounded ${FOCUS_RING}`}
    >
      {children}
      {help && <span id={helpId} className="sr-only">{help}</span>}
      {open && (
        <span
          role="tooltip"
          className="absolute left-0 top-full z-10 mt-1 w-max max-w-64 whitespace-normal rounded px-2 py-1 text-[11px]"
          style={{ background: COLORS.surface, border: `1px solid ${COLORS.controlBorder}`, color: COLORS.textPrimary }}
        >
          {tip}
        </span>
      )}
    </span>
  )
}

function Gauge({ kind, gauge, interactive }: { kind: 'fiveHour' | 'sevenDay'; gauge: GaugeView; interactive: boolean }) {
  const t = useT()
  const { locale } = useLocale()
  // One rounded number for the text, the bar and the meter: they cannot disagree
  const percent = Math.round(gauge.remainingPercent)
  const level = quotaLevel(percent)
  const color = levelColor(level)
  const name = t(kind === 'fiveHour' ? 'quota.name.fiveHour' : 'quota.name.sevenDay')
  const time = formatTime(gauge.resetsAt, locale)
  const reset = kind === 'sevenDay' ? t('quota.resetAtDay', { day: formatDay(gauge.resetsAt, locale), time }) : t('quota.resetAt', { time })
  const left = t('quota.left', { percent })
  const levelText = level === 'ok' ? null : t(level === 'low' ? 'quota.level.low' : 'quota.level.critical')
  const meter = (
    <span
      role="meter"
      aria-label={name}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      aria-valuetext={[left, levelText, reset].filter(Boolean).join(', ')}
      className="inline-flex items-center gap-1.5 whitespace-nowrap"
    >
      <span style={{ color: COLORS.textMuted }}>{t(kind === 'fiveHour' ? 'quota.window.fiveHour' : 'quota.window.sevenDay')}</span>
      <span aria-hidden="true" className="inline-block h-1.5 w-12 overflow-hidden rounded-sm" style={{ border: `1px solid ${COLORS.controlBorder}`, boxSizing: 'content-box' }}>
        <span className="block h-full" style={{ width: `${percent}%`, background: color }} />
      </span>
      <span style={{ color }}>{left}</span>
      {levelText && level !== 'ok' && (
        <span className="inline-flex items-center gap-1" style={{ color }}>
          <LevelIcon level={level} />
          {levelText}
        </span>
      )}
    </span>
  )
  return interactive ? <FocusTip label={name} tip={reset}>{meter}</FocusTip> : meter
}

/** The subscription quota of the top bar. Every state is told in words; a number is only ever a recorded one. */
export function QuotaGauges({ state, interactive = true }: {
  state: QuotaGaugeState
  /** Milliseconds. The state is derived from it by the caller (quotaGaugeState); the gauges show only what the state proves */
  now?: number
  /** False when the bar is folded under 600 px: the figures stay readable but add no tab stop or tooltip */
  interactive?: boolean
}) {
  const t = useT()
  if (state.kind === 'hidden') return null
  if (state.kind === 'claude') {
    return (
      <span data-testid="topbar-quota" className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
        {state.fiveHour && <Gauge kind="fiveHour" gauge={state.fiveHour} interactive={interactive} />}
        {state.sevenDay && <Gauge kind="sevenDay" gauge={state.sevenDay} interactive={interactive} />}
        {state.ageMinutes !== null && <span style={{ color: COLORS.textMuted }}>{t('quota.updatedAgo', { minutes: state.ageMinutes })}</span>}
      </span>
    )
  }
  if (state.kind === 'unknown') {
    const text = t('quota.unknown')
    const help = t('quota.unknown.help')
    return (
      <span data-testid="topbar-quota">
        {interactive
          ? <FocusTip label={text} tip={help} help={help}><span style={{ color: COLORS.textMuted }}>{text}</span></FocusTip>
          : <span style={{ color: COLORS.textMuted }}>{text}</span>}
      </span>
    )
  }
  return (
    <span data-testid="topbar-quota" style={{ color: COLORS.textMuted }}>
      {t(state.kind === 'unavailable' ? 'quota.unavailable' : 'quota.noSubscription')}
    </span>
  )
}
