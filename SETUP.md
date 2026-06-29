# Setup & Pitfalls

## Install
```bash
npm i -D nbp-forge        # or copy src/ + bin/ — zero dependencies
node bin/cli.mjs build     # generate skills from recipes + bricks
node bin/cli.mjs check     # drift-gate (CI / pre-commit)
```

## ⚠️ Pitfall #1 (the most common) — editing the GENERATED file

Agent frameworks (Claude Code, Codex, Cursor…) and most `CLAUDE.md` / `AGENTS.md` files out
there tell you: **"edit the skill at `.claude/commands/<skill>.md`"** (or `.codex/`, etc.).
With the forge that is **wrong** — that file is **build output**.

- ✅ Edit the **recipe** (`recipes/<skill>.md`) or the **brick** (`bricks/<brick>.md`), then run `build`.
- ❌ Never edit the generated `SKILL.md`/command — `check` blocks it (the edit diverges from the recipe).

Every generated file carries a `<!-- GENERATED … do not edit here -->` banner. If you (or an
agent) are about to edit one and see the banner, **stop and go to the recipe**.

> **Adopting the forge in an existing project:** grep your `CLAUDE.md`/`AGENTS.md` for
> "edit … commands" / "edit … `.md`" and redirect it to the recipe. This step is easy to forget
> and causes friction (the agent tries to edit the generated file and the gate blocks it).

## Config — `forge.config.json`
```json
{
  "bricks": ".claude/forge/bricks",
  "recipes": ".claude/forge/recipes",
  "out": ".claude/commands",
  "archive": ".claude/forge/_archive",
  "deletePolicy": "soft",
  "enforceGenerated": false
}
```
- **`deletePolicy`** — `soft` (move to `_archive/`, recoverable) or `hard` (delete permanently).
- **`enforceGenerated`** — when `true`, `check` requires every output file to have a recipe,
  forbidding hand-made/edited skills (forge-only guarantee).

## Pre-commit / CI
Run `node bin/cli.mjs check` on staged changes (or in CI). It fails if any generated file was
hand-edited, diverges from its recipe, or (with `enforceGenerated`) has no recipe.
