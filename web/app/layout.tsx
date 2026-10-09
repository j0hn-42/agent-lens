import type { Metadata } from 'next'
import './globals.css'
import { themeBootstrapScript } from '../../extension/src/theme-bootstrap'

export const metadata: Metadata = {
  title: 'LLM Agent Visualizer',
  description: 'Real-time visualization of LLM agent execution flows - VS Code extension concept',
  icons: {
    icon: [
      {
        url: '/icon-light-32x32.png',
        media: '(prefers-color-scheme: light)',
      },
      {
        url: '/icon-dark-32x32.png',
        media: '(prefers-color-scheme: dark)',
      },
      {
        url: '/icon.svg',
        type: 'image/svg+xml',
      },
    ],
    apple: '/apple-icon.png',
  },
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en" className="dark" data-theme="graphite" suppressHydrationWarning>
      <head>
        {/* Static, first-party script: sets data-theme, the dark class and color-scheme before first paint */}
        <script dangerouslySetInnerHTML={{ __html: themeBootstrapScript() }} />
      </head>
      <body className="font-sans antialiased">
        {children}
      </body>
    </html>
  )
}
