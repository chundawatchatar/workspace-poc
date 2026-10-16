#!/bin/sh
# PostToolUse hook: formats the file Claude just wrote or edited with Biome.
# Files outside the repo are left alone. On failure, Biome's output goes to
# stderr with exit code 2, which Claude Code shows to Claude.

file=$(jq -r '.tool_response.filePath // .tool_input.file_path // empty')
case "$file" in
  "$CLAUDE_PROJECT_DIR"/*) ;;
  *) exit 0 ;;
esac

out=$("$CLAUDE_PROJECT_DIR/node_modules/.bin/biome" check --write --linter-enabled=false \
  --files-ignore-unknown=true --no-errors-on-unmatched "$file" 2>&1) || {
  printf 'Biome could not format %s:\n%s\n' "$file" "$out" >&2
  exit 2
}
