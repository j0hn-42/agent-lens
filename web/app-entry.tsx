import { createRoot } from 'react-dom/client'
import { AgentVisualizer } from './components/agent-visualizer'
import { pairFromFragment } from './lib/remote-pairing'
import './app/globals.css'

// Standalone CLI entry — no VS Code API, connects to relay via SSE
const rootElement = document.getElementById('root')
if (!rootElement) throw new Error('Root element #root not found')
const root = createRoot(rootElement)
// Remote pairing (#517): a #pair=<token> URL is consumed (fragment dropped first, then POST /pair) before the first
// connection, so the event stream and /status already carry the pairing cookie. Without a fragment nothing happens.
void pairFromFragment({ location: window.location, history: window.history, fetch: (input, init) => window.fetch(input, init) })
  .finally(() => root.render(<AgentVisualizer />))
