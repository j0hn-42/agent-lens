#!/usr/bin/env bash
# PreToolUse (Edit|Write): refuse hand edits to generated or lock files.
set -u
file=$(jq -r '.tool_input.file_path // empty')
root="${CLAUDE_PROJECT_DIR:-$(pwd)}"
rel="${file#"$root"/}"

case "$rel" in
  pnpm-lock.yaml)
    hint="run 'pnpm install' (or 'pnpm add <pkg>') instead" ;;
  extension/README.md)
    hint="it is copied from the root README.md by 'vscode:prepublish'; edit README.md" ;;
  scripts/.dev-relay.js|scripts/.dev-relay.js.map)
    hint="it is built by 'node scripts/build-relay.js'; edit scripts/relay.ts" ;;
  web/app/themes.css)
    hint="regenerate it with 'pnpm run gen:themes' after editing web/lib/theme-tokens.json" ;;
  *) exit 0 ;;
esac

echo "Blocked: $rel is generated or locked — $hint." >&2
exit 2
