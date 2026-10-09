// Accessibility-only lint config (issue #43). Not a general style config.
//
// The strict jsx-a11y preset is applied with NO per-file overrides. Known violations are
// tracked one by one in tests-a11y/lint-baseline.json and compared by
// tests-a11y/lint-baseline.ts (`pnpm --dir web run lint:a11y`), which fails on any new
// violation and on any listed violation that has been fixed.
import jsxA11y from 'eslint-plugin-jsx-a11y'
import tseslint from 'typescript-eslint'

// Source files carry `eslint-disable react-hooks/...` comments for the Next.js
// lint setup. Register an empty stand-in so those comments do not error here.
const reactHooksStub = { rules: { 'exhaustive-deps': { create: () => ({}) } } }

export default [
  { ignores: ['.next/**', '.next-e2e/**', 'node_modules/**', 'public/**', 'tests-a11y/**'] },
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { 'jsx-a11y': jsxA11y, 'react-hooks': reactHooksStub },
    rules: {
      ...jsxA11y.flatConfigs.strict.rules,
      // Scrollable named regions must be focusable so keyboard users can scroll them
      // (WCAG 2.1.1, design choice of #13). Only labelled region/group/log roles and
      // <section> are exempt; a tabIndex on any other non-interactive element still fails.
      'jsx-a11y/no-noninteractive-tabindex': ['error', { roles: ['region', 'group', 'log'], tags: ['section'] }],
    },
    // Inline eslint-disable comments must not bypass the baseline.
    linterOptions: { noInlineConfig: true },
  },
]
