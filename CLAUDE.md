# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

## Claude Code specifics

- A PostToolUse hook (`.claude/hooks/format.sh`) formats each repo file after Write/Edit, so you don't need to format by hand. If Biome can't parse the file, the hook reports the error back to you; fix the syntax.
