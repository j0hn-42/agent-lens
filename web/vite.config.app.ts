import { defineConfig } from 'vite'
import { createBuildConfig } from './vite.config.shared'

export default defineConfig(createBuildConfig({
  outDir: '../app/dist/webview',
  entry: 'app-entry.tsx',
  name: 'AgentLensApp',
  define: {
    'process.env.NEXT_PUBLIC_DEMO': '"0"',
    'process.env.NEXT_PUBLIC_RELAY_PORT': '""',
    'process.env.AGENT_LENS_STANDALONE': '"1"',
  },
}))
