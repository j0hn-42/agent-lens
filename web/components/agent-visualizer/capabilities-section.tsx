'use client'

import type { ReactNode } from 'react'
import { COLORS } from '@/lib/colors'
import { FOCUS_RING_INSET } from '@/lib/focus-ring'
import {
  CAPABILITIES_READ_LIMIT_MB, groupSkillsByPlugin, type SessionCapabilities,
} from '@/lib/session-capabilities'

const TITLE_ID = 'context-capabilities-title'
/** Above this many skill rows the Skills group starts collapsed */
const SKILLS_OPEN_MAX = 12

const times = (n: number, lowerBound: boolean) => `${lowerBound ? 'at least ' : ''}${n} ${n === 1 ? 'time' : 'times'}`
const calls = (n: number, lowerBound: boolean, noun = 'call') => `${lowerBound ? 'at least ' : ''}${n} ${noun}${n === 1 ? '' : 's'}`

function Note({ children, color }: { children: ReactNode; color?: string }) {
  return <p className="text-[11px] font-mono py-1 m-0" style={{ color: color ?? COLORS.textMuted }}>{children}</p>
}

function Group({ title, open, children }: { title: string; open: boolean; children: ReactNode }) {
  return (
    <details open={open} className="mt-1">
      <summary className={`cursor-pointer text-[11px] font-mono rounded py-0.5 ${FOCUS_RING_INSET}`} style={{ color: COLORS.panelLabel }}>{title}</summary>
      <div className="pl-3">{children}</div>
    </details>
  )
}

const itemClass = 'text-[11px] font-mono'
const Name = ({ children }: { children: ReactNode }) => <span style={{ color: COLORS.assistantText }}>{children}</span>
const Detail = ({ children }: { children: ReactNode }) => <span style={{ color: COLORS.textMuted }}> — {children}</span>

function Body({ caps }: { caps: SessionCapabilities }) {
  const lower = caps.partial
  const groups = groupSkillsByPlugin(caps)
  const skillRows = groups.reduce((n, g) => n + g.skills.length, 0)
  const invokedCount = caps.skillsInvoked.length
  return (
    <>
      {caps.partial && (
        <Note color={COLORS.tool}>Partial: only the first {CAPABILITIES_READ_LIMIT_MB} MB of the transcript were read; counts are lower bounds.</Note>
      )}
      {caps.truncated && <Note color={COLORS.tool}>Lists capped at the relay limit: some entries are not shown.</Note>}

      <Group title={`Instructions loaded (${caps.instructions.length})`} open>
        {caps.instructions.length === 0 ? <Note>No instructions attachment in the transcript.</Note> : (
          <ul className="list-none p-0 m-0">
            {caps.instructions.map(f => (
              <li key={`${f.type}/${f.name}`} className={itemClass}><Name>{f.name}</Name><Detail>{f.type}</Detail></li>
            ))}
          </ul>
        )}
      </Group>

      <Group title={`Skills (${invokedCount} invoked, ${skillRows} seen)`} open={skillRows <= SKILLS_OPEN_MAX}>
        {skillRows === 0 ? <Note>No skill listing or Skill call in the transcript.</Note> : (
          <ul className="list-none p-0 m-0">
            {groups.map(g => {
              const label = g.plugin ?? 'No plugin'
              return (
                <li key={label} className={`${itemClass} mt-0.5`}>
                  <span style={{ color: COLORS.panelLabel }}>{g.plugin === null ? label : `Plugin ${label}`}</span>
                  <ul aria-label={g.plugin === null ? 'Skills without plugin' : `Skills of plugin ${label}`} className="list-none pl-3 m-0">
                    {g.skills.map(s => (
                      <li key={s.fullName} className={itemClass} title={s.fullName}>
                        <Name>{s.name}</Name>
                        <Detail>{s.calls > 0 ? `invoked ${times(s.calls, lower)}` : 'listed, no invocation seen'}</Detail>
                      </li>
                    ))}
                  </ul>
                </li>
              )
            })}
          </ul>
        )}
      </Group>

      <Group title={`MCP servers (${caps.mcpServers.length})`} open>
        {caps.mcpServers.length === 0 ? <Note>No MCP server announced or called in the transcript.</Note> : (
          <ul className="list-none p-0 m-0">
            {caps.mcpServers.map(s => (
              <li key={s.name} className={`${itemClass} mt-0.5`}>
                <Name>{s.name}</Name>
                <Detail>
                  {s.announced ? 'announced' : 'not announced in the transcript'}
                  {' · '}
                  {s.calls > 0 ? calls(s.calls, lower, 'tool call') : 'no tool call seen'}
                </Detail>
                {s.tools.length > 0 && (
                  <ul aria-label={`Tools called on ${s.name}`} className="list-none pl-3 m-0">
                    {s.tools.map(t => (
                      <li key={t.name} className={itemClass}><Name>{t.name}</Name><Detail>{calls(t.calls, lower)}</Detail></li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        )}
      </Group>
    </>
  )
}

/**
 * Capabilities of the session (#242), from its main transcript only: what it received or used, not what is
 * installed. Native disclosures (keyboard: Tab, Enter/Space). Unknown, partial and absent are said in words.
 */
export function CapabilitiesSection({ capabilities }: { capabilities: SessionCapabilities | 'invalid' | undefined }) {
  return (
    <section aria-labelledby={TITLE_ID} className="mb-2">
      <h3 id={TITLE_ID} className="m-0 text-[11px] font-mono font-semibold tracking-wider" style={{ color: COLORS.panelLabel }}>CAPABILITIES</h3>
      <Note>From the session transcript: what this session received or used, not what is installed. Sub-agents are not included.</Note>
      {capabilities === undefined ? <Note>Not provided by this relay.</Note>
        : capabilities === 'invalid' ? <Note color={COLORS.error}>The relay sent the capabilities in an unexpected shape; they are not shown.</Note>
        : capabilities.status === 'unreadable' ? <Note color={COLORS.error}>The session transcript could not be read: its capabilities are unknown.</Note>
        : <Body caps={capabilities} />}
    </section>
  )
}
