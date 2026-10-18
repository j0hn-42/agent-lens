'use client'

import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
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
 *  while the pointer is over it (WCAG 1.4.13). A role="group" is the focusable role the a11y lint allows.
 *  The group is named by the visible label (`labelId`) and described by `description`, so Tab announces the value, not
 *  only a name; the description node is aria-hidden (a description is read even from a hidden node) so it is not read twice. */
function FocusTip({ labelId, description, tip, children }: { labelId: string; description: string; tip: ReactNode; children: ReactNode }) {
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const descId = useId()
  const ref = useRef<HTMLSpanElement>(null)
  const tipRef = useRef<HTMLSpanElement>(null)
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
  // Escape closes the tooltip and nothing else: the app's own Escape (close the top panel, clear the selection) is a
  // window listener, so stopping the event here, only while the tooltip is open, keeps it from firing.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      setDismissed(true)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])
  // Near the right edge of a narrow window the tooltip is shifted back inside the viewport (reflow, WCAG 1.4.10)
  useLayoutEffect(() => {
    const el = tipRef.current
    if (!open || !el) return
    el.style.transform = ''
    const over = el.getBoundingClientRect().right - (window.innerWidth - 8)
    if (over > 0) el.style.transform = `translateX(-${Math.ceil(over)}px)`
  }, [open])
  return (
    <span
      ref={ref}
      role="group"
      aria-labelledby={labelId}
      aria-describedby={descId}
      tabIndex={0}
      className={`relative inline-flex items-center rounded ${FOCUS_RING}`}
    >
      {children}
      <span id={descId} aria-hidden="true" className="sr-only">{description}</span>
      {open && (
        // The padding, not a margin, spaces the box from the gauge: the pointer never leaves the hover area on its way there
        <span ref={tipRef} role="tooltip" className="absolute left-0 top-full z-10 w-max max-w-[min(16rem,calc(100vw-1rem))] whitespace-normal pt-1 text-[11px]">
          <span className="block rounded px-2 py-1" style={{ background: COLORS.surface, border: `1px solid ${COLORS.controlBorder}`, color: COLORS.textPrimary }}>
            {tip}
          </span>
        </span>
      )}
    </span>
  )
}

function Gauge({ kind, gauge, ageMinutes, interactive }: {
  kind: 'fiveHour' | 'sevenDay'
  gauge: GaugeView
  ageMinutes: number | null
  interactive: boolean
}) {
  const t = useT()
  const { locale } = useLocale()
  const labelId = useId()
  // One rounded number for the text, the bar and the meter: they cannot disagree
  const percent = Math.round(gauge.remainingPercent)
  const level = quotaLevel(percent)
  const color = levelColor(level)
  const name = t(kind === 'fiveHour' ? 'quota.name.fiveHour' : 'quota.name.sevenDay')
  const time = formatTime(gauge.resetsAt, locale)
  const reset = kind === 'sevenDay' ? t('quota.resetAtDay', { day: formatDay(gauge.resetsAt, locale), time }) : t('quota.resetAt', { time })
  const left = t('quota.left', { percent })
  const levelText = level === 'ok' ? null : t(level === 'low' ? 'quota.level.low' : 'quota.level.critical')
  // The age is part of the value: a figure that is minutes old is never announced as if it were fresh
  const value = [left, levelText, reset, ageMinutes !== null ? t('quota.updatedAgo', { minutes: ageMinutes }) : null].filter(Boolean).join(', ')
  const meter = (
    <span
      role="meter"
      aria-label={name}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      aria-valuetext={value}
      className="inline-flex items-center gap-1.5 whitespace-nowrap"
    >
      <span id={labelId} style={{ color: COLORS.textMuted }}>{t(kind === 'fiveHour' ? 'quota.window.fiveHour' : 'quota.window.sevenDay')}</span>
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
  return interactive ? <FocusTip labelId={labelId} description={value} tip={reset}>{meter}</FocusTip> : meter
}

/** The subscription quota of the top bar. Every state is told in words; a number is only ever a recorded one.
 *  The state is derived by the caller (quotaGaugeState); the gauges show only what it proves. The top bar itself is still
 *  English, so this part declares its own language. */
export function QuotaGauges({ state, interactive = true }: {
  state: QuotaGaugeState
  /** False when the bar is folded under 600 px: the figures stay readable but add no tab stop or tooltip */
  interactive?: boolean
}) {
  const t = useT()
  const { locale } = useLocale()
  const unknownId = useId()
  if (state.kind === 'hidden') return null
  if (state.kind === 'claude') {
    return (
      <span data-testid="topbar-quota" lang={locale} className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
        {state.fiveHour && <Gauge kind="fiveHour" gauge={state.fiveHour} ageMinutes={state.ageMinutes} interactive={interactive} />}
        {state.sevenDay && <Gauge kind="sevenDay" gauge={state.sevenDay} ageMinutes={state.ageMinutes} interactive={interactive} />}
        {/* Visible age; the meters already announce it */}
        {state.ageMinutes !== null && <span aria-hidden="true" style={{ color: COLORS.textMuted }}>{t('quota.updatedAgo', { minutes: state.ageMinutes })}</span>}
      </span>
    )
  }
  if (state.kind === 'unknown') {
    const text = t('quota.unknown')
    const help = t('quota.unknown.help')
    return (
      <span data-testid="topbar-quota" lang={locale}>
        {interactive
          ? <FocusTip labelId={unknownId} description={help} tip={help}><span id={unknownId} style={{ color: COLORS.textMuted }}>{text}</span></FocusTip>
          : <span style={{ color: COLORS.textMuted }}>{text}</span>}
      </span>
    )
  }
  // Exhaustiveness: a new QuotaGaugeState kind must fail tsc here instead of silently rendering nothing
  const exhaustive: never = state
  return exhaustive
}
