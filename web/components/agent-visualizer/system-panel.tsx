'use client'

import { useEffect, useId, useRef, useState } from 'react'
import { Z } from '@/lib/agent-types'
import { COLORS } from '@/lib/colors'
import { FOCUS_RING_INSET } from '@/lib/focus-ring'
import { useLocale } from '@/lib/locale'
import { translate } from '@/lib/messages'
import { panelName } from '@/lib/command-palette'
import type { SystemSample, SystemUsage } from '@/lib/bridge-types'
import { ratio, severity, summarise, type Severity } from '@/lib/system-stats'
import { CollapsibleSection } from './collapsible-section'
import { PanelHeader, SlidingPanel, useDockPanel, dockAttrs } from './shared-ui'
import { DETAIL_SIZE } from '@/lib/panel-layout'

interface SystemPanelProps {
  visible: boolean
  /** Ring buffer of the relay's samples (oldest first); empty before the first one and after a disconnect */
  samples: readonly SystemSample[]
  /** Set when the relay's metrics cannot reach this view (VS Code, demo): states why instead of the gauges */
  unavailableReason?: string
  onClose: () => void
}

interface Metric {
  label: string
  pick: (s: SystemSample) => number | null
  /** Memory-like metrics also show their bytes */
  usage?: (s: SystemSample) => SystemUsage | null
  /** Only swap may have a size of 0 by design ("No swap"); a memory or disk of size 0 is unmeasured */
  zeroMeansNone?: boolean
}

const METRICS: readonly Metric[] = [
  { label: 'CPU', pick: s => s.cpu.total },
  { label: 'Memory', pick: s => ratio(s.mem), usage: s => s.mem },
  { label: 'Swap', pick: s => ratio(s.swap), usage: s => s.swap, zeroMeansNone: true },
  { label: 'Disk', pick: s => ratio(s.disk), usage: s => s.disk },
]

const SEVERITY_TEXT: Record<Severity, string> = { normal: 'Normal', warm: 'Warm', critical: 'Critical', unknown: 'Not available' }

const severityColor = (s: Severity) =>
  s === 'critical' ? COLORS.systemCritical : s === 'warm' ? COLORS.systemWarm : s === 'normal' ? COLORS.ok : COLORS.textMuted

/**
 * Whole percent shown, read and announced: the floor, so it never overstates and always agrees with the severity
 * computed on the raw share (85 % shown is always Warm or worse, 95 % always Critical). The epsilon keeps
 * 0.29 * 100 = 28.999999999999996 at 29.
 */
const percent = (r: number) => {
  const shown = Math.floor(r * 100 + 1e-9)
  // The epsilon can lift a share just below a threshold onto it: cap by the severity of the raw share.
  const level = severity(r)
  if (level === 'critical') return shown
  if (level === 'warm') return Math.min(shown, 94)
  return Math.min(shown, 84)
}

/** web/lib/system-stats.ts caps the parsed per-core list at this length: reaching it means "at least". */
const MAX_CORES_SHOWN = 256

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'] as const
function formatBytes(bytes: number): string {
  let v = bytes, i = 0
  while (v >= 1024 && i < BYTE_UNITS.length - 1) { v /= 1024; i++ }
  return i === 0 ? `${Math.round(v)} B` : `${v.toFixed(1)} ${BYTE_UNITS[i]}`
}

function formatDuration(seconds: number): string {
  const s = Math.floor(seconds)
  if (s < 60) return `${s} s`
  const min = Math.floor(s / 60)
  if (min < 60) return `${min} min`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h} h ${min % 60} min`
  return `${Math.floor(h / 24)} d ${h % 24} h`
}

/** Window the buffer actually covers, from the samples' own timestamps (null with fewer than two samples). */
function windowText(samples: readonly SystemSample[]): string | null {
  if (samples.length < 2) return null
  const seconds = (samples[samples.length - 1].ts - samples[0].ts) / 1000
  if (!(seconds > 0)) return null
  // Floor, never overstating the window; seconds below 2 min so 90 s does not read as 1 or 2 min
  return seconds >= 120 ? `${Math.floor(seconds / 60)} min` : `${Math.floor(seconds)} s`
}

function summaryText(samples: readonly SystemSample[], pick: (s: SystemSample) => number | null): string | null {
  const { current, max } = summarise(samples, pick)
  if (current === null && max === null) return null
  const now = current === null ? 'Current not available' : `Current ${percent(current)} %`
  const span = windowText(samples)
  return max === null || span === null ? now : `${now}, max ${percent(max)} % over the last ${span}`
}

/** One shape per severity, so it never rests on colour alone (the word sits next to it). */
function SeverityIcon({ level }: { level: Severity }) {
  const color = severityColor(level)
  return (
    <svg data-severity-icon={level} aria-hidden="true" focusable="false" width="10" height="10" viewBox="0 0 10 10" className="shrink-0">
      {level === 'normal' && <circle cx="5" cy="5" r="4" fill={color} />}
      {level === 'warm' && <path d="M5 1 L9.5 9 L0.5 9 Z" fill={color} />}
      {level === 'critical' && <path d="M3 0.5 H7 L9.5 3 V7 L7 9.5 H3 L0.5 7 V3 Z M3.2 3.2 L6.8 6.8 M6.8 3.2 L3.2 6.8" fill={color} stroke={COLORS.void} strokeWidth="1.2" />}
      {level === 'unknown' && <circle cx="5" cy="5" r="3.5" fill="none" stroke={color} strokeWidth="1.2" strokeDasharray="1.5 1.5" />}
    </svg>
  )
}

function SeverityLabel({ level }: { level: Severity }) {
  return (
    <span className="inline-flex items-center gap-1 text-xs font-mono" style={{ color: level === 'unknown' ? COLORS.textMuted : severityColor(level) }}>
      <SeverityIcon level={level} />
      {SEVERITY_TEXT[level]}
    </span>
  )
}

/** A measured share as a meter. ARIA requires aria-valuenow on a meter, so an unmeasured value gets no meter at all. */
function Gauge({ label, value, level, thin }: { label: string; value: number; level: Severity; thin?: boolean }) {
  const pct = percent(value)
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      aria-valuetext={`${pct} %, ${SEVERITY_TEXT[level]}`}
      className={`${thin ? 'h-1' : 'h-1.5'} rounded-full overflow-hidden`}
      style={{ background: COLORS.holoBg10 }}
    >
      <div
        data-bar-fill
        className="h-full rounded-full transition-[width] duration-500 motion-reduce:transition-none"
        style={{ width: `${Math.min(100, Math.max(0, pct))}%`, background: severityColor(level) }}
      />
    </div>
  )
}

/** Decorative trend line; the text summary next to it carries the information. A null breaks the line. */
function Sparkline({ samples, pick }: { samples: readonly SystemSample[]; pick: (s: SystemSample) => number | null }) {
  const W = 64, H = 16
  const step = samples.length > 1 ? W / (samples.length - 1) : 0
  const runs: string[] = []
  let run: string[] = []
  samples.forEach((s, i) => {
    const v = pick(s)
    if (v === null) { if (run.length) runs.push(run.join(' ')); run = []; return }
    run.push(`${(i * step).toFixed(1)},${(H - 1 - Math.min(1, Math.max(0, v)) * (H - 2)).toFixed(1)}`)
  })
  if (run.length) runs.push(run.join(' '))
  return (
    <svg data-sparkline aria-hidden="true" focusable="false" width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="shrink-0">
      {runs.map((points, i) => points.includes(' ')
        ? <polyline key={i} points={points} fill="none" stroke={COLORS.textMuted} strokeWidth="1" />
        : <circle key={i} cx={points.split(',')[0]} cy={points.split(',')[1]} r="1" fill={COLORS.textMuted} />)}
    </svg>
  )
}

function MetricRow({ metric, samples }: { metric: Metric; samples: readonly SystemSample[] }) {
  const last = samples[samples.length - 1]
  const use = metric.usage?.(last) ?? null
  if (metric.zeroMeansNone && use && use.total === 0) {
    return (
      <div data-metric={metric.label} className="py-1.5 flex items-baseline justify-between gap-2 text-xs font-mono">
        <span style={{ color: COLORS.textPrimary }}>{metric.label}</span>
        <span style={{ color: COLORS.textMuted }}>No swap</span>
      </div>
    )
  }
  const value = metric.pick(last)
  const level = severity(value)
  const summary = summaryText(samples, metric.pick)
  return (
    <div data-metric={metric.label} className="py-1.5 flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-2 text-xs font-mono">
        <span style={{ color: COLORS.textPrimary }}>{metric.label}</span>
        {value !== null && (
          <span className="text-right" style={{ color: COLORS.textPrimary }}>
            {percent(value)} %{use ? ` · ${formatBytes(use.used)} of ${formatBytes(use.total)}` : ''}
          </span>
        )}
      </div>
      {value !== null && <Gauge label={metric.label} value={value} level={level} />}
      <SeverityLabel level={level} />
      {summary && (
        <div className="flex items-center gap-2">
          <Sparkline samples={samples} pick={metric.pick} />
          <span className="text-xs font-mono" style={{ color: COLORS.textMuted }}>{summary}</span>
        </div>
      )}
    </div>
  )
}

function CoreDetail({ cores }: { cores: readonly (number | null)[] }) {
  const [open, setOpen] = useState(false)
  const id = `${useId()}-cores`
  return (
    <div className="pt-1">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(o => !o)}
        className={`w-full text-left text-xs font-mono min-h-6 px-1 rounded ${FOCUS_RING_INSET}`}
        style={{ color: COLORS.textMuted }}
      >
        <span aria-hidden="true">{open ? '▾' : '▸'} </span>Per-core detail ({cores.length >= MAX_CORES_SHOWN ? `${MAX_CORES_SHOWN}+ logical CPUs` : `${cores.length} logical CPU${cores.length === 1 ? '' : 's'}`})
      </button>
      <CollapsibleSection open={open}>
        <div id={id} className="flex flex-col gap-1 pt-1">
          {cores.map((v, i) => {
            const label = `Core ${i + 1}`
            const level = severity(v)
            return (
              <div key={i} data-metric={label} className="grid grid-cols-[3.5rem_1fr_auto] items-center gap-2 text-xs font-mono">
                <span style={{ color: COLORS.textPrimary }}>{label}</span>
                {v !== null ? <Gauge label={label} value={v} level={level} thin /> : <span />}
                <span className="inline-flex items-center gap-1 text-right">
                  {v !== null && <span style={{ color: COLORS.textPrimary }}>{percent(v)} %</span>}
                  <SeverityLabel level={level} />
                </span>
              </div>
            )
          })}
        </div>
      </CollapsibleSection>
    </div>
  )
}

/**
 * Polite announcement of a severity CHANGE only (never of a plain 2 s sample). The first reading of a metric is
 * a baseline, announced only when it is already warm or critical; an unmeasured reading changes nothing.
 */
function useSeverityAnnouncement(samples: readonly SystemSample[], visible: boolean): string {
  const previous = useRef(new Map<string, Severity>())
  const [message, setMessage] = useState('')
  const last = samples.length ? samples[samples.length - 1] : null
  useEffect(() => {
    // A closed panel keeps no message: reopened later, the region must not hold a severity that has since changed.
    // With the region emptied on close and on disconnect, two announcements in a row always differ while it is open
    // (a metric announced critical has to be announced as something else before it can be critical again), so the
    // same words never fail to reach the screen reader for want of a DOM change.
    if (!visible) setMessage('')
    // An empty buffer is a new connection: no message, and its first readings are baselines again
    if (!last) { previous.current.clear(); setMessage(''); return }
    const changes: string[] = []
    for (const m of METRICS) {
      const value = m.pick(last)
      const level = severity(value)
      if (value === null || level === 'unknown') continue
      const before = previous.current.get(m.label)
      previous.current.set(m.label, level)
      if (before === level || (before === undefined && level === 'normal')) continue
      changes.push(`${m.label} is ${SEVERITY_TEXT[level].toLowerCase()}, ${percent(value)} %`)
    }
    if (changes.length && visible) setMessage(changes.join('. '))
  }, [last, visible])
  return message
}

export function SystemPanel({ visible, samples, unavailableReason, onClose }: SystemPanelProps) {
  // Left dock, below the agent detail card (non-exclusive: it closes no other panel)
  const dock = useDockPanel('system', visible)
  const { rect } = dock
  const titleId = useId()
  const { locale } = useLocale()
  const announcement = useSeverityAnnouncement(samples, visible)
  // The body is a scroll container: a tab stop only while it actually scrolls (WCAG 2.1.1), as in the Context panel
  const bodyRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = bodyRef.current
    if (!el) return
    if (el.scrollHeight > el.clientHeight + 1) el.setAttribute('tabindex', '0')
    else el.removeAttribute('tabindex')
  })

  if (!visible) return null

  const last = samples.length ? samples[samples.length - 1] : null
  const cores = last?.cpu.perCore ?? []
  const showCores = cores.some(c => c !== null)

  return (
    <SlidingPanel
      visible={visible}
      position={rect ? { top: rect.y, left: rect.x } : { top: 'calc(var(--topbar-h, 60px) + 8px)', left: 12 }}
      zIndex={Z.sidePanel}
      width={rect?.w ?? DETAIL_SIZE.w}
      labelledBy={titleId}
      attrs={dockAttrs('system', 'left', dock, visible)}
      style={dock.hidden ? { display: 'none' } : undefined}
    >
      <div className="glass-card relative flex flex-col" style={{ maxHeight: rect?.h, background: COLORS.void }}>
        <PanelHeader onClose={onClose} titleId={titleId}>
          <span lang={locale} className="text-xs font-mono tracking-wider uppercase" style={{ color: COLORS.textPrimary }}>{panelName(locale, 'system')}</span>
        </PanelHeader>
        <div role="status" aria-live="polite" aria-atomic="true" className="sr-only" data-system-announcer>{announcement}</div>

        <div
          ref={bodyRef}
          role="group"
          aria-label="Machine health"
          className={`min-h-0 flex-1 overflow-y-auto ${FOCUS_RING_INSET}`}
          style={{ scrollbarWidth: 'thin' }}
        >
          {unavailableReason ? (
            <p className="text-xs font-mono py-2 m-0" style={{ color: COLORS.textMuted }}>{unavailableReason}</p>
          ) : !last ? (
            <p className="text-xs font-mono py-2 m-0" style={{ color: COLORS.textMuted }}>Waiting for the first measurement</p>
          ) : (
            <>
              {METRICS.map(m => <MetricRow key={m.label} metric={m} samples={samples} />)}
              {showCores && <CoreDetail cores={cores} />}
              <dl className="m-0 pt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs font-mono">
                <dt style={{ color: COLORS.textMuted }}>Load 1 / 5 / 15</dt>
                <dd className="m-0 text-right" style={{ color: COLORS.textPrimary }}>
                  {last.load ? last.load.map(l => l.toFixed(2)).join(' / ') : 'Not available'}
                </dd>
                <dt style={{ color: COLORS.textMuted }}>Uptime</dt>
                <dd className="m-0 text-right" style={{ color: COLORS.textPrimary }}>
                  {last.uptime !== null ? formatDuration(last.uptime) : 'Not available'}
                </dd>
              </dl>
              {last.platformNote && (
                <p className="text-[11px] font-mono pt-2 m-0" style={{ color: COLORS.textMuted }}>{last.platformNote}</p>
              )}
            </>
          )}
        </div>
      </div>
    </SlidingPanel>
  )
}
