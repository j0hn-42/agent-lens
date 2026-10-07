// Test helper: plays the part of the shell for the controlled ConversationPanel (open / pill state lives in
// the parent in the app) and provides the Escape registry.
import React, { useState } from 'react'
import { ConversationPanel, type ConversationPanelProps } from '@/components/agent-visualizer/conversation-panel'
import { PanelRegistryContext, createPanelRegistry, type PanelRegistry } from '@/hooks/use-panel-registry'

export type HarnessProps = Omit<ConversationPanelProps, 'open' | 'onOpen' | 'onClose'> & {
  initialOpen?: boolean
  registry: PanelRegistry
  onOpened?: () => void
  onClosed?: () => void
}

export function ConversationHarness({ initialOpen = false, registry, onOpened, onClosed, ...props }: HarnessProps) {
  const [open, setOpen] = useState(initialOpen)
  return (
    <PanelRegistryContext.Provider value={registry.register}>
      <ConversationPanel
        {...props}
        open={open}
        onOpen={() => { setOpen(true); onOpened?.() }}
        onClose={() => { setOpen(false); onClosed?.() }}
      />
    </PanelRegistryContext.Provider>
  )
}

export { createPanelRegistry }
