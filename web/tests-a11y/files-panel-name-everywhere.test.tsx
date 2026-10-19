// #518, WCAG 3.2.4: the Files & repeats panel has ONE name per language. Every surface that names it (the outline of
// the graph, the text the canvas mark mirrors, the notice of hidden panels) is walked here; one that says another
// name than the locale's fails.
import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, cleanup, act } from '@testing-library/react'
import { GraphA11yList } from '@/components/agent-visualizer/graph-a11y-list'
import { UnderTopbarStack } from '@/components/agent-visualizer/hidden-panels-notice'
import { buildA11yModel } from '@/components/agent-visualizer/canvas/a11y-model'
import { repeatMarks } from '@/lib/repeat-marks'
import { emptyWasteLedger, recordToolStart } from '@/lib/waste'
import { dockStore } from '@/lib/panel-layout'
import { setLocaleChoice } from '@/lib/locale'
import { panelName } from '@/lib/command-palette'
import type { Locale } from '@/lib/messages'
import type { Agent } from '@/lib/agent-types'

const win = window as unknown as { innerWidth: number; innerHeight: number }

afterEach(() => {
  act(() => { for (const id of ['detail', 'system', 'link', 'files', 'conversation', 'timeline'] as const) dockStore.setOpen(id, false) })
  cleanup(); document.body.replaceChildren(); setLocaleChoice('auto'); window.localStorage.clear()
  win.innerWidth = 1280; win.innerHeight = 800
  act(() => dockStore.measure())
})

const agent = (id: string, name: string) => ({ id, name, state: 'idle', isMain: false, parentId: null, contextBreakdown: {} }) as unknown as Agent
/** Any way of writing the panel's name, in either language, with or without its second half */
const NAME_FORMS = /Files\s*(?:&|and)\s*repeats|Files(?!\s+that)|Fichiers\s+et\s+répétitions|Fichiers/g

for (const locale of ['en', 'fr'] as Locale[]) {
  test(`${locale}: every mention of the Files & repeats panel (outline, canvas mark text, hidden panels) says the one name`, () => {
    setLocaleChoice(locale)
    const name = panelName(locale, 'files')
    let waste = emptyWasteLedger()
    for (const ext of ['ts', 'md']) {
      for (let i = 0; i < 2; i++) {
        waste = recordToolStart(waste, { sessionId: 's1', agentId: 's1:a', toolName: 'Glob', inputData: { pattern: `**/*.${ext}` }, toolUseId: `${ext}${i}`, toolCallId: `${ext}${i}`, time: i })
      }
    }
    const agents = new Map([['s1:a', agent('s1:a', 'alpha')]])
    const model = buildA11yModel(agents, new Map(), [], new Map(), { repeatMarks: repeatMarks(new Map(), waste, agents.keys()), locale })
    model.fileConflicts = [{ path: '/repo/a.ts', agentIds: ['s1:a'], text: '/repo/a.ts edited by alpha' }]
    const outline = render(<GraphA11yList model={model} communications={[]} announcements={[]} focusedNode={null} onAgentClick={() => {}} onFocusNode={() => {}} />)
    const stack = render(<UnderTopbarStack />)
    win.innerWidth = 390; win.innerHeight = 844
    act(() => { dockStore.measure(); dockStore.setOpen('files', true); dockStore.setOpen('timeline', true) })
    const surfaces = [outline.container.textContent ?? '', stack.container.textContent ?? '']
    const mentions = surfaces.flatMap(s => s.match(NAME_FORMS) ?? [])
    assert.ok(mentions.length >= 3, `the conflicts paragraph, the mark text and the notice each name the panel (found ${mentions.length})`)
    for (const m of mentions) assert.equal(m, name, `${locale}: "${m}" is not the name of the panel`)
  })
}
