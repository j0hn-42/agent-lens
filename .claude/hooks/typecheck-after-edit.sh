#!/usr/bin/env bash
# PostToolUse (Edit|Write): type-check the package that owns the edited .ts/.tsx file.
# Exit 2 sends the compiler output back to Claude; any other outcome stays silent.
set -u
file=$(jq -r '.tool_input.file_path // empty')
case "$file" in
  *.ts|*.tsx) ;;
  *) exit 0 ;;
esac

root="${CLAUDE_PROJECT_DIR:-$(pwd)}"
case "$file" in
  "$root"/extension/*) cmd=(pnpm --filter agent-lens run lint) ;;
  "$root"/web/*)       cmd=(pnpm --dir web exec tsc --noEmit) ;;
  "$root"/scripts/*|"$root"/app/*) cmd=(pnpm run lint:scripts) ;;
  *) exit 0 ;;
esac

cd "$root" || exit 0
out=$("${cmd[@]}" 2>&1) && exit 0
printf 'Type-check failed (%s):\n%s\n' "${cmd[*]}" "$(printf '%s' "$out" | tail -40)" >&2
exit 2
