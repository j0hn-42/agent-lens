import { createRoot } from 'react-dom/client'
import { AgentVisualizer } from './components/agent-visualizer'
import { pairFromFragment } from './lib/remote-pairing'
import { prepareBoot } from './lib/boot'
import './app/globals.css'

// Standalone CLI entry — no VS Code API, connects to relay via SSE
const rootElement = document.getElementById('root')
if (!rootElement) throw new Error('Root element #root not found')
const root = createRoot(rootElement)
// Remote pairing (#517): a #pair=<token> URL is consumed (fragment dropped first, then POST /pair) before the first
// connection, so the event stream and /status already carry the pairing cookie. Without a fragment nothing happens.
// The language asked for is a chunk of its own (#662): the first render also waits for it.
void Promise.allSettled([
  pairFromFragment({ location: window.location, history: window.history, fetch: (input, init) => window.fetch(input, init) }),
  prepareBoot(),
]).finally(() => root.render(<AgentVisualizer />))
