'use client'

import type { ReactNode } from 'react'
import { COLORS } from '@/lib/colors'
import { FOCUS_RING_INSET } from '@/lib/focus-ring'
import {
  CAPABILITIES_READ_LIMIT_MB, groupSkillsByPlugin, type SessionCapabilities,
} from '@/lib/session-capabilities'
import { useLocale } from '@/lib/locale'
import type { Locale } from '@/lib/messages'
import { DATA_EN, t as tr, capTimesText, capCallsText } from '@/lib/panel-text'

const TITLE_ID = 'context-capabilities-title'
/** Above this many skill rows the Skills group starts collapsed */
const SKILLS_OPEN_MAX = 12


function Note({ children, color }: { children: ReactNode; color?: string }) {
  return <p className="text-2xs font-mono py-1 m-0" style={{ color: color ?? COLORS.textMuted }}>{children}</p>
}

function Group({ title, open, children }: { title: string; open: boolean; children: ReactNode }) {
  return (
    <details open={open} className="mt-1">
      <summary className={`cursor-pointer text-2xs font-mono rounded py-0.5 ${FOCUS_RING_INSET}`} style={{ color: COLORS.panelLabel }}>{title}</summary>
      <div className="pl-3">{children}</div>
    </details>
  )
}

const itemClass = 'text-2xs font-mono'
const Name = ({ children }: { children: ReactNode }) => <span {...DATA_EN} style={{ color: COLORS.assistantText }}>{children}</span>
const Detail = ({ children }: { children: ReactNode }) => <span style={{ color: COLORS.textMuted }}> — {children}</span>

function Body({ caps, locale }: { caps: SessionCapabilities; locale: Locale }) {
  const t = (key: Parameters<typeof tr>[1], params?: Parameters<typeof tr>[2]) => tr(locale, key, params)
  const lower = caps.partial
  const groups = groupSkillsByPlugin(caps)
  const skillRows = groups.reduce((n, g) => n + g.skills.length, 0)
  const invokedCount = caps.skillsInvoked.length
  return (
    <>
      {caps.partial && (
        <Note color={COLORS.tool}>{t('cap.partial', { mb: CAPABILITIES_READ_LIMIT_MB })}</Note>
      )}
      {caps.truncated && <Note color={COLORS.tool}>{t('cap.truncated')}</Note>}

      <Group title={t('cap.instructions', { n: caps.instructions.length })} open>
        {caps.instructions.length === 0 ? <Note>{t('cap.instructions.none')}</Note> : (
          <ul className="list-none p-0 m-0">
            {caps.instructions.map(f => (
              <li key={`${f.type}/${f.name}`} className={itemClass}><Name>{f.name}</Name><Detail>{f.type}</Detail></li>
            ))}
          </ul>
        )}
      </Group>

      <Group title={t('cap.skills', { invoked: invokedCount, seen: skillRows })} open={skillRows <= SKILLS_OPEN_MAX}>
        {skillRows === 0 ? <Note>{t('cap.skills.none')}</Note> : (
          <ul className="list-none p-0 m-0">
            {groups.map(g => {
              const label = g.plugin ?? t('cap.noPlugin')
              return (
                <li key={label} className={`${itemClass} mt-0.5`}>
                  <span style={{ color: COLORS.panelLabel }}>{g.plugin === null ? label : t('cap.plugin', { name: label })}</span>
                  <ul aria-label={g.plugin === null ? t('cap.skillsNoPlugin') : t('cap.skillsOfPlugin', { name: label })} className="list-none pl-3 m-0">
                    {g.skills.map(s => (
                      <li key={s.fullName} className={itemClass} title={s.fullName}>
                        <Name>{s.name}</Name>
                        <Detail>{s.calls > 0 ? t('cap.invoked', { times: capTimesText(locale, s.calls, lower) }) : t('cap.listedOnly')}</Detail>
                      </li>
                    ))}
                  </ul>
                </li>
              )
            })}
          </ul>
        )}
      </Group>

      <Group title={t('cap.mcp', { n: caps.mcpServers.length })} open>
        {caps.mcpServers.length === 0 ? <Note>{t('cap.mcp.none')}</Note> : (
          <ul className="list-none p-0 m-0">
            {caps.mcpServers.map(s => (
              <li key={s.name} className={`${itemClass} mt-0.5`}>
                <Name>{s.name}</Name>
                <Detail>
                  {s.announced ? t('cap.mcp.announced') : t('cap.mcp.notAnnounced')}
                  {' · '}
                  {s.calls > 0 ? capCallsText(locale, s.calls, lower, true) : t('cap.mcp.noCall')}
                </Detail>
                {s.tools.length > 0 && (
                  <ul aria-label={t('cap.mcp.tools', { name: s.name })} className="list-none pl-3 m-0">
                    {s.tools.map(tool => (
                      <li key={tool.name} className={itemClass}><Name>{tool.name}</Name><Detail>{capCallsText(locale, tool.calls, lower)}</Detail></li>
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
  const { locale } = useLocale()
  const t = (key: Parameters<typeof tr>[1], params?: Parameters<typeof tr>[2]) => tr(locale, key, params)
  return (
    <section aria-labelledby={TITLE_ID} className="mb-2">
      <h3 id={TITLE_ID} className="m-0 text-2xs font-mono font-semibold tracking-wider" style={{ color: COLORS.panelLabel }}>{t('cap.heading')}</h3>
      <Note>{t('cap.intro')}</Note>
      {capabilities === undefined ? <Note>{t('cap.notProvided')}</Note>
        : capabilities === 'invalid' ? <Note color={COLORS.error}>{t('cap.invalid')}</Note>
        : capabilities.status === 'unreadable' ? <Note color={COLORS.error}>{t('cap.unreadable')}</Note>
        : <Body caps={capabilities} locale={locale} />}
    </section>
  )
}
