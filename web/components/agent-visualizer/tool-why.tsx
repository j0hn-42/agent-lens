'use client'

import { COLORS } from '@/lib/colors'
import { WHY_LABELS } from '@/lib/ui-glossary'
import type { ChainStep, ReasoningResult } from '@/lib/tool-reasoning'

/** What the popup shows about one call: the reasoning observed before it and, for a failure, its causal chain. */
export interface ToolWhy {
  reasoning: ReasoningResult
  /** Set only for a failed call */
  chain: ChainStep[] | null
  nameOf: (agentId: string) => string
}

function Text({ label, children }: { label: string; children: string }) {
  return (
    <div
      role="region"
      aria-label={label}
      tabIndex={0}
      className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-words rounded px-2 py-1 text-xs font-mono"
      style={{ background: COLORS.resultBg, border: `1px solid ${COLORS.resultBorder}`, color: COLORS.textPrimary }}
    >
      {children}
    </div>
  )
}

function Note({ children }: { children: string }) {
  return <p className="mt-1 text-2xs font-mono" style={{ color: COLORS.textMuted }}>{children}</p>
}

function Reasoning({ result, label, noneLabel }: { result: ReasoningResult; label: string; noneLabel: string }) {
  if (result.kind === 'unknown') return <Note>{WHY_LABELS.unknown[result.reason]}</Note>
  if (result.kind === 'none') return <Note>{noneLabel}</Note>
  return (
    <>
      {result.thoughts.map((t, i) =>
        t.redacted
          ? <Note key={i}>{WHY_LABELS.redacted}</Note>
          : <Text key={i} label={label}>{t.text}</Text>)}
      {result.incomplete && <Note>{WHY_LABELS.incomplete}</Note>}
    </>
  )
}

function ChainItem({ step, nameOf }: { step: ChainStep; nameOf: (id: string) => string }) {
  switch (step.kind) {
    case 'failure':
      return (
        <li>
          <span className="font-semibold" style={{ color: COLORS.error }}>{WHY_LABELS.failure}</span>
          {step.text ? <Text label={WHY_LABELS.failure}>{step.text}</Text> : <Note>{WHY_LABELS.noErrorText}</Note>}
        </li>
      )
    case 'reasoning':
      return (
        <li>
          <span className="font-semibold">{WHY_LABELS.chainReasoning}</span>
          <Reasoning result={step.result} label={WHY_LABELS.chainReasoning} noneLabel={WHY_LABELS.reasoningNone} />
        </li>
      )
    case 'dispatch':
      return (
        <li>
          <span className="font-semibold">{`${nameOf(step.parentId)} dispatched ${nameOf(step.childId)} with this prompt`}</span>
          <Text label={`Dispatch prompt to ${nameOf(step.childId)}`}>{step.prompt}</Text>
          <Reasoning result={step.reasoning} label={WHY_LABELS.dispatchReasoning} noneLabel={WHY_LABELS.reasoningNone} />
        </li>
      )
    case 'prompt':
      return (
        <li>
          <span className="font-semibold">{`${WHY_LABELS.prompt} (${nameOf(step.agentId)})`}</span>
          <Text label={WHY_LABELS.prompt}>{step.text}</Text>
        </li>
      )
    case 'prompt-unknown':
      return <li><Note>{WHY_LABELS.promptUnknown[step.reason]}</Note></li>
    case 'break':
      return <li><Note>{WHY_LABELS.stop[step.reason]}</Note></li>
  }
}

export function ToolWhySection({ why }: { why: ToolWhy }) {
  return (
    <div className="mt-2 text-2xs font-mono" style={{ color: COLORS.textPrimary }}>
      <details>
        <summary className="cursor-pointer" style={{ color: COLORS.textMuted }}>{WHY_LABELS.title}</summary>
        <Reasoning result={why.reasoning} label={WHY_LABELS.reasoning} noneLabel={WHY_LABELS.reasoningNone} />
      </details>
      {why.chain && (
        <details className="mt-1">
          <summary className="cursor-pointer" style={{ color: COLORS.error }}>{WHY_LABELS.chain}</summary>
          <ol aria-label={WHY_LABELS.chain} className="mt-1 list-decimal space-y-2 pl-4">
            {why.chain.map((step, i) => <ChainItem key={i} step={step} nameOf={why.nameOf} />)}
          </ol>
        </details>
      )}
    </div>
  )
}
