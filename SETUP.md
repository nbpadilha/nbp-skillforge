# Setup & Pitfalls

## Install
```bash
npm i -D nbp-forge         # zero dependencies
npx nbp-forge build        # generate skills from recipes + bricks
npx nbp-forge check        # drift-gate (CI / pre-commit)
```
(From a clone of this repo the CLI is `node bin/cli.mjs <cmd>`.)

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
  "enforceGenerated": false,
  "conformance": true
}
```
- **`deletePolicy`** — `soft` (move to `_archive/`, recoverable) or `hard` (delete permanently).
  Any other/unknown value is treated as `soft` (fail-closed).
- **`enforceGenerated`** — when `true`, `check` requires every output file to have a recipe,
  forbidding hand-made/edited skills (forge-only guarantee).
- **`conformance`** — when `true` (default), validates each recipe's `name`/`description` against
  the SKILL.md standard; set `false` to disable.

## Pre-commit / CI
Run `npx nbp-forge check` on staged changes (or in CI). It fails if any generated file was
hand-edited, diverges from its recipe, or (with `enforceGenerated`) has no recipe.
