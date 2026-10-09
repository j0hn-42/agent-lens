## What does this PR do?

<!-- Brief description of the change -->

<!-- Tickets : `Closes #n` (ou Fixes / Resolves) ferme le ticket au merge dans develop ; `Refs #n` le laisse ouvert. -->

## How to test

<!-- Steps to verify the change works -->

## Checklist

- [ ] The checks listed in [CONTRIBUTING.md](../CONTRIBUTING.md) pass: `pnpm test`, `pnpm --dir extension test`, `pnpm --filter agent-lens run lint`, `pnpm --filter agent-lens run lint:test`, `pnpm run lint:scripts`, `pnpm --dir web exec tsc --noEmit`, `pnpm --dir web run lint:a11y`, `pnpm run test:a11y`
- [ ] If the change touches rendering, canvas, CSS or a11y: the e2e suite (`pnpm --dir web run test:e2e`) passes
- [ ] No a11y baseline widened (`lint-baseline.json`, `known-violations.json`)
- [ ] New UI is keyboard-operable and has accessible names
