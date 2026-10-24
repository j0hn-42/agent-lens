import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'path'
import type { Plugin, UserConfig } from 'vite'

interface BuildTarget {
  outDir: string
  entry: string
  name: string
  define: Record<string, string>
}

/**
 * #662: web/lib/messages/locales/<l>.ts import each domain with `?locale=<l>`, so that a bundler that splits (Next)
 * builds one instance per language and keeps the language not shown out of the first load. This IIFE cannot split
 * (a dynamic import is inlined): both languages are in it anyway, and two instances of each domain module would only
 * duplicate its code. The query is dropped here, so the bundle holds one instance, as before.
 */
function oneCatalogInstance(): Plugin {
  return {
    name: 'agent-lens-one-catalog-instance',
    enforce: 'pre',
    resolveId(source, importer) {
      if (!/\?locale=[a-z]+$/.test(source)) return null
      return this.resolve(source.replace(/\?locale=[a-z]+$/, ''), importer, { skipSelf: true })
    },
  }
}

export function createBuildConfig(target: BuildTarget): UserConfig {
  return {
    plugins: [
      oneCatalogInstance(),
      react(),
      tailwindcss(),
    ],
    resolve: {
      alias: {
        '@': resolve(__dirname),
      },
    },
    publicDir: false,
    build: {
      outDir: resolve(__dirname, target.outDir),
      emptyOutDir: true,
      lib: {
        entry: resolve(__dirname, target.entry),
        formats: ['iife'],
        name: target.name,
        fileName: () => 'index',
      },
      // @ts-expect-error — cssFileName is valid in Vite 8 but not yet in @types
      cssFileName: 'index',
      sourcemap: false,
      minify: true,
      rollupOptions: {
        output: {
          entryFileNames: 'index.js',
          assetFileNames: (info: { names?: string[] }) => {
            if (info.names?.[0]?.endsWith('.css')) return 'index.css'
            return '[name].[ext]'
          },
        },
      },
    },
    define: {
      'process.env.NODE_ENV': '"production"',
      ...target.define,
    },
  }
}
