# Claude Code guard (optional, opt-in)

A small [Claude Code](https://claude.com/claude-code) `PreToolUse` hook that **stops the agent
from hand-editing a generated skill**. It complements the git pre-commit hook by catching the
mistake earlier — the instant the agent tries to `Edit`/`Write` a file carrying the nbp-skillforge
`GENERATED` banner — and points it at the recipe instead.

This is **vendor-specific** (Claude Code) and entirely optional; nbp-skillforge's output stays
vendor-neutral. Nothing here is part of the core tool.

## Install (in your own project)
1. Copy `forge-guard.mjs` to `.claude/hooks/forge-guard.mjs`.
2. Merge the `hooks` block from `settings.json` into your `.claude/settings.json`.

That's it. Next time the agent tries to edit a generated file, the hook blocks the call and tells
it to edit the recipe + run `forge build`.

## How it works
The hook reads the `PreToolUse` payload on stdin, looks at the target file, and if the file
carries the `GENERATED` banner it exits non-zero to block the edit (the message is fed back to the
agent). Any other file is allowed through untouched. Zero dependencies.
