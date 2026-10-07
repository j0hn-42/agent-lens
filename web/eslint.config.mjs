// Accessibility-only lint config (issue #43). Not a general style config.
import jsxA11y from 'eslint-plugin-jsx-a11y'
import tseslint from 'typescript-eslint'

// Source files carry `eslint-disable react-hooks/...` comments for the Next.js
// lint setup. Register an empty stand-in so those comments do not error here.
const reactHooksStub = { rules: { 'exhaustive-deps': { create: () => ({}) } } }

const AV = 'components/agent-visualizer/'
const allow = (files, rules) => ({
  files: files.map(f => AV + f),
  rules: Object.fromEntries(rules.map(r => ['jsx-a11y/' + r, 'off'])),
})

export default [
  { ignores: ['.next/**', 'node_modules/**', 'public/**', 'tests-a11y/**'] },
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { 'jsx-a11y': jsxA11y, 'react-hooks': reactHooksStub },
    rules: { ...jsxA11y.flatConfigs.strict.rules },
    linterOptions: { reportUnusedDisableDirectives: 'off' },
  },

  // ---- Known violations, allow-listed per file, each tied to the issue that fixes it.
  // Remove the entry when the owning issue lands; never add a blanket disable.
  // #1 graph alternative
  allow(['graph-a11y-list.tsx'], ['no-noninteractive-element-interactions']),
  // #2 canvas keyboard model
  allow(['canvas.tsx'], [
    'no-static-element-interactions',
    'no-noninteractive-element-interactions',
    'no-noninteractive-tabindex',
  ]),
  // #3 timeline panel semantics
  allow(['timeline-panel.tsx'], ['no-interactive-element-to-noninteractive-role']),
  // #8 div onClick rows in the feed
  allow(['message-feed-panel.tsx'], ['no-noninteractive-element-interactions']),
  // #9 dialog / menu roles and focus handling
  allow(
    ['agent-detail-card.tsx', 'shared-ui.tsx', 'shortcuts-dialog.tsx'],
    ['no-noninteractive-element-interactions', 'no-static-element-interactions'],
  ),
  allow(['glass-context-menu.tsx'], ['interactive-supports-focus']),
  // #12 feed agent tabs
  allow(['message-feed-panel.tsx'], ['interactive-supports-focus']),
  // #13 focusable scroll regions (tabIndex on a scrollable container)
  allow(
    [
      'chat-panel.tsx',
      'discovery-detail-popup.tsx',
      'file-attention-panel.tsx',
      'message-feed-panel.tsx',
      'session-transcript-panel.tsx',
      'timeline-panel.tsx',
      'tool-detail-popup.tsx',
    ],
    ['no-noninteractive-tabindex'],
  ),
]
